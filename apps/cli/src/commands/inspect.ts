import { parseArgs } from "node:util";
import { InspectionResourceLimitError, inspectModel, type InspectionResult } from "@voxelspy/analysis";
import { CliUsageError } from "../cli-error.js";
import {
  EXIT_INDETERMINATE,
  EXIT_OK,
  EXIT_POLICY_FAILED,
  type ExitCode,
} from "../exit-codes.js";
import type { CommandIO } from "../io.js";
import { importFailureExitCode, printImportFailure } from "../import-outcome.js";
import { loadModel } from "../load-model.js";
import {
  parseAxisOption,
  parseOptionalNonNegativeInteger,
  parseOptionalPositiveInteger,
  parseUnitOption,
} from "../parsing.js";
import { evaluatePolicy, type PolicyCheck } from "../policy.js";

export const INSPECT_HELP = `Usage: voxelspy inspect <model> [options]

Reports single-model topology findings, a watertightness verdict, a
per-mesh breakdown, and the same bounded geometry summary the browser's
Inspect view uses -- a reporting layer over @voxelspy/analysis, not a
second geometry pipeline.

Source-frame options:
  --unit <unit>              micrometre|millimetre|centimetre|metre|inch|foot
  --axis <axis>               right-handed-z-up|right-handed-y-up

Resource options:
  --max-input-bytes <n>       import byte ceiling
  --max-triangles <n>         import triangle ceiling
  --max-topology-examples <n> bounded example locations per topology finding (0-50)
  --max-mesh-breakdown-entries <n>  bounded per-mesh entries (0-2000)

Policy options (a run with no policy options exits 0 unconditionally):
  --require-watertight         fail unless the model is closed (no boundary
                                or non-manifold edges)
  --fail-on-degenerate          fail if any degenerate triangle is present
  --fail-on-non-manifold        fail if any non-manifold edge is present
  --fail-on-indeterminate       treat a resource-limit refusal as a policy
                                 failure (default: exits 2, not 0 or 1)

Output:
  --json                       emit the InspectionResult as JSON
  --help                       show this message
`;

