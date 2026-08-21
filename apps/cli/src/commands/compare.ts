import { parseArgs } from "node:util";
import {
  IDENTITY_MAT4,
  analysisRequestSchema,
  type AnalysisResult,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { analyzeModelPair, flattenedTriangleLocator } from "@voxelspy/analysis";
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
  parseOptionalMillimetres,
  parseOptionalNonNegativeInteger,
  parseOptionalPositiveInteger,
  parseRequiredMillimetres,
  parseUnitOption,
} from "../parsing.js";
import { evaluatePolicy, type PolicyCheck } from "../policy.js";
import { buildMarkdownSummary, writeMarkdownFile } from "../markdown-report.js";
import {
  buildSarifLog,
  writeSarifFile,
  type SarifFinding,
  type SarifRuleId,
} from "../sarif.js";
import { printSampleSpacing, printWarnings } from "../uncertainty-text.js";
import {
  MAX_DRAWN_REGIONS,
  MAX_DRAWN_TRIANGLES,
  buildComparisonFigureSvg,
  buildFigureUnavailableSvg,
  writeFigureFile,
  type FigureRegionInput,
} from "../figure.js";

export const COMPARE_HELP = `Usage: voxelspy compare <baseline> <candidate> --tolerance <mm> [options]

Compares two revisions of the same part with the sampled surface-distance
method and reports ranked changed regions, honoring the same semantics,
uncertainty, and warnings the browser tool shows for the identical method.

Source-frame options (required unless the file's unit/axis is already
unambiguous -- STL and OBJ never are, so one of each is required in practice):
  --baseline-unit <unit>     micrometre|millimetre|centimetre|metre|inch|foot
  --baseline-axis <axis>     right-handed-z-up|right-handed-y-up
  --candidate-unit <unit>
  --candidate-axis <axis>

Method options:
  --tolerance <mm>           required distance tolerance for surface-distance
  --max-regions <n>          cap ranked regions returned (<= 2048)

Resource options:
  --max-work-units <n>       analysis execution budget ceiling
  --max-memory-bytes <n>     analysis execution budget ceiling
  --max-input-bytes <n>      import byte ceiling, per file
  --max-triangles <n>        import triangle ceiling, per file

Policy options (a completed run with no policy options exits 0 unconditionally):
  --max-deviation <mm>       fail if the true maximum distance exceeds this
  --fail-on-regions <n>      fail if the true changed-region count exceeds n
  --require-watertight       fail unless both baseline and candidate are closed
  --fail-on-indeterminate    treat an indeterminate outcome as a policy failure
                             (default: indeterminate exits 2, not 0 or 1)

Output:
  --json                     emit the full contracts-shaped AnalysisResult
  --sarif <path>             write a SARIF 2.1.0 log for code-scanning ingestion
  --markdown <path>          write a compact Markdown summary (for a PR comment)
  --figure <path>            write a deterministic SVG comparison figure (see README)
  --help                     show this message

--sarif, --markdown, and --figure only change what is written to those files;
they never change the process exit code (see "Exit codes" in the README).
`;

