import {
  DEFAULT_MAX_TOPOLOGY_EXAMPLES,
  DEFAULT_MAX_MESH_BREAKDOWN_ENTRIES,
  DEFAULT_MAX_BOUNDARY_LOOPS,
  DEFAULT_MAX_BOUNDARY_LOOP_POINTS,
  DEFAULT_MAX_ISSUE_ITEMS,
  DEFAULT_MAX_SECTION_LOOPS,
  DEFAULT_MAX_SECTION_LOOP_POINTS,
  DEFAULT_MAX_WALL_THICKNESS_SAMPLE_TRIANGLES,
  DEFAULT_MAX_WALL_THICKNESS_FINDINGS,
  DEFAULT_MAX_OVERHANG_REGIONS,
  DEFAULT_MAX_ISLAND_COMPONENTS,
} from "@voxelspy/analysis";
import { IMPORTER_SAFETY_LIMITS } from "@voxelspy/importers";
import {
  geometryProvenanceSchema,
  warningSchema,
  type GeometryProvenance,
} from "@voxelspy/contracts";

export type EvidenceReportKind =
  "inspection" | "printability" | "measure-section" | "file-forensics";

export interface EvidenceReportInput {
  readonly kind: EvidenceReportKind;
  readonly source: { readonly name: string; readonly sizeBytes: number };
  readonly provenance: GeometryProvenance;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** App-local version 1 evidence artifact. It is not a portable model session. */
export interface EvidenceReport extends EvidenceReportInput {
  readonly schemaVersion: 1;
  readonly limitations: readonly string[];
  readonly limits: {
    readonly importer: typeof IMPORTER_SAFETY_LIMITS;
    readonly evidence: Readonly<Record<string, number>>;
    readonly reportBytes: number;
  };
}

const limitations: Record<EvidenceReportKind, readonly string[]> = {
  inspection: [
    "Measurements and topology describe the imported tessellated mesh, not its original CAD surface. No repair or self-intersection test is performed.",
    "A closed and consistently oriented mesh supports a volume observation, not a guarantee that the model is physically valid. Preserve withheld values, warnings, and truncation flags when interpreting this evidence.",
    "Optional mesh diagnosis is included only when successfully computed; its reported status distinguishes omitted, pending, failed, and completed diagnosis.",
  ],
  printability: [
    "This is evidence for a human to weigh against a slicer, material, and printer, never a printability verdict.",
    "Wall thickness is sampled and directional; unsampled triangles and missed probes remain unknown. Build-volume fit searches axis permutations only. Exact checks describe the tessellated mesh.",
    "The assessment retains its own resolved parameters, disclaimer, sampling bounds, warnings, and truncation counts. An unbounded sample-spacing value is encoded as {nonFiniteNumber: positive-infinity}, never as null or zero. Unapplied edits to the controls are not assessment results.",
  ],
  "measure-section": [
    "Distances and sections describe the imported tessellated mesh, not a reconstruction of its original CAD geometry.",
    "Only kept measurements, active points, the current computed distance, dimensions, and the latest section result are included. Idle and error states are explicit; uncomputed control edits are not results.",
    "Section loops may be open, terminated, or truncated. Retain all warnings, bounds, and withheld-area reasons when interpreting them.",
  ],
  "file-forensics": [
    "This reports what the supported importer read, not an exhaustive validation of the source format or every unsupported feature.",
    "Mesh and instance structure, source interpretation, importer ceilings, warnings, and provenance are evidence; they do not establish manufacturing suitability.",
  ],
};
const evidenceLimits: Record<
  EvidenceReportKind,
  Readonly<Record<string, number>>
> = {
  inspection: {
    maxTopologyExamples: DEFAULT_MAX_TOPOLOGY_EXAMPLES,
    maxMeshBreakdownEntries: DEFAULT_MAX_MESH_BREAKDOWN_ENTRIES,
    maxBoundaryLoops: DEFAULT_MAX_BOUNDARY_LOOPS,
    maxBoundaryLoopPoints: DEFAULT_MAX_BOUNDARY_LOOP_POINTS,
    maxIssueItems: DEFAULT_MAX_ISSUE_ITEMS,
  },
  printability: {
    maxSampleTriangles: DEFAULT_MAX_WALL_THICKNESS_SAMPLE_TRIANGLES,
    maxThicknessFindings: DEFAULT_MAX_WALL_THICKNESS_FINDINGS,
    maxOverhangRegions: DEFAULT_MAX_OVERHANG_REGIONS,
    maxIslandComponents: DEFAULT_MAX_ISLAND_COMPONENTS,
  },
  "measure-section": {
    maxSectionLoops: DEFAULT_MAX_SECTION_LOOPS,
    maxSectionLoopPoints: DEFAULT_MAX_SECTION_LOOP_POINTS,
  },
  "file-forensics": {},
};
const requiredEvidence: Record<EvidenceReportKind, readonly string[]> = {
  inspection: ["inspection", "warnings", "diagnosis"],
  printability: ["assessment", "warnings"],
  "measure-section": [
    "warnings",
    "dimensions",
    "activePoints",
    "measurements",
    "currentMeasurement",
    "section",
  ],
  "file-forensics": [
    "warnings",
    "placementKind",
    "meshes",
    "instances",
    "importLimits",
  ],
};
const forbiddenKeys = new Set([
  "model",
  "positions",
  "indices",
  "bytes",
  "buffer",
  "buffers",
]);
export const MAX_EVIDENCE_REPORT_BYTES = 8 * 1024 * 1024;

/** Validate finite plain JSON and order keys without rounding evidence numbers.
 * Undefined optional object properties follow JSON's ordinary omission rule;
 * arrays, class instances, typed arrays, cycles, and runaway nesting fail closed. */
function canonicalJson(
  value: unknown,
  depth = 0,
  count = { value: 0 },
  allowUnboundedSpacing = false,
): unknown {
  if (++count.value > 1_000_000 || depth > 64)
    throw new Error("Evidence report exceeds its structural limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return value.map((item) =>
      canonicalJson(item, depth + 1, count, allowUnboundedSpacing),
    );
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(
      "Evidence report must contain finite plain JSON values, without model buffers.",
    );
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (forbiddenKeys.has(key))
      throw new Error(
        "Original model geometry is not allowed in an evidence report.",
      );
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined)
      Object.defineProperty(result, key, {
        value:
          allowUnboundedSpacing &&
          key === "sampleSpacingUpperBoundMillimetres" &&
          item === Infinity
            ? { nonFiniteNumber: "positive-infinity" }
            : canonicalJson(item, depth + 1, count, allowUnboundedSpacing),
        enumerable: true,
      });
  }
  return result;
}

