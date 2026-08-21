import { parseArgs } from "node:util";
import { checkClearance, type ClearanceCheckResult } from "@voxelspy/analysis";
import { IDENTITY_MAT4, rigidTransformSchema } from "@voxelspy/contracts";
import { CliUsageError } from "../cli-error.js";
import {
  EXIT_INDETERMINATE,
  EXIT_OK,
  EXIT_POLICY_FAILED,
  type ExitCode,
} from "../exit-codes.js";
import { buildExecutionBudget } from "../execution-budget.js";
import type { CommandIO } from "../io.js";
import {
  importFailureExitCode,
  printImportFailure,
} from "../import-outcome.js";
import { loadModel } from "../load-model.js";
import {
  parseAxisOption,
  parseOptionalPositiveInteger,
  parseRequiredMillimetres,
  parseUnitOption,
} from "../parsing.js";
import { evaluatePolicy, type PolicyCheck } from "../policy.js";
import { buildMarkdownSummary, writeMarkdownFile } from "../markdown-report.js";
import { buildSarifLog, writeSarifFile, type SarifFinding } from "../sarif.js";
import { printSampleSpacing, printWarnings } from "../uncertainty-text.js";

export const CLEARANCE_HELP = `Usage: voxelspy clearance <first> <second> --clearance <mm> [options]

Checks fit between two independently placed parts: collision regions, the
sampled minimum surface-to-surface distance, regions below the desired
clearance, and EXACT intersecting-triangle-pair interference evidence.
Both parts are placed at identity in the shared comparison frame -- this
command does not yet expose a placement/alignment option, so the two files
must already share one coordinate system.

Source-frame options:
  --first-unit <unit>        micrometre|millimetre|centimetre|metre|inch|foot
  --first-axis <axis>        right-handed-z-up|right-handed-y-up
  --second-unit <unit>
  --second-axis <axis>

Method options:
  --clearance <mm>           required desired minimum clearance
  --max-tight-regions <n>    cap ranked tight regions returned (<= 2048)
  --max-interfering-pairs <n> cap reported interfering triangle pairs (<= 2048)

Resource options:
  --max-work-units <n>
  --max-memory-bytes <n>
  --max-input-bytes <n>
  --max-triangles <n>

Policy (unlike compare/inspect, clearance always gates on fit -- that is this
command's entire purpose, not an opt-in extra):
  by default, a completed check exits 0 only when state is "clear"; "tight"
  or "interfering" exit 1.
  --allow-tight                only "interfering" exits 1; "tight" now passes
  --fail-on-indeterminate      treat an indeterminate outcome as a policy failure
                                (default: indeterminate exits 2, not 0 or 1)

Output:
  --json                      emit the full ClearanceCheckResult as JSON
  --sarif <path>              write a SARIF 2.1.0 log for code-scanning ingestion
  --markdown <path>           write a compact Markdown summary (for a PR comment)
  --help                      show this message

--sarif and --markdown only change what is written to those files; they never
change the process exit code (see "Exit codes" in the README).
`;