export async function compareCommand(
  argv: readonly string[],
  io: CommandIO,
): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      "baseline-unit": { type: "string" },
      "baseline-axis": { type: "string" },
      "candidate-unit": { type: "string" },
      "candidate-axis": { type: "string" },
      tolerance: { type: "string" },
      "max-regions": { type: "string" },
      "max-work-units": { type: "string" },
      "max-memory-bytes": { type: "string" },
      "max-input-bytes": { type: "string" },
      "max-triangles": { type: "string" },
      "max-deviation": { type: "string" },
      "fail-on-regions": { type: "string" },
      "require-watertight": { type: "boolean", default: false },
      "fail-on-indeterminate": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      sarif: { type: "string" },
      markdown: { type: "string" },
      figure: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    io.stdout(COMPARE_HELP);
    return EXIT_OK;
  }

  const [baselinePath, candidatePath] = positionals;
  if (baselinePath === undefined || candidatePath === undefined) {
    throw new CliUsageError(
      "compare requires two positional arguments: <baseline> <candidate>.",
    );
  }

  const tolerance = parseRequiredMillimetres("--tolerance", values.tolerance);
  const maxRegions = parseOptionalPositiveInteger(
    "--max-regions",
    values["max-regions"],
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
  const maxDeviation = parseOptionalMillimetres(
    "--max-deviation",
    values["max-deviation"],
  );
  const failOnRegions = parseOptionalNonNegativeInteger(
    "--fail-on-regions",
    values["fail-on-regions"],
  );
  const requireWatertight = values["require-watertight"] === true;
  const failOnIndeterminate = values["fail-on-indeterminate"] === true;
  const sarifPath = values.sarif;
  const markdownPath = values.markdown;
  const figurePath = values.figure;

  const baselineUnit = parseUnitOption(
    "--baseline-unit",
    values["baseline-unit"],
  );
  const baselineAxis = parseAxisOption(
    "--baseline-axis",
    values["baseline-axis"],
  );
  const candidateUnit = parseUnitOption(
    "--candidate-unit",
    values["candidate-unit"],
  );
  const candidateAxis = parseAxisOption(
    "--candidate-axis",
    values["candidate-axis"],
  );

  const baselineImport = await loadModel(
    baselinePath,
    "model.baseline",
    { unit: baselineUnit, axis: baselineAxis, maxInputBytes, maxTriangles },
    "Baseline",
  );
  if (!baselineImport.ok) {
    printImportFailure(baselineImport, "Baseline", io.stderr);
    return importFailureExitCode(baselineImport.result.code);
  }
  const candidateImport = await loadModel(
    candidatePath,
    "model.candidate",
    { unit: candidateUnit, axis: candidateAxis, maxInputBytes, maxTriangles },
    "Candidate",
  );
  if (!candidateImport.ok) {
    printImportFailure(candidateImport, "Candidate", io.stderr);
    return importFailureExitCode(candidateImport.result.code);
  }

  const executionBudget = buildExecutionBudget(maxWorkUnits, maxMemoryBytes);
  let result: AnalysisResult;
  try {
    const request = analysisRequestSchema.parse({
      contractVersion: 1,
      requestId: "cli.compare.request",
      baseline: {
        modelId: baselineImport.result.model.id,
        modelToComparison: IDENTITY_MAT4,
      },
      candidate: {
        modelId: candidateImport.result.model.id,
        modelToComparison: IDENTITY_MAT4,
      },
      method: {
        id: "surface-distance",
        version: "1.0.0",
        parameters: maxRegions === undefined ? {} : { maxRegions },
      },
      tolerance: { distanceMillimetres: tolerance },
      ...(executionBudget === undefined ? {} : { executionBudget }),
    });
    result = analyzeModelPair({
      request,
      baseline: baselineImport.result.model,
      candidate: candidateImport.result.model,
    });
  } catch (error) {
    throw new CliUsageError(
      `The comparison request was invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (values.json) {
    io.stdout(
      JSON.stringify(
        {
          command: "compare",
          baseline: {
            path: baselineImport.path,
            sourceName: baselineImport.sourceName,
          },
          candidate: {
            path: candidatePath,
            sourceName: candidateImport.sourceName,
          },
          result,
        },
        null,
        2,
      ),
    );
  }

  if (result.outcome.state === "indeterminate") {
    if (!values.json) {
      io.stdout(`Comparison INDETERMINATE: ${result.outcome.code}`);
      for (const reason of result.outcome.reasons) io.stdout(`  ${reason}`);
    }
    if (sarifPath !== undefined || markdownPath !== undefined) {
      const artifactUris = [
        baselineImport.sourceName,
        candidateImport.sourceName,
      ];
      const finding: SarifFinding = {
        ruleId: "indeterminate-analysis",
        message: `Comparison indeterminate (${result.outcome.code}): ${result.outcome.reasons.join("; ")}`,
        artifactUris,
        properties: {
          code: result.outcome.code,
          reasons: result.outcome.reasons,
        },
      };
      if (sarifPath !== undefined) {
        writeSarifFile(
          sarifPath,
          buildSarifLog({
            command: "compare",
            artifacts: artifactUris.map((uri) => ({ uri })),
            findings: [finding],
            runProperties: {
              state: "indeterminate",
              requestedMethod: result.outcome.requestedMethod,
              requestedTolerance: result.outcome.requestedTolerance,
            },
          }),
        );
      }
      if (markdownPath !== undefined) {
        writeMarkdownFile(
          markdownPath,
          buildMarkdownSummary({
            command: "compare",
            verdict: "indeterminate",
            headline: `Compared \`${baselineImport.sourceName}\` (baseline) against \`${candidateImport.sourceName}\` (candidate) with surface-distance -- the engine could not produce a decidable result.`,
            metrics: [{ label: "Outcome code", value: result.outcome.code }],
            policyChecks: [],
            caveats: [
              "The analysis was indeterminate: nothing about the geometry was proven true or false. This is fail-closed, not a pass.",
              ...result.outcome.reasons,
            ],
            warnings: result.warnings,
            ...(figurePath === undefined ? {} : { figurePath }),
          }),
        );
      }
    }
    if (figurePath !== undefined) {
      writeComparisonFigureFile({
        figurePath,
        baselineModel: baselineImport.result.model,
        candidateModel: candidateImport.result.model,
        executionBudget,
        baselineSourceName: baselineImport.sourceName,
        candidateSourceName: candidateImport.sourceName,
        methodLabel: `${result.outcome.requestedMethod.id} ${result.outcome.requestedMethod.version}`,
        verdict: "indeterminate",
        regions: [],
        orderedRegionIds: [],
        totalDetectedRegionCount: 0,
      });
    }
    return failOnIndeterminate ? EXIT_POLICY_FAILED : EXIT_INDETERMINATE;
  }

  const outcome = result.outcome;
  const maxDistance = numberMetric(outcome.metrics, "surface.maximum-distance");
  const changedRegionCount = numberMetric(
    outcome.metrics,
    "surface.changed-region-count",
  );
  const reportedRegionCount = numberMetric(
    outcome.metrics,
    "surface.reported-region-count",
  );

  const checks: PolicyCheck[] = [];
  if (maxDeviation !== undefined) {
    checks.push({
      id: "max-deviation",
      description: `maximum deviation <= ${maxDeviation} mm`,
      passed: maxDistance <= maxDeviation,
      detail: `observed maximum distance ${maxDistance} mm across ${changedRegionCount} detected region(s)`,
    });
  }
  if (failOnRegions !== undefined) {
    checks.push({
      id: "fail-on-regions",
      description: `changed regions <= ${failOnRegions}`,
      passed: changedRegionCount <= failOnRegions,
      detail: `${changedRegionCount} changed region(s) detected`,
    });
  }
  if (requireWatertight) {
    const [baselineMesh, candidateMesh] = outcome.validation;
    if (baselineMesh === undefined || candidateMesh === undefined) {
      throw new Error(
        "A complete analysis result must carry validation evidence for both models.",
      );
    }
    const closed = baselineMesh.closed && candidateMesh.closed;
    checks.push({
      id: "require-watertight",
      description:
        "both baseline and candidate are watertight (closed, no boundary/non-manifold edges)",
      passed: closed,
      detail: closed
        ? "both inputs are closed"
        : `baseline closed=${baselineMesh.closed}, candidate closed=${candidateMesh.closed}`,
    });
  }
  const evaluation = evaluatePolicy(checks);

  if (sarifPath !== undefined || markdownPath !== undefined) {
    const artifactUris = [
      baselineImport.sourceName,
      candidateImport.sourceName,
    ];
    const findings: SarifFinding[] = [];
    for (const check of checks) {
      if (check.passed) continue;
      const ruleId = COMPARE_CHECK_RULES[check.id];
      if (ruleId === undefined) {
        throw new Error(
          `No SARIF rule is mapped for compare policy check id "${check.id}".`,
        );
      }
      findings.push({
        ruleId,
        message: `${check.description} -- ${check.detail}`,
        artifactUris,
        properties: {
          checkId: check.id,
          maximumDistanceMillimetres: maxDistance,
          changedRegionCount,
          reportedRegionCount,
          regions: topRegions(outcome.regions, outcome.orderedRegionIds),
        },
      });
    }
    const caveats: string[] = [];
    if (outcome.semantics === "approximate") {
      const spacing =
        outcome.uncertainty.parameters["maxSampleSpacingMillimetres"];
      const undersampled =
        outcome.uncertainty.parameters["undersampled"] === true;
      caveats.push(
        `This is an APPROXIMATE result: ${outcome.uncertainty.description}` +
          (typeof spacing === "number"
            ? ` Sample spacing bound: ${spacing} mm (the farthest any surface point could be from its nearest sample).`
            : ""),
      );
      findings.push({
        ruleId: "approximate-result",
        message: `surface-distance is a sampled method.${
          typeof spacing === "number"
            ? ` Sample spacing bound: ${spacing} mm.`
            : ""
        } A passing policy result is not a stronger claim than that bound supports.`,
        artifactUris,
        properties: { uncertainty: outcome.uncertainty },
      });
      if (undersampled) {
        caveats.push(
          "UNDERSAMPLED: the sample spacing bound exceeds the requested tolerance -- a feature confined to a single coarse triangle's interior could have been missed entirely.",
        );
        findings.push({
          ruleId: "undersampled-region",
          message:
            "The sample spacing bound exceeds the requested --tolerance value; a feature confined to a single coarse triangle's interior could have been missed entirely.",
          artifactUris,
          properties: { uncertainty: outcome.uncertainty },
        });
      }
    }
    if (sarifPath !== undefined) {
      writeSarifFile(
        sarifPath,
        buildSarifLog({
          command: "compare",
          artifacts: artifactUris.map((uri) => ({ uri })),
          findings,
          runProperties: {
            method: outcome.effectiveMethod,
            tolerance: outcome.effectiveTolerance,
            semantics: outcome.semantics,
            ...(outcome.semantics === "approximate"
              ? { uncertainty: outcome.uncertainty }
              : {}),
          },
        }),
      );
    }
    if (markdownPath !== undefined) {
      writeMarkdownFile(
        markdownPath,
        buildMarkdownSummary({
          command: "compare",
          verdict:
            checks.length === 0
              ? "informational (no policy configured)"
              : evaluation.passed
                ? "policy passed"
                : "policy failed",
          headline: `Compared \`${baselineImport.sourceName}\` (baseline) against \`${candidateImport.sourceName}\` (candidate) with ${outcome.effectiveMethod.id} ${outcome.effectiveMethod.version}.`,
          metrics: [
            {
              label: "Method",
              value: `${outcome.effectiveMethod.id} ${outcome.effectiveMethod.version}`,
            },
            { label: "Maximum distance", value: `${maxDistance} mm` },
            {
              label: "Changed regions",
              value: `${changedRegionCount} detected, ${reportedRegionCount} reported`,
            },
            {
              label: "Tolerance",
              value: `${outcome.effectiveTolerance.distanceMillimetres} mm`,
            },
          ],
          policyChecks: checks,
          caveats:
            caveats.length > 0
              ? caveats
              : [
                  "This result's semantics are exact-within-validated-preconditions for the requested method.",
                ],
          warnings: result.warnings,
          ...(figurePath === undefined ? {} : { figurePath }),
        }),
      );
    }
  }

  if (figurePath !== undefined) {
    writeComparisonFigureFile({
      figurePath,
      baselineModel: baselineImport.result.model,
      candidateModel: candidateImport.result.model,
      executionBudget,
      baselineSourceName: baselineImport.sourceName,
      candidateSourceName: candidateImport.sourceName,
      methodLabel: `${outcome.effectiveMethod.id} ${outcome.effectiveMethod.version}`,
      verdict:
        checks.length === 0
          ? "informational (no policy configured)"
          : evaluation.passed
            ? "policy passed"
            : "policy failed",
      regions: outcome.regions,
      orderedRegionIds: outcome.orderedRegionIds,
      totalDetectedRegionCount: changedRegionCount,
    });
  }

  if (!values.json) {
    io.stdout(
      `Method: ${outcome.effectiveMethod.id} ${outcome.effectiveMethod.version} (semantics: ${outcome.semantics})`,
    );
    io.stdout(
      `Detected ${changedRegionCount} changed region(s), ${reportedRegionCount} reported; maximum distance ${maxDistance} mm.`,
    );
    if (outcome.semantics === "approximate") {
      printSampleSpacing(outcome.uncertainty, io);
    }
    printWarnings(result.warnings, io);
    if (checks.length === 0) {
      io.stdout(
        "No policy options were specified; this run is informational only.",
      );
    } else {
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
  }

  return evaluation.passed ? EXIT_OK : EXIT_POLICY_FAILED;
}