function objectWith(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Evidence report result is incomplete.");
  return value as Record<string, unknown>;
}
function validateState(
  value: unknown,
  resultKeys: readonly string[],
  resultField = "result",
): void {
  const state = objectWith(value, ["status"]);
  if (!["idle", "ready", "error"].includes(String(state.status)))
    throw new Error("Evidence report contains unfinished work.");
  if (state.status === "ready") objectWith(state[resultField], resultKeys);
  if (state.status === "error" && typeof state.message !== "string")
    throw new Error("Evidence report failure is missing its explanation.");
}
function validateEvidence(input: EvidenceReportInput): void {
  const evidence = input.evidence;
  if (
    !Array.isArray(evidence.warnings) ||
    evidence.warnings.some(
      (warning) => !warningSchema.safeParse(warning).success,
    )
  )
    throw new Error("Evidence report import warnings are invalid.");
  if (input.kind === "inspection") {
    const inspection = objectWith(evidence.inspection, [
      "modelId",
      "frame",
      "provenance",
      "summary",
      "topologyFindings",
      "watertightness",
      "meshBreakdown",
    ]);
    if (
      !geometryProvenanceSchema.safeParse(inspection.provenance).success ||
      JSON.stringify(inspection.provenance) !== JSON.stringify(input.provenance)
    )
      throw new Error(
        "Inspection provenance does not match the report source.",
      );
    validateState(
      evidence.diagnosis,
      [
        "modelId",
        "boundaryLoops",
        "nonManifoldEdges",
        "inconsistentOrientationEdges",
        "degenerateTriangles",
      ],
      "diagnosis",
    );
  } else if (input.kind === "printability") {
    const assessment = objectWith(evidence.assessment, [
      "modelId",
      "method",
      "wallThickness",
      "overhangs",
      "islands",
      "buildVolume",
      "scale",
      "warnings",
      "disclaimer",
    ]);
    if (
      typeof assessment.disclaimer !== "string" ||
      assessment.disclaimer.length === 0
    )
      throw new Error("Printability evidence must retain its disclaimer.");
  } else if (input.kind === "measure-section") {
    if (
      !Array.isArray(evidence.measurements) ||
      !Array.isArray(evidence.activePoints)
    )
      throw new Error(
        "Measurement evidence must contain point and measurement lists.",
      );
    validateState(evidence.dimensions, ["kind", "semantics", "bounds"]);
    validateState(evidence.currentMeasurement, [
      "kind",
      "semantics",
      "firstMillimetres",
      "secondMillimetres",
      "distanceMillimetres",
      "deltaMillimetres",
    ]);
    validateState(evidence.section, [
      "modelId",
      "plane",
      "semantics",
      "loops",
      "coincidentTriangleCount",
      "warnings",
    ]);
  } else {
    if (
      !["flat", "hierarchy"].includes(String(evidence.placementKind)) ||
      !Array.isArray(evidence.meshes) ||
      !Array.isArray(evidence.instances)
    )
      throw new Error("File structure evidence is invalid.");
    objectWith(evidence.importLimits, [
      "inputBytes",
      "triangleCount",
      "vertexCount",
    ]);
  }
}

