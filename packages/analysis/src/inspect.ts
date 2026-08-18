import { IDENTITY_MAT4, normalizedModelSchema } from "@voxelspy/contracts";
import type { Mat4, NormalizedModel } from "@voxelspy/contracts";

import { ANALYSIS_LIMITS } from "./analyze.js";
import { countExpandedGeometry } from "./geometry.js";
import {
  summarizeModelGeometryWithEvidence,
  type ModelPresentationSummary,
  type TopologyComputation,
  type TopologyExampleLocation,
} from "./summary.js";

/**
 * Failed-closed rejection of hostile or oversized input, distinct from a
 * contract-schema validation failure (which throws the Zod error from
 * `normalizedModelSchema.parse` directly, matching `analyzeModelPair`'s
 * existing convention). Thrown before any O(vertices + triangles) work runs.
 */
export class InspectionResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionResourceLimitError";
  }
}

/** Default number of representative example locations collected per topology issue kind. */
export const DEFAULT_MAX_TOPOLOGY_EXAMPLES = 5;
/** Implementation ceiling on `InspectOptions.maxTopologyExamples`. */
export const MAX_TOPOLOGY_EXAMPLES = 50;
/** Default number of mesh-breakdown entries reported before truncation. */
export const DEFAULT_MAX_MESH_BREAKDOWN_ENTRIES = 200;
/** Implementation ceiling on `InspectOptions.maxMeshBreakdownEntries`. */
export const MAX_MESH_BREAKDOWN_ENTRIES = 2_000;

export interface InspectOptions {
  /** Defaults to identity: inspection reports in the model's own frame unless a comparison placement is supplied. */
  readonly modelToComparison?: Mat4;
  /** Bounded by `MAX_TOPOLOGY_EXAMPLES`. Defaults to `DEFAULT_MAX_TOPOLOGY_EXAMPLES`. */
  readonly maxTopologyExamples?: number;
  /** Bounded by `MAX_MESH_BREAKDOWN_ENTRIES`. Defaults to `DEFAULT_MAX_MESH_BREAKDOWN_ENTRIES`. */
  readonly maxMeshBreakdownEntries?: number;
}

export type TopologyFindingKind =
  | "boundary-edges"
  | "non-manifold-edges"
  | "inconsistent-orientation"
  | "degenerate-triangles";

export interface TopologyFinding {
  /** Stable per-kind id; equal to `kind`. */
  readonly id: TopologyFindingKind;
  readonly kind: TopologyFindingKind;
  readonly severity: "info" | "warning";
  readonly count: number;
  readonly summary: string;
  /** Bounded, deterministically ordered representative locations. */
  readonly examples: readonly TopologyExampleLocation[];
  /** True whenever `count` exceeds `examples.length`, including when the caller requested zero examples. */
  readonly examplesTruncated: boolean;
}

export type WatertightnessReason = "boundary-edges" | "non-manifold-edges";

/**
 * A watertightness verdict derived from exactly the same topology counts
 * `summarizeModelGeometry` already uses to decide volume availability --
 * `closed` if and only if `topology.boundaryEdgeCount === 0 &&
 * topology.nonManifoldEdgeCount === 0`, matching `assessGeometry`'s
 * `closed` field in `analyze.ts`. This package never defines a second,
 * conflicting notion of "closed."
 *
 * Inconsistent triangle orientation does not affect this verdict: a mesh
 * can be topologically closed (every edge touched exactly twice) while
 * inconsistently wound, which is exactly why `assessGeometry` and
 * `summarizeModelGeometry`'s volume evidence track "closed" and
 * "consistently oriented" as separate conditions. `indeterminate` covers
 * empty geometry (zero placed triangles), where closedness is not a
 * meaningful question -- kept for defense in depth and consistency with
 * `ModelPresentationSummary`'s "empty-geometry" `VolumeUnavailableReason`,
 * even though `inspectModel`'s own contract-schema validation currently
 * makes this state unreachable through that entry point: the mesh-buffer
 * schema requires a nonzero-byte-length transferable buffer for both
 * `positions` and `indices`, so a schema-valid mesh always contributes at
 * least one triangle.
 */