function numberMetric(
  metrics: readonly { readonly id: string; readonly value: number }[],
  id: string,
): number {
  const metric = metrics.find((entry) => entry.id === id);
  if (metric === undefined) {
    throw new Error(
      `Expected metric "${id}" was not present in the analysis result.`,
    );
  }
  return metric.value;
}

/** Maps each `compare`-specific `PolicyCheck.id` to the SARIF rule it becomes when that check fails. Kept exhaustive by `checks.push({ id: ... })` above only ever using these three ids. */
const COMPARE_CHECK_RULES: Record<string, SarifRuleId> = {
  "max-deviation": "deviation-exceeds-threshold",
  "fail-on-regions": "region-count-exceeds-threshold",
  "require-watertight": "not-watertight",
};

/**
 * Up to 5 changed regions, in `orderedRegionIds` rank order, summarized for
 * a SARIF finding's `properties` -- region/triangle evidence, since a
 * geometry finding has no source line to point at. Bounded independently of
 * `--max-regions`: this is about keeping one SARIF result's payload small,
 * not about the analysis result's own truncation.
 */
function topRegions(
  regions: readonly {
    readonly id: string;
    readonly category: string;
    readonly anchor: readonly number[];
    readonly bounds: {
      readonly min: readonly number[];
      readonly max: readonly number[];
    };
  }[],
  orderedRegionIds: readonly string[],
): readonly {
  readonly id: string;
  readonly category: string;
  readonly anchorMillimetres: readonly number[];
}[] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  return orderedRegionIds
    .slice(0, 5)
    .map((id) => byId.get(id))
    .filter(
      (region): region is NonNullable<typeof region> => region !== undefined,
    )
    .map((region) => ({
      id: region.id,
      category: region.category,
      anchorMillimetres: region.anchor,
    }));
}

