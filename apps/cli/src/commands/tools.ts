import { parseArgs } from "node:util";
import {
  assessPrintability,
  measureOnModel,
  sectionModel,
  MeasurementInputError,
  MeasurementResourceLimitError,
  SectionInputError,
  SectionResourceLimitError,
  PrintabilityInputError,
  PrintabilityResourceLimitError,
  NumericRangeExceededError,
  WorkBudgetExceeded,
  type MeasurementQuery,
  type MeasureOptions,
  type SectionOptions,
  type AssessPrintabilityOptions,
} from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  rigidTransformSchema,
  type Vec3,
} from "@voxelspy/contracts";
import { CliUsageError } from "../cli-error.js";
import {
  EXIT_OK,
  EXIT_INDETERMINATE,
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
  parseUnitOption,
  parseOptionalPositiveInteger,
} from "../parsing.js";
import { parseVector, parseFiniteNumber } from "../placement.js";

type Tool = "measure" | "section" | "printability";
const COMMON_HELP = `
Shared options:
  --unit <unit>                micrometre|millimetre|centimetre|metre|inch|foot
  --axis <axis>                right-handed-z-up|right-handed-y-up
                               explicit source corrections, required for STL/OBJ
  --max-input-bytes <n> --max-triangles <n>   lower importer safety limits
  --max-work-units <n> --max-memory-bytes <n> execution budget
  --json                       deterministic result, request, and import provenance
  --fail-on-indeterminate       resource/numeric refusal exits 1 instead of 2
  --help
All coordinates/dimensions are canonical millimetres, right-handed Z-up;
geometry uses identity placement. No automatic alignment or unit guessing.
Complete evidence exits 0 (informational); invalid input/options exit 3.
`;
export const MEASURE_HELP = `Usage: voxelspy measure <model> --kind <kind> [options]
  --kind bounding-extent                       placed vertex min/max
  --kind point-to-point --first x,y,z --second x,y,z
  --kind point-to-surface --point x,y,z
  --kind snap-point --point x,y,z               closest surface point
  --kind snap-point --ray-origin x,y,z --ray-direction x,y,z
  --snap-tolerance <mm>                         snap classification only (<=1000)
Exact for the supplied tessellated mesh; point-to-point does not verify
surface membership. A missed snap ray is evidence, not a policy failure.
${COMMON_HELP}`;
export const SECTION_HELP = `Usage: voxelspy section <model> --point x,y,z --normal x,y,z [options]
  --max-loops <n>          returned chains (<=2000)
  --max-loop-points <n>    returned points across all chains (<=200000)
Intersects the tessellated mesh with the supplied plane; returns open or
closed polylines, perimeter and closed-loop area. Signed area does not
identify holes/solid. Truncation retains true counts and per-loop metrics.
${COMMON_HELP}`;
export const PRINTABILITY_HELP = `Usage: voxelspy printability <model> [options]
  --thin-threshold <mm>          directional thickness finding threshold (<=100000)
  --max-sample-triangles <n>     thickness probe cap (<=200000)
  --max-findings <n>            returned thickness findings (<=2048)
  --build-direction x,y,z       nonzero overhang build direction (default 0,0,1)
  --overhang-angle <degrees>    threshold from vertical (0..90)
  --max-overhang-regions <n>    returned regions (<=2048)
  --max-components <n>          returned islands (<=2048)
  --build-volume x,y,z          optional positive dimensions in mm
Evidence only: directional thickness probes are approximate, unsampled
triangles have no coverage. Build-volume checks only six axis permutations.
No will-print verdict; complete evidence always exits 0.
${COMMON_HELP}`;
const HELP = {
  measure: MEASURE_HELP,
  section: SECTION_HELP,
  printability: PRINTABILITY_HELP,
};
const SPECIFIC = {
  measure: [
    "kind",
    "first",
    "second",
    "point",
    "ray-origin",
    "ray-direction",
    "snap-tolerance",
  ],
  section: ["point", "normal", "max-loops", "max-loop-points"],
  printability: [
    "thin-threshold",
    "max-sample-triangles",
    "max-findings",
    "build-direction",
    "overhang-angle",
    "max-overhang-regions",
    "max-components",
    "build-volume",
  ],
} as const;