export type WatertightnessVerdict =
  | { readonly state: "closed" }
  | {
      readonly state: "not-closed";
      readonly reasons: readonly WatertightnessReason[];
    }
  | {
      readonly state: "indeterminate";
      readonly reasons: readonly ["empty-geometry"];
    };

export interface MeshBreakdownEntry {
  readonly meshId: NormalizedModel["meshes"][number]["id"];
  readonly triangleCount: number;
  readonly vertexCount: number;
}

export interface MeshBreakdown {
  /** In `model.meshes` order, truncated to the active `maxMeshBreakdownEntries` bound. */
  readonly meshes: readonly MeshBreakdownEntry[];
  readonly truncated: boolean;
  readonly totalMeshCount: number;
}

export interface InspectionResult {
  readonly modelId: NormalizedModel["id"];
  /** Echoed unchanged from the input model; never reinterpreted. */
  readonly frame: NormalizedModel["frame"];
  /** Echoed unchanged from the input model; never reinterpreted. */
  readonly provenance: NormalizedModel["provenance"];
  /** The same measurements the comparison path uses, unmodified. */
  readonly summary: ModelPresentationSummary;
  /** Deterministic; only issue kinds with a nonzero count are present. */
  readonly topologyFindings: readonly TopologyFinding[];
  readonly watertightness: WatertightnessVerdict;
  readonly meshBreakdown: MeshBreakdown;
}

/**
 * Builds a single-model inspection result that a UI can render directly:
 * the existing geometry summary (reused, not recomputed) plus a bounded,
 * deterministic list of topology findings, a watertightness verdict, and a
 * per-mesh breakdown. This is a reporting layer over
 * `summarizeModelGeometry`'s measurements, not a second geometry pipeline --
 * it adds no new geometric math beyond bounded example-location collection
 * (see `summarizeModelGeometryWithEvidence` in `summary.ts`).
 *
 * Fails closed: `model` is validated against the contracts schema (throwing
 * the Zod error on failure, matching `analyzeModelPair`'s convention), and
 * expanded vertex/triangle counts are checked against this package's
 * existing `ANALYSIS_LIMITS` ceilings before any O(vertices + triangles)
 * work runs, throwing `InspectionResourceLimitError` if exceeded.
 */
export function inspectModel(
  model: NormalizedModel,
  options: InspectOptions = {},
): InspectionResult {
  const validated = normalizedModelSchema.parse(model);
  checkResourceCeiling(validated);

  const maxTopologyExamples = resolveBound(
    options.maxTopologyExamples,
    DEFAULT_MAX_TOPOLOGY_EXAMPLES,
    MAX_TOPOLOGY_EXAMPLES,
    "maxTopologyExamples",
  );
  const maxMeshBreakdownEntries = resolveBound(
    options.maxMeshBreakdownEntries,
    DEFAULT_MAX_MESH_BREAKDOWN_ENTRIES,
    MAX_MESH_BREAKDOWN_ENTRIES,
    "maxMeshBreakdownEntries",
  );
  const modelToComparison = options.modelToComparison ?? IDENTITY_MAT4;

  const { summary, evidence } = summarizeModelGeometryWithEvidence(
    validated,
    modelToComparison,
    maxTopologyExamples,
  );

  return {
    modelId: validated.id,
    frame: validated.frame,
    provenance: validated.provenance,
    summary,
    topologyFindings: buildTopologyFindings(evidence),
    watertightness: computeWatertightness(summary),
    meshBreakdown: buildMeshBreakdown(validated, maxMeshBreakdownEntries),
  };
}

/**
 * Shared by `diagnoseMeshHealth` (`src/diagnose.ts`) so the two entry points
 * enforce identical expanded-geometry ceilings rather than drifting apart.
 */
export function checkResourceCeiling(model: NormalizedModel): void {
  const { vertices, triangles } = countExpandedGeometry(model);
  if (vertices > ANALYSIS_LIMITS.maxExpandedVertices) {
    throw new InspectionResourceLimitError(
      `Expanded geometry requires ${vertices} vertices; the implementation ceiling is ${ANALYSIS_LIMITS.maxExpandedVertices}.`,
    );
  }
  if (triangles > ANALYSIS_LIMITS.maxExpandedTriangles) {
    throw new InspectionResourceLimitError(
      `Expanded geometry requires ${triangles} triangles; the implementation ceiling is ${ANALYSIS_LIMITS.maxExpandedTriangles}.`,
    );
  }
}