export function serializeEvidenceReport(
  input: EvidenceReportInput,
): Uint8Array {
  if (!Object.hasOwn(requiredEvidence, input.kind))
    throw new Error("Unsupported evidence report kind.");
  if (
    !input.source ||
    typeof input.source.name !== "string" ||
    input.source.name.length === 0 ||
    input.source.name.length > 1024 ||
    !Number.isSafeInteger(input.source.sizeBytes) ||
    input.source.sizeBytes < 0
  )
    throw new Error("Evidence report source metadata is invalid.");
  const parsed = geometryProvenanceSchema.safeParse(input.provenance);
  if (!parsed.success || input.provenance.sourceName !== input.source.name)
    throw new Error(
      "Evidence report provenance is invalid or does not match the source.",
    );
  if (
    !input.evidence ||
    requiredEvidence[input.kind].some(
      (key) => !Object.hasOwn(input.evidence, key),
    )
  )
    throw new Error("Evidence report is missing required evidence.");
  if (
    Object.keys(input.evidence).some(
      (key) => !requiredEvidence[input.kind].includes(key),
    )
  )
    throw new Error("Evidence report contains unexpected evidence fields.");
  if (!Array.isArray(input.evidence.warnings))
    throw new Error("Evidence report warnings must be an array.");
  validateEvidence(input);
  const report: EvidenceReport = {
    schemaVersion: 1,
    kind: input.kind,
    source: input.source,
    provenance: input.provenance,
    evidence: input.evidence,
    limitations: limitations[input.kind],
    limits: {
      importer: IMPORTER_SAFETY_LIMITS,
      evidence: evidenceLimits[input.kind],
      reportBytes: MAX_EVIDENCE_REPORT_BYTES,
    },
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      canonicalJson(report, 0, { value: 0 }, input.kind === "printability"),
      null,
      2,
    ) + "\n",
  );
  if (bytes.byteLength > MAX_EVIDENCE_REPORT_BYTES)
    throw new Error(
      "Evidence report exceeds its 8 MiB download limit; no report was downloaded.",
    );
  return bytes;
}

export function evidenceReportFileName(
  name: string,
  kind: EvidenceReportKind,
): string {
  const stem =
    name
      .replace(/\.[^.]*$/u, "")
      .replace(/[^a-zA-Z0-9._-]/gu, "_")
      .slice(0, 100) || "model";
  return `${stem}.${kind}.voxelspy-report.json`;
}