export async function toolCommand(
  command: Tool,
  argv: readonly string[],
  io: CommandIO,
): Promise<ExitCode> {
  const stringOptions = [
    "unit",
    "axis",
    "max-input-bytes",
    "max-triangles",
    "max-work-units",
    "max-memory-bytes",
    ...SPECIFIC[command],
  ];
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      ...Object.fromEntries(
        stringOptions.map((key) => [key, { type: "string" as const }]),
      ),
      json: { type: "boolean" },
      help: { type: "boolean" },
      "fail-on-indeterminate": { type: "boolean" },
    },
  });
  if (values.help) {
    io.stdout(HELP[command]);
    return EXIT_OK;
  }
  if (positionals.length !== 1)
    throw new CliUsageError(`${command} requires exactly one <model>.`);
  const string = (key: string): string | undefined =>
    (values as Record<string, string | boolean | undefined>)[key] as
      string | undefined;
  const integer = (key: string) =>
    parseOptionalPositiveInteger(`--${key}`, string(key));
  const boundedInteger = (key: string, ceiling: number) => {
    const value = integer(key);
    if (value !== undefined && value > ceiling)
      throw new CliUsageError(`--${key} must be <= ${ceiling}.`);
    return value;
  };
  const vector = (key: string) => parseVector(`--${key}`, string(key));
  const direction = (key: string) => {
    const value = vector(key);
    const length = Math.hypot(...value);
    if (!Number.isFinite(length) || length === 0)
      throw new CliUsageError(`--${key} requires a finite nonzero direction.`);
    return value;
  };
  const optionalVector = (key: string) =>
    string(key) === undefined ? undefined : vector(key);
  const number = (key: string, min: number, max: number) => {
    const value =
      string(key) === undefined
        ? undefined
        : parseFiniteNumber(`--${key}`, string(key)!);
    if (value !== undefined && (value < min || value > max))
      throw new CliUsageError(`--${key} must be between ${min} and ${max}.`);
    return value;
  };
  const optional = <K extends string, T>(
    key: K,
    value: T | undefined,
  ): { [P in K]?: T } =>
    value === undefined ? {} : ({ [key]: value } as { [P in K]?: T });
  const modelToComparison = rigidTransformSchema.parse(IDENTITY_MAT4);
  const executionBudget = buildExecutionBudget(
    integer("max-work-units"),
    integer("max-memory-bytes"),
  );
  const engineOptions = {
    modelToComparison,
    ...optional("executionBudget", executionBudget),
  };
  let query: MeasurementQuery | undefined;
  let plane: { point: Vec3; normal: Vec3 } | undefined;
  let options: MeasureOptions & SectionOptions & AssessPrintabilityOptions =
    engineOptions;
  if (command === "measure") {
    const kind = string("kind");
    const allowed =
      kind === "bounding-extent"
        ? ["kind"]
        : kind === "point-to-point"
          ? ["kind", "first", "second"]
          : kind === "point-to-surface"
            ? ["kind", "point"]
            : kind === "snap-point"
              ? [
                  "kind",
                  "point",
                  "ray-origin",
                  "ray-direction",
                  "snap-tolerance",
                ]
              : [];
    if (allowed.length === 0)
      throw new CliUsageError(
        "--kind must be bounding-extent, point-to-point, point-to-surface, or snap-point.",
      );
    for (const key of SPECIFIC.measure)
      if (string(key) !== undefined && !allowed.includes(key))
        throw new CliUsageError(`--${key} is not applicable to ${kind}.`);
    if (kind === "bounding-extent") query = { kind };
    else if (kind === "point-to-point")
      query = { kind, first: vector("first"), second: vector("second") };
    else if (kind === "point-to-surface")
      query = { kind, point: vector("point") };
    else {
      if (
        string("point") !== undefined &&
        (string("ray-origin") !== undefined ||
          string("ray-direction") !== undefined)
      )
        throw new CliUsageError(
          "snap-point accepts either --point or a ray, not both.",
        );
      query = {
        kind: "snap-point",
        at:
          string("point") === undefined
            ? {
                kind: "ray",
                origin: vector("ray-origin"),
                direction: direction("ray-direction"),
              }
            : { kind: "point", point: vector("point") },
      };
      options = {
        ...engineOptions,
        ...optional(
          "snapToleranceMillimetres",
          number("snap-tolerance", 0, 1000),
        ),
      };
    }
  } else if (command === "section") {
    plane = { point: vector("point"), normal: direction("normal") };
    options = {
      ...engineOptions,
      ...optional("maxLoops", boundedInteger("max-loops", 2000)),
      ...optional("maxLoopPoints", boundedInteger("max-loop-points", 200000)),
    };
  } else {
    const dimensions = optionalVector("build-volume");
    if (dimensions?.some((value) => value <= 0))
      throw new CliUsageError("--build-volume dimensions must be positive.");
    options = {
      ...engineOptions,
      wallThickness: {
        ...optional(
          "thinThresholdMillimetres",
          number("thin-threshold", 0, 100000),
        ),
        ...optional(
          "maxSampleTriangles",
          boundedInteger("max-sample-triangles", 200000),
        ),
        ...optional("maxFindings", boundedInteger("max-findings", 2048)),
      },
      overhang: {
        ...optional(
          "buildDirection",
          string("build-direction") === undefined
            ? undefined
            : direction("build-direction"),
        ),
        ...optional(
          "thresholdDegreesFromVertical",
          number("overhang-angle", 0, 90),
        ),
        ...optional("maxRegions", boundedInteger("max-overhang-regions", 2048)),
      },
      islands: {
        ...optional("maxComponents", boundedInteger("max-components", 2048)),
      },
      ...optional(
        "buildVolume",
        dimensions === undefined
          ? undefined
          : { dimensionsMillimetres: dimensions },
      ),
    };
  }
  const path = positionals[0]!;
  const imported = await loadModel(
    path,
    `model.${command}`,
    {
      unit: parseUnitOption("--unit", string("unit")),
      axis: parseAxisOption("--axis", string("axis")),
      maxInputBytes: integer("max-input-bytes"),
      maxTriangles: integer("max-triangles"),
    },
    "Model",
  );
  if (!imported.ok) {
    printImportFailure(imported, "Model", io.stderr);
    return importFailureExitCode(imported.result.code);
  }
  const model = imported.result.model;
  const evidence = {
    outputVersion: 1,
    command,
    model: {
      path,
      sourceName: imported.sourceName,
      provenance: model.provenance,
      warnings: model.warnings,
    },
    request: {
      ...(query === undefined ? {} : { query }),
      ...(plane === undefined ? {} : { plane }),
      options,
    },
  };
  try {
    const result =
      command === "measure"
        ? measureOnModel(model, query!, options)
        : command === "section"
          ? sectionModel(model, plane!, options)
          : assessPrintability(model, options);
    if (values.json)
      io.stdout(JSON.stringify({ ...evidence, result }, null, 2));
    else {
      io.stdout(
        `${command}: informational evidence; canonical millimetres, right-handed Z-up, identity placement.`,
      );
      io.stdout(
        `Source frame and transform: ${JSON.stringify(model.provenance)}`,
      );
      io.stdout(`Request: ${JSON.stringify(evidence.request)}`);
      io.stdout(JSON.stringify(result, null, 2));
    }
    return EXIT_OK;
  } catch (error) {
    const resource =
      error instanceof MeasurementResourceLimitError ||
      error instanceof SectionResourceLimitError ||
      error instanceof PrintabilityResourceLimitError ||
      error instanceof WorkBudgetExceeded ||
      error instanceof NumericRangeExceededError;
    if (resource) {
      const failure = {
        code:
          error instanceof NumericRangeExceededError
            ? "numeric-range-exceeded"
            : "resource-limit",
        message: error.message,
      };
      if (values.json)
        io.stdout(JSON.stringify({ ...evidence, error: failure }, null, 2));
      else io.stderr(`${failure.code}: ${failure.message}`);
      return values["fail-on-indeterminate"]
        ? EXIT_POLICY_FAILED
        : EXIT_INDETERMINATE;
    }
    if (
      error instanceof MeasurementInputError ||
      error instanceof SectionInputError ||
      error instanceof PrintabilityInputError ||
      error instanceof RangeError
    )
      throw new CliUsageError(error.message);
    throw error;
  }
}
export const measureCommand = (argv: readonly string[], io: CommandIO) =>
  toolCommand("measure", argv, io);
export const sectionCommand = (argv: readonly string[], io: CommandIO) =>
  toolCommand("section", argv, io);
export const printabilityCommand = (argv: readonly string[], io: CommandIO) =>
  toolCommand("printability", argv, io);