export async function clearanceCommand(
  argv: readonly string[],
  io: CommandIO,
): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      "first-unit": { type: "string" },
      "first-axis": { type: "string" },
      "second-unit": { type: "string" },
      "second-axis": { type: "string" },
      clearance: { type: "string" },
      "max-tight-regions": { type: "string" },
      "max-interfering-pairs": { type: "string" },
      "max-work-units": { type: "string" },
      "max-memory-bytes": { type: "string" },
      "max-input-bytes": { type: "string" },
      "max-triangles": { type: "string" },
      "allow-tight": { type: "boolean", default: false },
      "fail-on-indeterminate": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      sarif: { type: "string" },
      markdown: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    io.stdout(CLEARANCE_HELP);
    return EXIT_OK;
  }

  const [firstPath, secondPath] = positionals;
  if (firstPath === undefined || secondPath === undefined) {
    throw new CliUsageError(
      "clearance requires two positional arguments: <first> <second>.",
    );
  }

  const desiredClearance = parseRequiredMillimetres(
    "--clearance",
    values.clearance,
  );
  const maxTightRegions = parseOptionalPositiveInteger(
    "--max-tight-regions",
    values["max-tight-regions"],
  );
  const maxInterferingTrianglePairs = parseOptionalPositiveInteger(
    "--max-interfering-pairs",
    values["max-interfering-pairs"],
  );
  const maxWorkUnits = parseOptionalPositiveInteger(
    "--max-work-units",
    values["max-work-units"],
  );
  const maxMemoryBytes = parseOptionalPositiveInteger(
    "--max-memory-bytes",
    values["max-memory-bytes"],
  );
  const maxInputBytes = parseOptionalPositiveInteger(
    "--max-input-bytes",
    values["max-input-bytes"],
  );
  const maxTriangles = parseOptionalPositiveInteger(
    "--max-triangles",
    values["max-triangles"],
  );
  const allowTight = values["allow-tight"] === true;
  const failOnIndeterminate = values["fail-on-indeterminate"] === true;
  const sarifPath = values.sarif;
  const markdownPath = values.markdown;

  const firstUnit = parseUnitOption("--first-unit", values["first-unit"]);
  const firstAxis = parseAxisOption("--first-axis", values["first-axis"]);
  const secondUnit = parseUnitOption("--second-unit", values["second-unit"]);
  const secondAxis = parseAxisOption("--second-axis", values["second-axis"]);

  const firstImport = await loadModel(
    firstPath,
    "model.clearance.first",
    { unit: firstUnit, axis: firstAxis, maxInputBytes, maxTriangles },
    "First",
  );
  if (!firstImport.ok) {
    printImportFailure(firstImport, "First", io.stderr);
    return importFailureExitCode(firstImport.result.code);
  }
  const secondImport = await loadModel(
    secondPath,
    "model.clearance.second",
    { unit: secondUnit, axis: secondAxis, maxInputBytes, maxTriangles },
    "Second",
  );
  if (!secondImport.ok) {
    printImportFailure(secondImport, "Second", io.stderr);
    return importFailureExitCode(secondImport.result.code);
  }

  const identity = rigidTransformSchema.parse(IDENTITY_MAT4);
  const executionBudget = buildExecutionBudget(maxWorkUnits, maxMemoryBytes);

  let result: ClearanceCheckResult;
  try {
    result = checkClearance(
      {
        first: { model: firstImport.result.model, modelToComparison: identity },
        second: {
          model: secondImport.result.model,
          modelToComparison: identity,
        },
        desiredClearanceMillimetres: desiredClearance,
      },
      {
        ...(maxTightRegions === undefined ? {} : { maxTightRegions }),
        ...(maxInterferingTrianglePairs === undefined
          ? {}
          : { maxInterferingTrianglePairs }),
        ...(executionBudget === undefined ? {} : { executionBudget }),
      },
    );
  } catch (error) {
    if (error instanceof RangeError) throw new CliUsageError(error.message);
    throw new CliUsageError(
      `The clearance request was invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (values.json) {
    io.stdout(
      JSON.stringify(
        {
          command: "clearance",
          first: { path: firstPath, sourceName: firstImport.sourceName },
          second: { path: secondPath, sourceName: secondImport.sourceName },
          result,
        },
        null,
        2,
      ),
    );
  }

  if (result.state === "indeterminate") {
    if (!values.json) {
      io.stdout(`Clearance check INDETERMINATE: ${result.code}`);
      for (const reason of result.reasons) io.stdout(`  ${reason}`);
    }
    if (sarifPath !== undefined || markdownPath !== undefined) {
      const artifactUris = [firstImport.sourceName, secondImport.sourceName];
      const finding: SarifFinding = {
        ruleId: "indeterminate-analysis",
        message: `Clearance check indeterminate (${result.code}): ${result.reasons.join("; ")}`,
        artifactUris,
        properties: { code: result.code, reasons: result.reasons },
      };
      if (sarifPath !== undefined) {
        writeSarifFile(
          sarifPath,
          buildSarifLog({
            command: "clearance",
            artifacts: artifactUris.map((uri) => ({ uri })),
            findings: [finding],
            runProperties: { state: "indeterminate" },
          }),
        );
      }
      if (markdownPath !== undefined) {
        writeMarkdownFile(
          markdownPath,
          buildMarkdownSummary({
            command: "clearance",
            verdict: "indeterminate",
            headline: `Checked clearance between \`${firstImport.sourceName}\` and \`${secondImport.sourceName}\` -- the engine could not produce a decidable result.`,
            metrics: [{ label: "Outcome code", value: result.code }],
            policyChecks: [],
            caveats: [
              "The clearance check was indeterminate: nothing about the geometry was proven true or false. This is fail-closed, not a pass.",
              ...result.reasons,
            ],
            warnings: [],
          }),
        );
      }
    }
    return failOnIndeterminate ? EXIT_POLICY_FAILED : EXIT_INDETERMINATE;
  }

  const checks: PolicyCheck[] = [
    {
      id: "clearance-state",
      description: allowTight
        ? 'state is not "interfering"'
        : 'state is "clear" (not "tight" or "interfering")',
      passed: allowTight
        ? result.state !== "interfering"
        : result.state === "clear",
      detail: `state=${result.state}, minimum distance=${result.minimumDistanceMillimetres} mm, desired=${result.desiredClearanceMillimetres} mm, interfering triangle pairs=${result.interference.detectedPairCount}`,
    },
  ];
  const evaluation = evaluatePolicy(checks);

  if (sarifPath !== undefined || markdownPath !== undefined) {
    const artifactUris = [firstImport.sourceName, secondImport.sourceName];
    const findings: SarifFinding[] = [];
    const [clearanceCheck] = checks;
    if (clearanceCheck !== undefined && !clearanceCheck.passed) {
      findings.push({
        ruleId: "clearance-violation",
        message: `${clearanceCheck.description} -- ${clearanceCheck.detail}`,
        artifactUris,
        properties: {
          state: result.state,
          minimumDistanceMillimetres: result.minimumDistanceMillimetres,
          desiredClearanceMillimetres: result.desiredClearanceMillimetres,
          interferingTrianglePairs: result.interference.detectedPairCount,
          tightRegionsDetected: result.tightRegions.detectedRegionCount,
        },
      });
    }
    const spacing =
      result.uncertainty.parameters["maxSampleSpacingMillimetres"];
    const undersampled = result.uncertainty.parameters["undersampled"] === true;
    findings.push({
      ruleId: "approximate-result",
      message: `checkClearance's minimum-distance/closest-point/tight-region evidence is sampled, not exact (interference.trianglePairs alone is exact).${
        typeof spacing === "number"
          ? ` Sample spacing bound: ${spacing} mm.`
          : ""
      } A passing policy result is not a stronger claim than that bound supports.`,
      artifactUris,
      properties: { uncertainty: result.uncertainty },
    });
    if (undersampled) {
      findings.push({
        ruleId: "undersampled-region",
        message:
          "The sample spacing bound exceeds the requested --clearance value; a feature confined to a single coarse triangle's interior could have been missed entirely.",
        artifactUris,
        properties: { uncertainty: result.uncertainty },
      });
    }
    if (sarifPath !== undefined) {
      writeSarifFile(
        sarifPath,
        buildSarifLog({
          command: "clearance",
          artifacts: artifactUris.map((uri) => ({ uri })),
          findings,
          runProperties: {
            method: result.method,
            desiredClearanceMillimetres: result.desiredClearanceMillimetres,
            semantics: result.semantics,
            uncertainty: result.uncertainty,
          },
        }),
      );
    }
    if (markdownPath !== undefined) {
      const caveats = [
        "This is an APPROXIMATE result: minimum-distance/closest-point/tight-region evidence is sampled at each part's triangle vertices and centroids, not measured continuously across the surface. Only interference.trianglePairs (exact triangle-triangle intersection) is exact.",
      ];
      if (typeof spacing === "number") {
        caveats.push(
          `Sample spacing bound: ${spacing} mm (the farthest any surface point could be from its nearest sample).`,
        );
      }
      if (undersampled) {
        caveats.push(
          "UNDERSAMPLED: the sample spacing bound exceeds the requested clearance -- a feature confined to a single coarse triangle's interior could have been missed entirely.",
        );
      }
      writeMarkdownFile(
        markdownPath,
        buildMarkdownSummary({
          command: "clearance",
          verdict: evaluation.passed ? "policy passed" : "policy failed",
          headline: `Checked clearance between \`${firstImport.sourceName}\` (first) and \`${secondImport.sourceName}\` (second).`,
          metrics: [
            { label: "State", value: result.state },
            {
              label: "Minimum distance",
              value: `${result.minimumDistanceMillimetres} mm`,
            },
            {
              label: "Desired clearance",
              value: `${result.desiredClearanceMillimetres} mm`,
            },
            {
              label: "Interfering triangle pairs",
              value: `${result.interference.detectedPairCount} (exact, not sampled)`,
            },
            {
              label: "Tight regions",
              value: String(result.tightRegions.detectedRegionCount),
            },
          ],
          policyChecks: checks,
          caveats,
          warnings: result.warnings,
        }),
      );
    }
  }

  if (!values.json) {
    io.stdout(
      `State: ${result.state} (minimum distance ${result.minimumDistanceMillimetres} mm, desired ${result.desiredClearanceMillimetres} mm)`,
    );
    io.stdout(
      `Interference: ${result.interference.detectedPairCount} intersecting triangle pair(s) detected (exact, not sampled).`,
    );
    io.stdout(
      `Tight regions: ${result.tightRegions.detectedRegionCount} detected below desired clearance.`,
    );
    printSampleSpacing(result.uncertainty, io);
    printWarnings(result.warnings, io);
    io.stdout("Policy checks:");
    for (const check of checks) {
      io.stdout(
        `  [${check.passed ? "PASS" : "FAIL"}] ${check.description} -- ${check.detail}`,
      );
    }
    io.stdout(
      evaluation.passed ? "Policy result: PASSED" : "Policy result: FAILED",
    );
  }

  return evaluation.passed ? EXIT_OK : EXIT_POLICY_FAILED;
}