/** Shared by `diagnoseMeshHealth` (`src/diagnose.ts`) for identical option-bound validation. */
export function resolveBound(
  value: number | undefined,
  fallback: number,
  ceiling: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
    throw new RangeError(
      `${name} must be a safe integer between 0 and ${ceiling}; received ${String(value)}.`,
    );
  }
  return value;
}

const TOPOLOGY_FINDING_ORDER: readonly {
  readonly kind: TopologyFindingKind;
  readonly severity: "info" | "warning";
}[] = [
  // Boundary edges alone describe a valid, intentionally open surface (a
  // panel or sheet, for example) rather than damaged geometry, so this kind
  // is informational. The others describe conditions that make the surface
  // itself unreliable (a genuine manifold defect, an orientation that
  // breaks normal/volume sign, or a triangle contributing no real area).
  { kind: "boundary-edges", severity: "info" },
  { kind: "non-manifold-edges", severity: "warning" },
  { kind: "inconsistent-orientation", severity: "warning" },
  { kind: "degenerate-triangles", severity: "warning" },
];

function buildTopologyFindings(
  evidence: TopologyComputation,
): TopologyFinding[] {
  const countAndExamplesFor = (
    kind: TopologyFindingKind,
  ): { count: number; examples: readonly TopologyExampleLocation[] } => {
    switch (kind) {
      case "boundary-edges":
        return {
          count: evidence.boundaryEdgeCount,
          examples: evidence.boundaryEdgeExamples,
        };
      case "non-manifold-edges":
        return {
          count: evidence.nonManifoldEdgeCount,
          examples: evidence.nonManifoldEdgeExamples,
        };
      case "inconsistent-orientation":
        return {
          count: evidence.inconsistentEdgeCount,
          examples: evidence.inconsistentEdgeExamples,
        };
      case "degenerate-triangles":
        return {
          count: evidence.degenerateTriangleCount,
          examples: evidence.degenerateTriangleExamples,
        };
    }
  };

  const findings: TopologyFinding[] = [];
  for (const { kind, severity } of TOPOLOGY_FINDING_ORDER) {
    const { count, examples } = countAndExamplesFor(kind);
    if (count === 0) continue;
    findings.push({
      id: kind,
      kind,
      severity,
      count,
      summary: describeFinding(kind, count),
      examples,
      examplesTruncated: examples.length < count,
    });
  }
  return findings;
}

function describeFinding(kind: TopologyFindingKind, count: number): string {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "boundary-edges":
      return `${count} boundary edge${plural}: the surface is open along ${count === 1 ? "this edge" : "these edges"} (touched by exactly one triangle).`;
    case "non-manifold-edges":
      return `${count} non-manifold edge${plural}: shared by more than two triangle corners at the same exact coordinates.`;
    case "inconsistent-orientation":
      return `${count} inconsistently oriented edge${plural}: traversed twice in the same winding direction instead of once each way.`;
    case "degenerate-triangles":
      return `${count} degenerate triangle${plural}: zero or non-finite area.`;
  }
}

function computeWatertightness(
  summary: ModelPresentationSummary,
): WatertightnessVerdict {
  if (summary.triangleCount === 0) {
    return { state: "indeterminate", reasons: ["empty-geometry"] };
  }
  const topology = summary.volume.topology;
  const reasons: WatertightnessReason[] = [];
  if (topology.boundaryEdgeCount > 0) reasons.push("boundary-edges");
  if (topology.nonManifoldEdgeCount > 0) reasons.push("non-manifold-edges");
  if (reasons.length === 0) return { state: "closed" };
  return { state: "not-closed", reasons };
}

function buildMeshBreakdown(
  model: NormalizedModel,
  maxEntries: number,
): MeshBreakdown {
  const totalMeshCount = model.meshes.length;
  const meshes = model.meshes.slice(0, maxEntries).map((mesh) => ({
    meshId: mesh.id,
    triangleCount: mesh.geometry.indices.length / 3,
    vertexCount: mesh.geometry.positions.length / 3,
  }));
  return {
    meshes,
    truncated: totalMeshCount > maxEntries,
    totalMeshCount,
  };
}