export async function inspectCommand(
  argv: readonly string[],
  io: CommandIO,
): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      unit: { type: "string" },
      axis: { type: "string" },
      "max-input-bytes": { type: "string" },
      "max-triangles": { type: "string" },
      "max-topology-examples": { type: "string" },
      "max-mesh-breakdown-entries": { type: "string" },
      "require-watertight": { type: "boolean", default: false },
      "fail-on-degenerate": { type: "boolean", default: false },
      "fail-on-non-manifold": { type: "boolean", default: false },
      "fail-on-indeterminate": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    io.stdout(INSPECT_HELP);
    return EXIT_OK;
  }

  const [modelPath] = positionals;
  if (modelPath === undefined) {
    throw new CliUsageError("inspect requires one positional argument: <model>.");
  }

  const unit = parseUnitOption("--unit", values.unit);
  const axis = parseAxisOption("--axis", values.axis);
  const maxInputBytes = parseOptionalPositiveInteger("--max-input-bytes", values["max-input-bytes"]);
  const maxTriangles = parseOptionalPositiveInteger("--max-triangles", values["max-triangles"]);
  const maxTopologyExamples = parseOptionalNonNegativeInteger(
    "--max-topology-examples",
    values["max-topology-examples"],
  );
  const maxMeshBreakdownEntries = parseOptionalNonNegativeInteger(
    "--max-mesh-breakdown-entries",
    values["max-mesh-breakdown-entries"],
  );
  const requireWatertight = values["require-watertight"] === true;
  const failOnDegenerate = values["fail-on-degenerate"] === true;
  const failOnNonManifold = values["fail-on-non-manifold"] === true;
  const failOnIndeterminate = values["fail-on-indeterminate"] === true;

  const imported = await loadModel(
    modelPath,
    "model.inspect",
    { unit, axis, maxInputBytes, maxTriangles },
    "Model",
  );
  if (!imported.ok) {
    printImportFailure(imported, "Model", io.stderr);
    return importFailureExitCode(imported.result.code);
  }

  let inspection: InspectionResult;
  try {
    inspection = inspectModel(imported.result.model, {
      ...(maxTopologyExamples === undefined ? {} : { maxTopologyExamples }),
      ...(maxMeshBreakdownEntries === undefined ? {} : { maxMeshBreakdownEntries }),
    });
  } catch (error) {
    if (error instanceof InspectionResourceLimitError) {
      if (!values.json) {
        io.stdout(`Inspection INDETERMINATE: resource-limit-exceeded`);
        io.stdout(`  ${error.message}`);
      } else {
        io.stdout(
          JSON.stringify(
            {
              command: "inspect",
              model: { path: modelPath, sourceName: imported.sourceName },
              error: { code: "resource-limit-exceeded", message: error.message },
            },
            null,
            2,
          ),
        );
      }
      return failOnIndeterminate ? EXIT_POLICY_FAILED : EXIT_INDETERMINATE;
    }
    if (error instanceof RangeError) {
      throw new CliUsageError(error.message);
    }
    throw error;
  }

  if (values.json) {
    io.stdout(
      JSON.stringify(
        {
          command: "inspect",
          model: { path: modelPath, sourceName: imported.sourceName },
          result: inspection,
        },
        null,
        2,
      ),
    );
  }

  const degenerateFinding = inspection.topologyFindings.find(
    (finding) => finding.kind === "degenerate-triangles",
  );
  const nonManifoldFinding = inspection.topologyFindings.find(
    (finding) => finding.kind === "non-manifold-edges",
  );

  const checks: PolicyCheck[] = [];
  if (requireWatertight) {
    const closed = inspection.watertightness.state === "closed";
    checks.push({
      id: "require-watertight",
      description: "the model is watertight (closed, no boundary or non-manifold edges)",
      passed: closed,
      detail: `watertightness state: ${inspection.watertightness.state}${
        "reasons" in inspection.watertightness
          ? ` (${inspection.watertightness.reasons.join(", ")})`
          : ""
      }`,
    });
  }
  if (failOnDegenerate) {
    checks.push({
      id: "fail-on-degenerate",
      description: "no degenerate triangles are present",
      passed: degenerateFinding === undefined,
      detail: degenerateFinding === undefined ? "none found" : `${degenerateFinding.count} found`,
    });
  }
  if (failOnNonManifold) {
    checks.push({
      id: "fail-on-non-manifold",
      description: "no non-manifold edges are present",
      passed: nonManifoldFinding === undefined,
      detail: nonManifoldFinding === undefined ? "none found" : `${nonManifoldFinding.count} found`,
    });
  }
  const evaluation = evaluatePolicy(checks);

  if (!values.json) {
    io.stdout(
      `Model ${inspection.modelId}: ${inspection.summary.triangleCount} triangles, ${inspection.summary.vertexCount} vertices, ${inspection.meshBreakdown.totalMeshCount} mesh(es).`,
    );
    io.stdout(`Watertightness: ${inspection.watertightness.state}`);
    if (inspection.topologyFindings.length === 0) {
      io.stdout("No topology findings.");
    } else {
      io.stdout("Topology findings:");
      for (const finding of inspection.topologyFindings) {
        io.stdout(`  [${finding.severity}] ${finding.kind}: ${finding.summary}`);
      }
    }
    if (checks.length === 0) {
      io.stdout("No policy options were specified; this run is informational only.");
    } else {
      io.stdout("Policy checks:");
      for (const check of checks) {
        io.stdout(`  [${check.passed ? "PASS" : "FAIL"}] ${check.description} -- ${check.detail}`);
      }
      io.stdout(evaluation.passed ? "Policy result: PASSED" : "Policy result: FAILED");
    }
  }

  return evaluation.passed ? EXIT_OK : EXIT_POLICY_FAILED;
}