/**
 * The minimal shape `writeComparisonFigureFile` needs from one changed
 * region -- structurally satisfied by `AnalysisOutcome["regions"][number]`
 * (a `ChangeRegion`) without importing that type directly, so this module
 * stays decoupled from exactly which `@voxelspy/contracts` region shape is
 * in play.
 */
interface FigureableRegion {
  readonly id: string;
  readonly category: "added" | "removed" | "deviation";
  readonly bounds: {
    readonly min: readonly number[];
    readonly max: readonly number[];
  };
  readonly anchor: readonly number[];
  readonly geometry?:
    | {
        readonly kind: "triangle-set";
        readonly model: "baseline" | "candidate";
        readonly triangleIndices: readonly number[];
      }
    | undefined;
}

function boundingBoxOf(geometry: {
  readonly positions: Float64Array;
  readonly vertexCount: number;
}): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  if (geometry.vertexCount === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < geometry.vertexCount; vertex += 1) {
    const base = vertex * 3;
    const x = geometry.positions[base]!;
    const y = geometry.positions[base + 1]!;
    const z = geometry.positions[base + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Builds and writes the `--figure` SVG for one `compare` run (complete or
 * indeterminate). Never throws: `flattenedTriangleLocator` or triangle
 * resolution failing (e.g. its own resource-limit ceiling, distinct from
 * `analyzeModelPair`'s) falls back to `buildFigureUnavailableSvg` so an
 * already-successful comparison's exit code and other outputs are never put
 * at risk by the figure step -- see "Emitting a figure must not change exit
 * behavior" in the README.
 */
function writeComparisonFigureFile(params: {
  readonly figurePath: string;
  readonly baselineModel: NormalizedModel;
  readonly candidateModel: NormalizedModel;
  readonly executionBudget:
    | { readonly maxWorkUnits: number; readonly maxMemoryBytes: number }
    | undefined;
  readonly baselineSourceName: string;
  readonly candidateSourceName: string;
  readonly methodLabel: string;
  readonly verdict: string;
  readonly regions: readonly FigureableRegion[];
  readonly orderedRegionIds: readonly string[];
  readonly totalDetectedRegionCount: number;
}): void {
  const headline = `Compared \`${params.baselineSourceName}\` (baseline) against \`${params.candidateSourceName}\` (candidate) with ${params.methodLabel}.`;
  try {
    const budgetOption =
      params.executionBudget === undefined
        ? {}
        : { executionBudget: params.executionBudget };
    const baselineLocator = flattenedTriangleLocator(
      params.baselineModel,
      budgetOption,
    );
    const candidateLocator = flattenedTriangleLocator(
      params.candidateModel,
      budgetOption,
    );

    const regionById = new Map(
      params.regions.map((region) => [region.id, region]),
    );
    const orderedRegions = params.orderedRegionIds
      .map((id) => regionById.get(id))
      .filter((region): region is FigureableRegion => region !== undefined)
      .slice(0, MAX_DRAWN_REGIONS);

    let trianglesRemaining = MAX_DRAWN_TRIANGLES;
    const figureRegions: FigureRegionInput[] = orderedRegions.map((region) => {
      let triangles: FigureRegionInput["triangles"];
      if (region.geometry !== undefined && trianglesRemaining > 0) {
        const locator =
          region.geometry.model === "baseline"
            ? baselineLocator
            : candidateLocator;
        const indices = region.geometry.triangleIndices.slice(
          0,
          trianglesRemaining,
        );
        const resolved = indices.map(
          (index) => locator.resolve(index).positionsMillimetres,
        );
        trianglesRemaining -= resolved.length;
        triangles = resolved;
      }
      return {
        id: region.id,
        category: region.category,
        boundsMinMm: [
          region.bounds.min[0]!,
          region.bounds.min[1]!,
          region.bounds.min[2]!,
        ],
        boundsMaxMm: [
          region.bounds.max[0]!,
          region.bounds.max[1]!,
          region.bounds.max[2]!,
        ],
        anchorMm: [region.anchor[0]!, region.anchor[1]!, region.anchor[2]!],
        ...(triangles === undefined ? {} : { triangles }),
      };
    });

    const svg = buildComparisonFigureSvg({
      headline,
      verdict: params.verdict,
      baselineLabel: params.baselineSourceName,
      candidateLabel: params.candidateSourceName,
      baselineBoundsMm: boundingBoxOf(baselineLocator.geometry),
      candidateBoundsMm: boundingBoxOf(candidateLocator.geometry),
      regions: figureRegions,
      totalDetectedRegionCount: params.totalDetectedRegionCount,
    });
    writeFigureFile(params.figurePath, svg);
  } catch (error) {
    writeFigureFile(
      params.figurePath,
      buildFigureUnavailableSvg({
        headline,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
