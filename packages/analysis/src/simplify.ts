import {
  IDENTITY_MAT4,
  normalizedModelSchema,
  rigidTransformSchema,
} from "@voxelspy/contracts";
import type {
  NormalizedModel,
  RigidTransform,
  Vec3,
} from "@voxelspy/contracts";

import {
  ANALYSIS_LIMITS,
  SAMPLE_SPACING_EDGE_FACTOR,
  WorkBudget,
  WorkBudgetExceeded,
  WorkBudgetInternalError,
  checkExpandedGeometryBudget,
} from "./analyze.js";
import { normalizeZero } from "./chain-tracing.js";
import { countExpandedGeometry, flattenModel } from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";
import { TriangleSpatialIndex } from "./spatial-index.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A caller programming error, not a data-driven runtime outcome: an
 * out-of-range or malformed `target`, or a model with no non-degenerate
 * triangle left after flattening. Mirrors `PrintabilityInputError`
 * (`src/printability.ts`).
 */
export class SimplifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimplifyInputError";
  }
}

/**
 * Thrown when expanded geometry, this module's own tighter
 * `MAX_SIMPLIFY_INPUT_TRIANGLES` ceiling, or a caller-supplied
 * `executionBudget`, cannot accommodate the request -- before any
 * O(vertices + triangles) work runs. Mirrors `PrintabilityResourceLimitError`.
 */
export class SimplifyResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimplifyResourceLimitError";
  }
}

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

export const SIMPLIFY_METHOD_ID = "quadric-edge-collapse";
export const SIMPLIFY_METHOD_VERSION = "1.0.0";
export const CERTIFICATION_METHOD_ID = "surface-distance-both-directions";
export const CERTIFICATION_METHOD_VERSION = "1.0.0";

/**
 * Implementation ceiling on `simplifyModel`'s input triangle count (measured
 * after flattening, before decimation), tighter than the shared
 * `ANALYSIS_LIMITS.maxExpandedTriangles` ceiling every other entry point in
 * this package enforces. Edge-collapse decimation's working set -- a
 * per-vertex quadric (10 Float64 numbers), vertex/triangle adjacency sets,
 * and a priority heap of candidate collapses -- costs materially more per
 * triangle than the flatten-and-sample passes `ANALYSIS_LIMITS` was
 * calibrated against (see `src/analyze.ts`'s `BYTES_PER_VERTEX`/
 * `BYTES_PER_TRIANGLE` comment), so this narrower, separately documented
 * ceiling applies in addition to (not instead of) the shared
 * `checkExpandedGeometryBudget` check below. Unlike
 * `ANALYSIS_LIMITS.maxWorkUnits`, this has not been bench-calibrated against
 * a measured scaling run; it is a conservative, documented safety margin,
 * not a release-size or performance claim.
 */
export const MAX_SIMPLIFY_INPUT_TRIANGLES = 200_000;

/** Always `CERTIFICATION_DISCLAIMER`, verbatim, on every `SimplificationCertification`. */
export const CERTIFICATION_DISCLAIMER =
  "This certification is a sampled, approximate measurement, not an exact Hausdorff distance. Each analyzed triangle contributes its three vertices plus its centroid as samples against the opposite tessellated surface, measured in both directions (original-to-simplified and simplified-to-original, since either direction alone can understate the true difference). For each analyzed triangle, the farthest point on that triangle from its nearest sample is at most two-thirds of that triangle's longest edge -- reported as sampleSpacingUpperBoundMillimetres; a true deviation smaller than that bound, confined to a single triangle's interior, could be missed entirely and go unreported. The reported maximum is the true maximum among the samples actually taken, not a mathematical guarantee that no larger deviation exists anywhere on the continuous surface.";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type SimplifyTarget =
  | { readonly kind: "triangle-count"; readonly triangleCount: number }
  | { readonly kind: "reduction-ratio"; readonly reductionRatio: number };

export interface SimplifyOptions {
  /**
   * Either a triangle-count budget (`{ kind: "triangle-count",
   * triangleCount }`, a positive safe integer strictly below the input's
   * post-flatten triangle count) or a reduction ratio (`{ kind:
   * "reduction-ratio", reductionRatio }`, a finite number strictly between 0
   * and 1 -- the fraction of triangles to remove). Required: there is no
   * universally sensible default amount of decimation to apply.
   */
  readonly target: SimplifyTarget;
  /**
   * Defaults to `false`. When `false` (the default), no vertex that touches
   * a boundary edge (an edge shared by exactly one triangle) is ever moved
   * or merged away by decimation -- not just boundary edges themselves --
   * so an open surface's boundary loops are preserved exactly: same count,
   * same edges, same positions. When `true`, boundary vertices become
   * ordinary collapse candidates like any other, and a
   * `simplify.boundary-edges-collapsible` warning is added whenever the
   * input actually has boundary edges.
   */
  readonly collapseBoundaryEdges?: boolean;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface SimplifyGeometryCounts {
  readonly triangleCount: number;
  readonly vertexCount: number;
}

export interface SimplifyReduction {
  readonly triangleCountRemoved: number;
  /** `triangleCountRemoved / original.triangleCount`; `0` when `original.triangleCount` is `0` (unreachable through this entry point -- empty geometry is rejected before decimation -- kept total for safety). */
  readonly triangleReductionRatio: number;
  /**
   * `true` when the requested target triangle count was reached (including
   * trivially, when the input already met it). `false` when the target
   * could not be reached because every remaining candidate collapse would
   * have violated a preserved constraint (a boundary vertex by default,
   * manifoldness, or triangle-orientation safety) -- the achieved count is
   * still reported honestly, and a `simplify.target-not-reached` warning is
   * added, rather than failing or forcing an unsafe collapse through.
   */
  readonly targetReached: boolean;
}

export interface DirectionalDeviation {
  /** Always `"approximate-sampled"` -- see `SimplificationCertification`'s doc comment. */
  readonly semantics: "approximate-sampled";
  readonly maximumDistanceMillimetres: number;
  readonly meanDistanceMillimetres: number;
  /**
   * Upper bound, in millimetres, on the distance from any point on a
   * sampled source triangle to that triangle's own nearest sample (a vertex
   * or the centroid) -- at most two-thirds of that triangle's longest edge
   * (`SAMPLE_SPACING_EDGE_FACTOR`, `src/analyze.ts`). Qualifies this
   * direction's measurement: a genuine deviation smaller than this bound,
   * confined to one triangle's interior, could be missed.
   */
  readonly sampleSpacingUpperBoundMillimetres: number;
  /** The sampled location (vertex or centroid) that produced `maximumDistanceMillimetres`. */
  readonly worstSampleMillimetres: Vec3;
  /** Which source-side triangle that worst sample was taken from. */
  readonly worstSampleSourceTriangleIndex: number;
  readonly sampledTriangleCount: number;
}

export interface SimplificationCertification {
  readonly method: { readonly id: string; readonly version: string };
  /** Always `"approximate-sampled-bound"`. Never a guaranteed Hausdorff distance -- see `disclaimer`. */
  readonly semantics: "approximate-sampled-bound";
  readonly originalToSimplified: DirectionalDeviation;
  readonly simplifiedToOriginal: DirectionalDeviation;
  /** `max` of both directions' own maxima -- the certified bound a UI should lead with (e.g. "maximum measured deviation 0.03 mm"). */
  readonly maximumDistanceMillimetres: number;
  /** Average of both directions' own means. */
  readonly meanDistanceMillimetres: number;
  /** `max` of both directions' own sample-spacing bounds -- qualifies `maximumDistanceMillimetres` above. */
  readonly sampleSpacingUpperBoundMillimetres: number;
  /** Always `CERTIFICATION_DISCLAIMER`, verbatim. */
  readonly disclaimer: string;
}

export interface SimplifyWarning {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly details?: Readonly<Record<string, number>>;
}

export interface SimplificationParameters {
  readonly requestedTarget: SimplifyTarget;
  /** `target` resolved to an absolute triangle count -- the actual number decimation attempted to reach. */
  readonly effectiveTargetTriangleCount: number;
  readonly collapseBoundaryEdges: boolean;
}

export interface SimplificationResult {
  readonly modelId: NormalizedModel["id"];
  readonly method: { readonly id: string; readonly version: string };
  readonly original: SimplifyGeometryCounts;
  readonly simplified: SimplifyGeometryCounts;
  readonly reduction: SimplifyReduction;
  readonly parameters: SimplificationParameters;
  readonly certification: SimplificationCertification;
  /** The union of decimation's own disclosures (flattened placement, excluded degenerate input triangles, boundary-collapse opt-in, target-not-reached) -- never a second, silent channel for the same facts. */
  readonly warnings: readonly SimplifyWarning[];
  /** The simplified geometry as a schema-valid `NormalizedModel`, already validated against `normalizedModelSchema` -- ready to feed back into `inspectModel`, `assessPrintability`, `analyzeModelPair`, or any other entry point in this package. */
  readonly model: NormalizedModel;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decimates `model` with a deterministic, self-contained implementation of
 * Garland-Heckbert quadric-error-metric edge collapse, then certifies the
 * result by measuring the actual sampled surface deviation between the
 * original and simplified geometry -- in both directions -- using this
 * package's own `TriangleSpatialIndex`-accelerated distance machinery
 * (`src/spatial-index.ts`, the same primitive `analyzeModelPair`'s
 * `surface-distance` method and `assessPrintability`'s wall-thickness probe
 * use). The certification, not the decimation, is the point of this
 * function: mesh simplification alone is a commodity; reporting a measured,
 * honestly-qualified bound on how far the result actually deviates from the
 * input is not.
 *
 * **Decimation.** `model` is flattened into one comparison-frame geometry in
 * its own frame (`flattenModel` with an identity transform -- see the
 * `simplify.flattened-placement` warning below for what this means for a
 * multi-mesh or multi-instance input), then vertices are welded by exact
 * coordinate identity (the same no-tolerance convention every other
 * connectivity computation in this package uses -- see "Topology semantics"
 * in ../README.md) to recover shared-edge adjacency even from a facet-local
 * mesh. Each welded vertex accumulates a quadric error matrix from its
 * incident triangles' planes; each interior edge (shared by exactly two
 * triangles) is a collapse candidate, scored by the quadric error of its
 * numerically optimal merge point (solved via a 3x3 linear system, falling
 * back to the least-bad of its two endpoints or their midpoint when that
 * system is singular); candidates are processed in a fixed, fully
 * tie-broken order (ascending error, then ascending canonical vertex-id
 * pair, then insertion sequence -- a strict total order, so identical input
 * always processes candidates in the same order) from a binary min-heap
 * with lazy staleness detection, until the requested triangle count is
 * reached or no valid collapse remains.
 *
 * Every candidate collapse is validated before it is applied:
 * - **Boundary preservation.** By default (`collapseBoundaryEdges: false`),
 *   no vertex that touches any boundary edge is ever a collapse candidate,
 *   in either role -- boundary loops are therefore untouched exactly, not
 *   merely "not directly collapsed."
 * - **Manifoldness.** An edge shared by more than two triangles is never a
 *   candidate. Every remaining candidate is checked against the standard
 *   link condition before it is applied (the intersection of the two
 *   endpoints' neighbor-vertex sets must equal exactly the opposite
 *   vertices of the triangles being removed); a collapse that would pinch
 *   the surface into a non-manifold configuration is skipped, never forced
 *   through. The link condition alone is not sufficient for a very small
 *   closed component -- collapsing any edge of a tetrahedron (exactly 4
 *   triangles) satisfies it while merging the two remaining triangles into
 *   an identical, "doubled" face -- so every candidate is additionally
 *   checked against a general duplicate-triangle guard: a collapse is
 *   skipped if it would leave any two surviving triangles sharing the exact
 *   same three vertices. Together these keep a closed component from ever
 *   being decimated below its true manifold floor (4 triangles for a closed
 *   surface) by silent self-destruction.
 * - **Orientation safety.** A collapse that would flip a surviving
 *   triangle's normal by 90 degrees or more (or collapse it to zero area) is
 *   skipped.
 *
 * A skipped collapse is simply not retried with the same neighbors (it is
 * dropped, not re-queued) -- if this empties the heap before the requested
 * target is reached, decimation stops there: `reduction.targetReached` is
 * `false`, the actually-achieved triangle count is reported honestly, and a
 * `simplify.target-not-reached` warning is added. This never fails and
 * never fabricates unreachable geometry.
 *
 * **Certification.** After decimation, both the ORIGINAL flattened geometry
 * (including any degenerate triangles decimation itself excluded -- see the
 * `simplify.degenerate-triangles-excluded` warning) and the simplified
 * output are each sampled at their own vertices and triangle centroids
 * against a `TriangleSpatialIndex` of the other, exactly mirroring
 * `analyzeModelPair`'s `surface-distance` sampling. This is always
 * `semantics: "approximate-sampled-bound"` -- see `CERTIFICATION_DISCLAIMER`,
 * echoed verbatim on `certification.disclaimer`: it is never presented as an
 * exact or guaranteed Hausdorff distance.
 *
 * **Resource discipline.** `model` is validated against
 * `normalizedModelSchema`, then expanded vertex/triangle counts (plus
 * estimated memory, honoring an optional caller-supplied
 * `executionBudget.maxMemoryBytes`) are checked via
 * `checkExpandedGeometryBudget` -- the same pre-flight every other
 * multi-triangle entry point in this package uses -- and separately against
 * this module's own tighter `MAX_SIMPLIFY_INPUT_TRIANGLES`, both before any
 * O(vertices + triangles) work runs. Flattening, welding, quadric
 * initialization, candidate scoring, heap operations, collapse validation
 * and application, and both certification passes are all charged to one
 * charge-before-work `WorkBudget` (bounded by `executionBudget.maxWorkUnits`,
 * reusing `ANALYSIS_LIMITS`/`WorkBudget` from `src/analyze.ts` unchanged); an
 * exhausted budget throws `WorkBudgetExceeded` unchanged. The simplified
 * geometry is validated against `normalizedModelSchema` before it is
 * returned -- a simplifier that emitted invalid geometry would be worse than
 * none.
 *
 * **Determinism.** Identical input produces a deeply equal
 * `SimplificationResult` every time, including the emitted `model`'s
 * geometry: welding, quadric accumulation, candidate ordering, the binary
 * heap's pop sequence (a strict total order has no ambiguous ties), and
 * final vertex/triangle renumbering are all fixed functions of the input
 * with no randomness and no reliance on iteration order beyond the
 * language's own guaranteed insertion-order iteration for `Map`/`Set`.
 */
export function simplifyModel(
  model: NormalizedModel,
  options: SimplifyOptions,
): SimplificationResult {
  const validated = normalizedModelSchema.parse(model);

  const counts = countExpandedGeometry(validated);
  if (counts.triangles > MAX_SIMPLIFY_INPUT_TRIANGLES) {
    throw new SimplifyResourceLimitError(
      `simplifyModel's input requires ${counts.triangles} triangles; the implementation ceiling is ${MAX_SIMPLIFY_INPUT_TRIANGLES} (tighter than this package's general ${ANALYSIS_LIMITS.maxExpandedTriangles}-triangle ceiling -- see MAX_SIMPLIFY_INPUT_TRIANGLES's doc comment).`,
    );
  }
  const budgetProblem = checkExpandedGeometryBudget(
    counts.vertices,
    counts.triangles,
    options.executionBudget,
  );
  if (budgetProblem !== undefined) {
    throw new SimplifyResourceLimitError(budgetProblem);
  }

  const workLimit = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    options.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  const work = new WorkBudget(workLimit);

  let originalGeometry: FlatGeometry;
  try {
    originalGeometry = flattenModel(validated, IDENTITY_RIGID, work);
  } catch (error) {
    if (
      error instanceof WorkBudgetExceeded ||
      error instanceof WorkBudgetInternalError
    ) {
      throw error;
    }
    throw new SimplifyInputError(
      error instanceof Error
        ? error.message
        : "Failed to flatten model geometry.",
    );
  }
  if (originalGeometry.triangleCount === 0) {
    throw new SimplifyInputError(
      "simplifyModel requires at least one triangle after flattening.",
    );
  }

  const collapseBoundaryEdges = options.collapseBoundaryEdges ?? false;
  const targetTriangleCount = resolveTarget(
    options.target,
    originalGeometry.triangleCount,
  );

  const meshCount = validated.meshes.length;
  const instanceCount = validated.placement.instances.length;

  const decimation = decimate(
    originalGeometry,
    targetTriangleCount,
    collapseBoundaryEdges,
    work,
  );

  const validatedSimplified = buildSimplifiedModel(
    validated,
    decimation.geometry,
  );

  const certification = certifyDeviation(
    originalGeometry,
    decimation.geometry,
    work,
  );

  const warnings: SimplifyWarning[] = [];
  if (meshCount > 1 || instanceCount > 1) {
    warnings.push({
      code: "simplify.flattened-placement",
      severity: "info",
      message: `${meshCount} mesh(es) across ${instanceCount} instance(s) were flattened into a single mesh instance for simplification; per-instance placement structure is not preserved in the simplified model.`,
      details: { meshCount, instanceCount },
    });
  }
  if (decimation.excludedDegenerateTriangleCount > 0) {
    warnings.push({
      code: "simplify.degenerate-triangles-excluded",
      severity: "warning",
      message: `${decimation.excludedDegenerateTriangleCount} degenerate (zero-area or non-finite-area) triangle(s) in the input were excluded before decimation and do not appear in the simplified model.`,
      details: {
        excludedDegenerateTriangleCount:
          decimation.excludedDegenerateTriangleCount,
      },
    });
  }
  if (collapseBoundaryEdges && decimation.boundaryEdgeCount > 0) {
    warnings.push({
      code: "simplify.boundary-edges-collapsible",
      severity: "warning",
      message: `Boundary edges (${decimation.boundaryEdgeCount} detected) were eligible for collapse; the simplified model's boundary loops may differ in count, length, or shape from the original.`,
      details: { boundaryEdgeCount: decimation.boundaryEdgeCount },
    });
  }
  if (!decimation.targetReached) {
    warnings.push({
      code: "simplify.target-not-reached",
      severity: "warning",
      message: `The requested target of ${targetTriangleCount} triangles could not be reached: ${decimation.geometry.triangleCount} triangles remain because every further collapse would have violated a preserved constraint (a boundary vertex, manifoldness, or triangle-orientation safety).`,
      details: {
        requestedTargetTriangleCount: targetTriangleCount,
        achievedTriangleCount: decimation.geometry.triangleCount,
      },
    });
  }

  const triangleCountRemoved =
    originalGeometry.triangleCount - decimation.geometry.triangleCount;

  return {
    modelId: validated.id,
    method: { id: SIMPLIFY_METHOD_ID, version: SIMPLIFY_METHOD_VERSION },
    original: {
      triangleCount: originalGeometry.triangleCount,
      vertexCount: originalGeometry.vertexCount,
    },
    simplified: {
      triangleCount: decimation.geometry.triangleCount,
      vertexCount: decimation.geometry.vertexCount,
    },
    reduction: {
      triangleCountRemoved,
      triangleReductionRatio:
        originalGeometry.triangleCount > 0
          ? triangleCountRemoved / originalGeometry.triangleCount
          : 0,
      targetReached: decimation.targetReached,
    },
    parameters: {
      requestedTarget: options.target,
      effectiveTargetTriangleCount: targetTriangleCount,
      collapseBoundaryEdges,
    },
    certification,
    warnings,
    model: validatedSimplified,
  };
}

function resolveTarget(target: SimplifyTarget, triangleCount: number): number {
  if (target.kind === "triangle-count") {
    const value = target.triangleCount;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SimplifyInputError(
        `target.triangleCount must be a positive safe integer; received ${String(value)}.`,
      );
    }
    if (value >= triangleCount) {
      throw new SimplifyInputError(
        `target.triangleCount (${value}) must be smaller than the input's ${triangleCount} triangles; simplifyModel only decimates, it never adds geometry.`,
      );
    }
    return value;
  }
  if (target.kind !== "reduction-ratio") {
    throw new SimplifyInputError(
      `target.kind must be "triangle-count" or "reduction-ratio"; received ${String((target as { kind?: unknown }).kind)}.`,
    );
  }
  const ratio = target.reductionRatio;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new SimplifyInputError(
      `target.reductionRatio must be a finite number strictly between 0 and 1; received ${String(ratio)}.`,
    );
  }
  const computed = Math.round(triangleCount * (1 - ratio));
  return Math.max(1, Math.min(triangleCount - 1, computed));
}

// ---------------------------------------------------------------------------
// Decimation
// ---------------------------------------------------------------------------

interface DecimationOutcome {
  readonly geometry: FlatGeometry;
  readonly targetReached: boolean;
  readonly excludedDegenerateTriangleCount: number;
  readonly boundaryEdgeCount: number;
}

/** Charged per source vertex during exact-coordinate welding (a Float64 triple read plus a string-key Map lookup/insert). */
const WELD_VERTEX_WORK_UNITS = 6;
/** Charged per source triangle while remapping to welded ids, filtering degenerate triangles, and building initial vertex/triangle adjacency. */
const TRIANGLE_INIT_WORK_UNITS = 12;
/** Charged per working triangle while accumulating its plane quadric into its three corners. */
const QUADRIC_INIT_WORK_UNITS = 24;
/** Charged per unique initial edge while classifying it (boundary/manifold-interior/non-manifold) and scoring it if eligible. */
const EDGE_CLASSIFY_WORK_UNITS = 24;
/** Charged per heap push. */
const HEAP_PUSH_WORK_UNITS = 4;
/** Charged per heap pop attempt, including ones discarded as stale. */
const HEAP_POP_WORK_UNITS = 4;
/** Charged per link-condition/orientation-safety validation attempt (a flat, deliberately coarse estimate -- see this module's resource-discipline documentation in ../README.md). */
const COLLAPSE_VALIDATION_WORK_UNITS = 32;
/** Charged per triangle reassigned from the removed vertex to the surviving vertex during a successful collapse. */
const COLLAPSE_REASSIGN_TRIANGLE_WORK_UNITS = 6;
/** Charged per neighbor candidate edge rescored and re-pushed after a successful collapse. */
const NEIGHBOR_RESCORE_WORK_UNITS = 20;

function decimate(
  source: FlatGeometry,
  targetTriangleCount: number,
  collapseBoundaryEdges: boolean,
  work: WorkUnitCounter,
): DecimationOutcome {
  // --- Weld vertices by exact coordinate identity -------------------------
  const sourceVertexCount = source.vertexCount;
  work.charge(sourceVertexCount * WELD_VERTEX_WORK_UNITS);
  const weldKeyToId = new Map<string, number>();
  const remap = new Uint32Array(sourceVertexCount);
  const weldedX: number[] = [];
  const weldedY: number[] = [];
  const weldedZ: number[] = [];
  for (let v = 0; v < sourceVertexCount; v += 1) {
    const base = v * 3;
    const x = source.positions[base]!;
    const y = source.positions[base + 1]!;
    const z = source.positions[base + 2]!;
    const key = `${x},${y},${z}`;
    let id = weldKeyToId.get(key);
    if (id === undefined) {
      id = weldedX.length;
      weldKeyToId.set(key, id);
      weldedX.push(x);
      weldedY.push(y);
      weldedZ.push(z);
    }
    remap[v] = id;
  }
  const weldedVertexCount = weldedX.length;

  // --- Build the working triangle list, excluding degenerate triangles ----
  const sourceTriangleCount = source.triangleCount;
  work.charge(sourceTriangleCount * TRIANGLE_INIT_WORK_UNITS);
  const workingA: number[] = [];
  const workingB: number[] = [];
  const workingC: number[] = [];
  let excludedDegenerateTriangleCount = 0;
  for (let t = 0; t < sourceTriangleCount; t += 1) {
    const base = t * 3;
    const a = remap[source.indices[base]!]!;
    const b = remap[source.indices[base + 1]!]!;
    const c = remap[source.indices[base + 2]!]!;
    if (a === b || b === c || c === a) {
      excludedDegenerateTriangleCount += 1;
      continue;
    }
    const area = weldedTriangleArea(weldedX, weldedY, weldedZ, a, b, c);
    if (!(area > 0) || !Number.isFinite(area)) {
      excludedDegenerateTriangleCount += 1;
      continue;
    }
    workingA.push(a);
    workingB.push(b);
    workingC.push(c);
  }
  const workingTriangleCount = workingA.length;
  if (workingTriangleCount === 0) {
    throw new SimplifyInputError(
      "All triangles in the input are degenerate (zero area or non-finite); there is no surface left to decimate.",
    );
  }

  const triA = Uint32Array.from(workingA);
  const triB = Uint32Array.from(workingB);
  const triC = Uint32Array.from(workingC);
  const triAlive = new Uint8Array(workingTriangleCount).fill(1);

  // --- Vertex/triangle adjacency and per-vertex quadrics ------------------
  const vertexTriangles = new Map<number, Set<number>>();
  const addIncidence = (vertex: number, triangle: number): void => {
    let set = vertexTriangles.get(vertex);
    if (set === undefined) {
      set = new Set<number>();
      vertexTriangles.set(vertex, set);
    }
    set.add(triangle);
  };
  for (let t = 0; t < workingTriangleCount; t += 1) {
    addIncidence(triA[t]!, t);
    addIncidence(triB[t]!, t);
    addIncidence(triC[t]!, t);
  }
  const trianglesOf = (vertex: number): Set<number> =>
    vertexTriangles.get(vertex) ?? EMPTY_SET;

  const quadric = new Float64Array(weldedVertexCount * 10);
  work.charge(workingTriangleCount * QUADRIC_INIT_WORK_UNITS);
  for (let t = 0; t < workingTriangleCount; t += 1) {
    const a = triA[t]!;
    const b = triB[t]!;
    const c = triC[t]!;
    const plane = planeOf(weldedX, weldedY, weldedZ, a, b, c);
    if (plane === undefined) continue;
    addQuadric(quadric, a, plane);
    addQuadric(quadric, b, plane);
    addQuadric(quadric, c, plane);
  }

  const alive = new Uint8Array(weldedVertexCount).fill(1);
  const version = new Int32Array(weldedVertexCount);

  // --- Boundary vertex census (preservation guardrail) --------------------
  const boundaryVertex = new Uint8Array(weldedVertexCount);
  let boundaryEdgeCount = 0;

  // --- Discover unique initial edges, classify, and seed the heap ---------
  const initialEdgeKeys = new Set<string>();
  const addEdgeKey = (x: number, y: number): void => {
    initialEdgeKeys.add(x < y ? `${x}_${y}` : `${y}_${x}`);
  };
  for (let t = 0; t < workingTriangleCount; t += 1) {
    const a = triA[t]!;
    const b = triB[t]!;
    const c = triC[t]!;
    addEdgeKey(a, b);
    addEdgeKey(b, c);
    addEdgeKey(c, a);
  }

  const scratchQuadric = new Float64Array(10);
  // A `let` binding (reassigned once below, after boundary status is fully
  // known) rather than a `const` -- `pushCandidate` closes over this
  // variable by reference, so every push (including ones issued mid-loop by
  // `pushNeighborCandidates`, defined further below) always targets
  // whichever heap is currently active.
  let activeHeap = new BinaryHeap<HeapEntry>(compareHeapEntry);
  let seq = 0;

  const scoreCollapse = (
    v1: number,
    v2: number,
  ): {
    readonly error: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  } => {
    sumQuadric(quadric, v1, v2, scratchQuadric);
    const solved = solveOptimalPoint(scratchQuadric);
    let x: number;
    let y: number;
    let z: number;
    if (solved !== undefined) {
      [x, y, z] = solved;
    } else {
      const candidates: readonly [number, number, number][] = [
        [weldedX[v1]!, weldedY[v1]!, weldedZ[v1]!],
        [weldedX[v2]!, weldedY[v2]!, weldedZ[v2]!],
        [
          (weldedX[v1]! + weldedX[v2]!) / 2,
          (weldedY[v1]! + weldedY[v2]!) / 2,
          (weldedZ[v1]! + weldedZ[v2]!) / 2,
        ],
      ];
      let best = candidates[0]!;
      let bestError = evalQuadric(scratchQuadric, best[0], best[1], best[2]);
      for (let i = 1; i < candidates.length; i += 1) {
        const candidate = candidates[i]!;
        const candidateError = evalQuadric(
          scratchQuadric,
          candidate[0],
          candidate[1],
          candidate[2],
        );
        if (candidateError < bestError) {
          bestError = candidateError;
          best = candidate;
        }
      }
      [x, y, z] = best;
    }
    const error = evalQuadric(scratchQuadric, x, y, z);
    return { error, x, y, z };
  };

  const pushCandidate = (v1: number, v2: number): void => {
    const lo = Math.min(v1, v2);
    const hi = Math.max(v1, v2);
    work.charge(HEAP_PUSH_WORK_UNITS);
    const { error, x, y, z } = scoreCollapse(lo, hi);
    activeHeap.push({
      error,
      v1: lo,
      v2: hi,
      targetX: x,
      targetY: y,
      targetZ: z,
      v1Version: version[lo]!,
      v2Version: version[hi]!,
      seq: seq++,
    });
  };

  for (const key of initialEdgeKeys) {
    work.charge(EDGE_CLASSIFY_WORK_UNITS);
    const [loText, hiText] = key.split("_");
    const v1 = Number(loText);
    const v2 = Number(hiText);
    const incidentCount = intersectCount(trianglesOf(v1), trianglesOf(v2));
    if (incidentCount === 1) {
      boundaryEdgeCount += 1;
      boundaryVertex[v1] = 1;
      boundaryVertex[v2] = 1;
    }
    if (incidentCount > 2) continue; // non-manifold: never a candidate
    const eligible =
      incidentCount === 2 || (incidentCount === 1 && collapseBoundaryEdges);
    if (!eligible) continue;
    pushCandidate(v1, v2);
  }

  // The single edge-key pass above can, for a manifold-interior edge whose
  // own two endpoints were not (yet) known to be boundary vertices at the
  // time it was pushed, have already pushed a now-ineligible candidate --
  // boundary status for a given vertex is only fully known once every edge
  // has been classified, and edges are classified in one fixed pass in
  // `initialEdgeKeys`'s (deterministic) order. Filter those out before
  // decimation starts by rebuilding the heap once boundary status is final
  // -- cheap relative to the O(edges) classification pass above, and keeps
  // the "no boundary vertex ever moves" guarantee exact rather than
  // best-effort.
  if (!collapseBoundaryEdges && boundaryEdgeCount > 0) {
    const filtered = new BinaryHeap<HeapEntry>(compareHeapEntry);
    for (const entry of activeHeap.drain()) {
      if (boundaryVertex[entry.v1] === 1 || boundaryVertex[entry.v2] === 1) {
        continue;
      }
      filtered.push(entry);
    }
    activeHeap = filtered;
  }

  // --- Collapse loop --------------------------------------------------
  let aliveTriangleCount = workingTriangleCount;
  let targetReached = true;

  const passesLinkCondition = (v1: number, v2: number): boolean => {
    const collapsing = intersectSet(trianglesOf(v1), trianglesOf(v2));
    const opposite = new Set<number>();
    for (const t of collapsing) {
      const a = triA[t]!;
      const b = triB[t]!;
      const c = triC[t]!;
      const w = a !== v1 && a !== v2 ? a : b !== v1 && b !== v2 ? b : c;
      opposite.add(w);
    }
    const neighborsOf = (v: number, exclude: number): Set<number> => {
      const result = new Set<number>();
      for (const t of trianglesOf(v)) {
        const a = triA[t]!;
        const b = triB[t]!;
        const c = triC[t]!;
        if (a !== v && a !== exclude) result.add(a);
        if (b !== v && b !== exclude) result.add(b);
        if (c !== v && c !== exclude) result.add(c);
      }
      return result;
    };
    const n1 = neighborsOf(v1, v2);
    const n2 = neighborsOf(v2, v1);
    let sharedCount = 0;
    for (const w of n1) {
      if (n2.has(w)) {
        sharedCount += 1;
        if (!opposite.has(w)) return false;
      }
    }
    return sharedCount === opposite.size;
  };

  const wouldInvertTriangle = (
    v1: number,
    v2: number,
    x: number,
    y: number,
    z: number,
  ): boolean => {
    const collapsing = intersectSet(trianglesOf(v1), trianglesOf(v2));
    const check = (t: number, moving: number): boolean => {
      const a = triA[t]!;
      const b = triB[t]!;
      const c = triC[t]!;
      const ax = a === moving ? x : weldedX[a]!;
      const ay = a === moving ? y : weldedY[a]!;
      const az = a === moving ? z : weldedZ[a]!;
      const bx = b === moving ? x : weldedX[b]!;
      const by = b === moving ? y : weldedY[b]!;
      const bz = b === moving ? z : weldedZ[b]!;
      const cx = c === moving ? x : weldedX[c]!;
      const cy = c === moving ? y : weldedY[c]!;
      const cz = c === moving ? z : weldedZ[c]!;
      const oldNormal = rawNormal(
        weldedX[a]!,
        weldedY[a]!,
        weldedZ[a]!,
        weldedX[b]!,
        weldedY[b]!,
        weldedZ[b]!,
        weldedX[c]!,
        weldedY[c]!,
        weldedZ[c]!,
      );
      const newNormal = rawNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
      const dotValue =
        oldNormal[0] * newNormal[0] +
        oldNormal[1] * newNormal[1] +
        oldNormal[2] * newNormal[2];
      return dotValue <= 0;
    };
    for (const t of trianglesOf(v1)) {
      if (collapsing.has(t)) continue;
      if (check(t, v1)) return true;
    }
    for (const t of trianglesOf(v2)) {
      if (collapsing.has(t)) continue;
      if (check(t, v2)) return true;
    }
    return false;
  };

  /**
   * The standard link condition (`passesLinkCondition` above) is a
   * necessary but not sufficient guard on its own: for a small closed
   * component -- the sharpest case is a tetrahedron, exactly 4 triangles --
   * it is satisfied by every edge, yet collapsing any edge there merges two
   * of the remaining two triangles into an identical vertex triple (a
   * "doubled," zero-thickness face), silently destroying the surface one
   * collapse at a time rather than stopping at the true 4-triangle floor.
   * This checks, directly and in general (not just for tetrahedra), whether
   * any two SURVIVING triangles (incident to `v1` or `v2`, excluding the
   * ones this collapse would remove) would end up sharing the exact same
   * three vertices once `v2` is renamed to `v1` -- rejecting the collapse if
   * so, the same "skip, never force" discipline the other two safety checks
   * use.
   */
  const wouldDuplicateTriangle = (v1: number, v2: number): boolean => {
    const collapsing = intersectSet(trianglesOf(v1), trianglesOf(v2));
    const seen = new Set<string>();
    const keyOf = (a: number, b: number, c: number): string => {
      const lo = Math.min(a, b, c);
      const hi = Math.max(a, b, c);
      const mid = a + b + c - lo - hi;
      return `${lo}_${mid}_${hi}`;
    };
    for (const t of trianglesOf(v1)) {
      if (collapsing.has(t)) continue;
      const key = keyOf(triA[t]!, triB[t]!, triC[t]!);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    for (const t of trianglesOf(v2)) {
      if (collapsing.has(t)) continue;
      const a = triA[t] === v2 ? v1 : triA[t]!;
      const b = triB[t] === v2 ? v1 : triB[t]!;
      const c = triC[t] === v2 ? v1 : triC[t]!;
      const key = keyOf(a, b, c);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  };

  const markTriangleDead = (t: number): void => {
    triAlive[t] = 0;
    trianglesOf(triA[t]!).delete(t);
    trianglesOf(triB[t]!).delete(t);
    trianglesOf(triC[t]!).delete(t);
  };

  const applyCollapse = (
    survivor: number,
    removed: number,
    x: number,
    y: number,
    z: number,
  ): number => {
    const survivorSet = trianglesOf(survivor);
    const removedSet = trianglesOf(removed);
    const collapsing = intersectSet(survivorSet, removedSet);
    for (const t of collapsing) markTriangleDead(t);
    for (const t of [...removedSet]) {
      work.charge(COLLAPSE_REASSIGN_TRIANGLE_WORK_UNITS);
      if (triA[t] === removed) triA[t] = survivor;
      else if (triB[t] === removed) triB[t] = survivor;
      else if (triC[t] === removed) triC[t] = survivor;
      removedSet.delete(t);
      survivorSet.add(t);
    }
    vertexTriangles.delete(removed);
    alive[removed] = 0;
    weldedX[survivor] = x;
    weldedY[survivor] = y;
    weldedZ[survivor] = z;
    addQuadricInPlace(quadric, survivor, removed);
    version[survivor]! += 1;
    return collapsing.size;
  };

  const pushNeighborCandidates = (survivor: number): void => {
    const neighbors = new Set<number>();
    for (const t of trianglesOf(survivor)) {
      const a = triA[t]!;
      const b = triB[t]!;
      const c = triC[t]!;
      if (a !== survivor) neighbors.add(a);
      if (b !== survivor) neighbors.add(b);
      if (c !== survivor) neighbors.add(c);
    }
    for (const w of neighbors) {
      work.charge(NEIGHBOR_RESCORE_WORK_UNITS);
      if (
        !collapseBoundaryEdges &&
        (boundaryVertex[survivor] === 1 || boundaryVertex[w] === 1)
      ) {
        continue;
      }
      const incidentCount = intersectCount(
        trianglesOf(survivor),
        trianglesOf(w),
      );
      const eligible =
        incidentCount === 2 || (incidentCount === 1 && collapseBoundaryEdges);
      if (!eligible) continue;
      pushCandidate(survivor, w);
    }
  };

  while (aliveTriangleCount > targetTriangleCount) {
    work.charge(HEAP_POP_WORK_UNITS);
    const entry = activeHeap.pop();
    if (entry === undefined) {
      targetReached = false;
      break;
    }
    if (
      alive[entry.v1] !== 1 ||
      alive[entry.v2] !== 1 ||
      version[entry.v1] !== entry.v1Version ||
      version[entry.v2] !== entry.v2Version
    ) {
      continue; // stale
    }
    work.charge(COLLAPSE_VALIDATION_WORK_UNITS);
    if (!passesLinkCondition(entry.v1, entry.v2)) continue;
    if (wouldDuplicateTriangle(entry.v1, entry.v2)) continue;
    if (
      wouldInvertTriangle(
        entry.v1,
        entry.v2,
        entry.targetX,
        entry.targetY,
        entry.targetZ,
      )
    ) {
      continue;
    }
    const survivor = entry.v1;
    const removed = entry.v2;
    const removedCount = applyCollapse(
      survivor,
      removed,
      entry.targetX,
      entry.targetY,
      entry.targetZ,
    );
    aliveTriangleCount -= removedCount;
    pushNeighborCandidates(survivor);
  }

  return {
    geometry: finalizeGeometry(
      weldedVertexCount,
      weldedX,
      weldedY,
      weldedZ,
      workingTriangleCount,
      triA,
      triB,
      triC,
      triAlive,
    ),
    targetReached,
    excludedDegenerateTriangleCount,
    boundaryEdgeCount,
  };
}

/**
 * Never mutated: every call site that mutates the result of `trianglesOf`
 * (`applyCollapse`) only does so for a vertex known to already have a real
 * adjacency entry (`survivor`/`removed`, both freshly validated alive with a
 * nonempty triangle set), so this fallback is only ever read from, never
 * written to.
 */
const EMPTY_SET: Set<number> = new Set<number>();

function finalizeGeometry(
  weldedVertexCount: number,
  weldedX: readonly number[],
  weldedY: readonly number[],
  weldedZ: readonly number[],
  workingTriangleCount: number,
  triA: Uint32Array,
  triB: Uint32Array,
  triC: Uint32Array,
  triAlive: Uint8Array,
): FlatGeometry {
  const referenced = new Uint8Array(weldedVertexCount);
  for (let t = 0; t < workingTriangleCount; t += 1) {
    if (triAlive[t] === 0) continue;
    referenced[triA[t]!] = 1;
    referenced[triB[t]!] = 1;
    referenced[triC[t]!] = 1;
  }
  const vertexNewId = new Int32Array(weldedVertexCount).fill(-1);
  const outX: number[] = [];
  const outY: number[] = [];
  const outZ: number[] = [];
  for (let v = 0; v < weldedVertexCount; v += 1) {
    if (referenced[v] === 0) continue;
    vertexNewId[v] = outX.length;
    outX.push(weldedX[v]!);
    outY.push(weldedY[v]!);
    outZ.push(weldedZ[v]!);
  }
  const outIndices: number[] = [];
  for (let t = 0; t < workingTriangleCount; t += 1) {
    if (triAlive[t] === 0) continue;
    outIndices.push(
      vertexNewId[triA[t]!]!,
      vertexNewId[triB[t]!]!,
      vertexNewId[triC[t]!]!,
    );
  }
  const positions = new Float64Array(outX.length * 3);
  for (let v = 0; v < outX.length; v += 1) {
    positions[v * 3] = normalizeZero(outX[v]!);
    positions[v * 3 + 1] = normalizeZero(outY[v]!);
    positions[v * 3 + 2] = normalizeZero(outZ[v]!);
  }
  const indices = new Uint32Array(outIndices);
  return {
    positions,
    indices,
    vertexCount: outX.length,
    triangleCount: outIndices.length / 3,
  };
}

// ---------------------------------------------------------------------------
// Quadric error metric math
// ---------------------------------------------------------------------------

/** `[a, b, c, d]` for the unit-normal plane `a*x + b*y + c*z + d = 0` through triangle `(a,b,c)`, or `undefined` for a degenerate (zero-area) triangle. */
function planeOf(
  x: readonly number[],
  y: readonly number[],
  z: readonly number[],
  ia: number,
  ib: number,
  ic: number,
): readonly [number, number, number, number] | undefined {
  const ax = x[ia]!;
  const ay = y[ia]!;
  const az = z[ia]!;
  const e1x = x[ib]! - ax;
  const e1y = y[ib]! - ay;
  const e1z = z[ib]! - az;
  const e2x = x[ic]! - ax;
  const e2y = y[ic]! - ay;
  const e2z = z[ic]! - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0) || !Number.isFinite(length)) return undefined;
  const a = nx / length;
  const b = ny / length;
  const c = nz / length;
  const d = -(a * ax + b * ay + c * az);
  return [a, b, c, d];
}

function rawNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): readonly [number, number, number] {
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
}

/** Adds the plane quadric for `[a, b, c, d]` (`outer([a,b,c,d], [a,b,c,d])`, upper-triangular 10 entries: q11,q12,q13,q14,q22,q23,q24,q33,q34,q44) into vertex `vertex`'s slot of `quadric`. */
function addQuadric(
  quadric: Float64Array,
  vertex: number,
  plane: readonly [number, number, number, number],
): void {
  const [a, b, c, d] = plane;
  const base = vertex * 10;
  quadric[base] = (quadric[base] ?? 0) + a * a;
  quadric[base + 1] = (quadric[base + 1] ?? 0) + a * b;
  quadric[base + 2] = (quadric[base + 2] ?? 0) + a * c;
  quadric[base + 3] = (quadric[base + 3] ?? 0) + a * d;
  quadric[base + 4] = (quadric[base + 4] ?? 0) + b * b;
  quadric[base + 5] = (quadric[base + 5] ?? 0) + b * c;
  quadric[base + 6] = (quadric[base + 6] ?? 0) + b * d;
  quadric[base + 7] = (quadric[base + 7] ?? 0) + c * c;
  quadric[base + 8] = (quadric[base + 8] ?? 0) + c * d;
  quadric[base + 9] = (quadric[base + 9] ?? 0) + d * d;
}

/** Writes `quadric[v1] + quadric[v2]` into `out` (length 10). */
function sumQuadric(
  quadric: Float64Array,
  v1: number,
  v2: number,
  out: Float64Array,
): void {
  const base1 = v1 * 10;
  const base2 = v2 * 10;
  for (let i = 0; i < 10; i += 1) {
    out[i] = quadric[base1 + i]! + quadric[base2 + i]!;
  }
}

/** Adds `quadric[from]` into `quadric[into]` in place. */
function addQuadricInPlace(
  quadric: Float64Array,
  into: number,
  from: number,
): void {
  const baseInto = into * 10;
  const baseFrom = from * 10;
  for (let i = 0; i < 10; i += 1) {
    quadric[baseInto + i] = quadric[baseInto + i]! + quadric[baseFrom + i]!;
  }
}

/** `v^T Q v` for homogeneous `v = [x, y, z, 1]`. */
function evalQuadric(q: Float64Array, x: number, y: number, z: number): number {
  const q11 = q[0]!;
  const q12 = q[1]!;
  const q13 = q[2]!;
  const q14 = q[3]!;
  const q22 = q[4]!;
  const q23 = q[5]!;
  const q24 = q[6]!;
  const q33 = q[7]!;
  const q34 = q[8]!;
  const q44 = q[9]!;
  return (
    q11 * x * x +
    2 * q12 * x * y +
    2 * q13 * x * z +
    2 * q14 * x +
    q22 * y * y +
    2 * q23 * y * z +
    2 * q24 * y +
    q33 * z * z +
    2 * q34 * z +
    q44
  );
}

/**
 * Solves the 3x3 linear system for the point minimizing `v^T q v` over
 * `v = [x, y, z, 1]`, via Cramer's rule -- or `undefined` when the system is
 * numerically singular (near-planar/near-collinear local geometry), in
 * which case the caller falls back to the least-bad of the edge's two
 * endpoints or their midpoint.
 */
function solveOptimalPoint(
  q: Float64Array,
): readonly [number, number, number] | undefined {
  const q11 = q[0]!;
  const q12 = q[1]!;
  const q13 = q[2]!;
  const q14 = q[3]!;
  const q22 = q[4]!;
  const q23 = q[5]!;
  const q24 = q[6]!;
  const q33 = q[7]!;
  const q34 = q[8]!;
  const det =
    q11 * (q22 * q33 - q23 * q23) -
    q12 * (q12 * q33 - q23 * q13) +
    q13 * (q12 * q23 - q22 * q13);
  const scale = Math.max(Math.abs(q11), Math.abs(q22), Math.abs(q33), 1);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-9 * scale * scale * scale) {
    return undefined;
  }
  const invDet = 1 / det;
  const b1 = -q14;
  const b2 = -q24;
  const b3 = -q34;
  const x =
    invDet *
    (b1 * (q22 * q33 - q23 * q23) -
      q12 * (b2 * q33 - q23 * b3) +
      q13 * (b2 * q23 - q22 * b3));
  const y =
    invDet *
    (q11 * (b2 * q33 - q23 * b3) -
      b1 * (q12 * q33 - q23 * q13) +
      q13 * (q12 * b3 - b2 * q13));
  const z =
    invDet *
    (q11 * (q22 * b3 - b2 * q23) -
      q12 * (q12 * b3 - b2 * q13) +
      b1 * (q12 * q23 - q22 * q13));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return undefined;
  }
  return [x, y, z];
}

function weldedTriangleArea(
  x: readonly number[],
  y: readonly number[],
  z: readonly number[],
  ia: number,
  ib: number,
  ic: number,
): number {
  const normal = rawNormal(
    x[ia]!,
    y[ia]!,
    z[ia]!,
    x[ib]!,
    y[ib]!,
    z[ib]!,
    x[ic]!,
    y[ic]!,
    z[ic]!,
  );
  return Math.hypot(normal[0], normal[1], normal[2]) / 2;
}

function intersectSet(
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
): Set<number> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const result = new Set<number>();
  for (const v of small) {
    if (large.has(v)) result.add(v);
  }
  return result;
}

function intersectCount(
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const v of small) {
    if (large.has(v)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Deterministic binary min-heap
// ---------------------------------------------------------------------------

interface HeapEntry {
  readonly error: number;
  readonly v1: number;
  readonly v2: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly targetZ: number;
  readonly v1Version: number;
  readonly v2Version: number;
  readonly seq: number;
}

/**
 * Strict total order: ascending error, then ascending canonical vertex-id
 * pair (`v1`, then `v2`), then insertion sequence. Because `(v1, v2)`
 * uniquely identifies an undirected edge and `seq` is a strictly increasing
 * counter, no two entries ever compare equal -- so this heap's pop sequence
 * is a fixed function of the sequence of pushes, independent of internal
 * array-shape details.
 */
function compareHeapEntry(a: HeapEntry, b: HeapEntry): number {
  return a.error - b.error || a.v1 - b.v1 || a.v2 - b.v2 || a.seq - b.seq;
}

class BinaryHeap<T> {
  readonly #items: T[] = [];
  readonly #compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.#compare = compare;
  }

  push(item: T): void {
    this.#items.push(item);
    this.#siftUp(this.#items.length - 1);
  }

  pop(): T | undefined {
    if (this.#items.length === 0) return undefined;
    const top = this.#items[0]!;
    const last = this.#items.pop()!;
    if (this.#items.length > 0) {
      this.#items[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  /** Drains every entry in arbitrary (unsorted) array order, emptying the heap. Used only to rebuild a filtered heap once boundary status is fully known. */
  drain(): readonly T[] {
    const items = this.#items.slice();
    this.#items.length = 0;
    return items;
  }

  #siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#compare(this.#items[i]!, this.#items[parent]!) >= 0) break;
      this.#swap(i, parent);
      i = parent;
    }
  }

  #siftDown(index: number): void {
    let i = index;
    const n = this.#items.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (
        left < n &&
        this.#compare(this.#items[left]!, this.#items[smallest]!) < 0
      ) {
        smallest = left;
      }
      if (
        right < n &&
        this.#compare(this.#items[right]!, this.#items[smallest]!) < 0
      ) {
        smallest = right;
      }
      if (smallest === i) break;
      this.#swap(i, smallest);
      i = smallest;
    }
  }

  #swap(i: number, j: number): void {
    const tmp = this.#items[i]!;
    this.#items[i] = this.#items[j]!;
    this.#items[j] = tmp;
  }
}

// ---------------------------------------------------------------------------
// Certification: sampled surface deviation, both directions
// ---------------------------------------------------------------------------

/** Charged per triangle sampled during certification; mirrors `DIRECTIONAL_TRIANGLE_WORK_UNITS` in `src/analyze.ts` -- the identical vertices-plus-centroid sampling pass. */
const CERTIFICATION_TRIANGLE_WORK_UNITS = 8;

function certifyDeviation(
  original: FlatGeometry,
  simplified: FlatGeometry,
  work: WorkUnitCounter,
): SimplificationCertification {
  const originalIndex = new TriangleSpatialIndex(original, work);
  const simplifiedIndex = new TriangleSpatialIndex(simplified, work);
  const originalToSimplified = directionalDeviation(
    original,
    simplifiedIndex,
    work,
  );
  const simplifiedToOriginal = directionalDeviation(
    simplified,
    originalIndex,
    work,
  );
  return {
    method: {
      id: CERTIFICATION_METHOD_ID,
      version: CERTIFICATION_METHOD_VERSION,
    },
    semantics: "approximate-sampled-bound",
    originalToSimplified,
    simplifiedToOriginal,
    maximumDistanceMillimetres: Math.max(
      originalToSimplified.maximumDistanceMillimetres,
      simplifiedToOriginal.maximumDistanceMillimetres,
    ),
    meanDistanceMillimetres:
      (originalToSimplified.meanDistanceMillimetres +
        simplifiedToOriginal.meanDistanceMillimetres) /
      2,
    sampleSpacingUpperBoundMillimetres: Math.max(
      originalToSimplified.sampleSpacingUpperBoundMillimetres,
      simplifiedToOriginal.sampleSpacingUpperBoundMillimetres,
    ),
    disclaimer: CERTIFICATION_DISCLAIMER,
  };
}

function directionalDeviation(
  source: FlatGeometry,
  target: TriangleSpatialIndex,
  work: WorkUnitCounter,
): DirectionalDeviation {
  const triangleCount = source.triangleCount;
  work.charge(triangleCount * CERTIFICATION_TRIANGLE_WORK_UNITS);
  const positions = source.positions;
  const indices = source.indices;

  let maxDistance = -Infinity;
  let sumDistance = 0;
  let maxLongestEdge = 0;
  let worstX = 0;
  let worstY = 0;
  let worstZ = 0;
  let worstTriangle = 0;

  for (let t = 0; t < triangleCount; t += 1) {
    const base = t * 3;
    const ia = indices[base]!;
    const ib = indices[base + 1]!;
    const ic = indices[base + 2]!;
    const ax = positions[ia * 3]!;
    const ay = positions[ia * 3 + 1]!;
    const az = positions[ia * 3 + 2]!;
    const bx = positions[ib * 3]!;
    const by = positions[ib * 3 + 1]!;
    const bz = positions[ib * 3 + 2]!;
    const cx = positions[ic * 3]!;
    const cy = positions[ic * 3 + 1]!;
    const cz = positions[ic * 3 + 2]!;
    const centroidX = (ax + bx + cx) / 3;
    const centroidY = (ay + by + cy) / 3;
    const centroidZ = (az + bz + cz) / 3;

    const edgeAB = Math.hypot(bx - ax, by - ay, bz - az);
    const edgeBC = Math.hypot(cx - bx, cy - by, cz - bz);
    const edgeCA = Math.hypot(ax - cx, ay - cy, az - cz);
    const longestEdge = Math.max(edgeAB, edgeBC, edgeCA);
    if (longestEdge > maxLongestEdge) maxLongestEdge = longestEdge;

    work.charge(1);
    const distanceA = target.distance(ax, ay, az, work);
    work.charge(1);
    const distanceB = target.distance(bx, by, bz, work);
    work.charge(1);
    const distanceC = target.distance(cx, cy, cz, work);
    work.charge(1);
    const distanceCentroid = target.distance(
      centroidX,
      centroidY,
      centroidZ,
      work,
    );

    sumDistance += distanceA + distanceB + distanceC + distanceCentroid;

    if (distanceA > maxDistance) {
      maxDistance = distanceA;
      worstX = ax;
      worstY = ay;
      worstZ = az;
      worstTriangle = t;
    }
    if (distanceB > maxDistance) {
      maxDistance = distanceB;
      worstX = bx;
      worstY = by;
      worstZ = bz;
      worstTriangle = t;
    }
    if (distanceC > maxDistance) {
      maxDistance = distanceC;
      worstX = cx;
      worstY = cy;
      worstZ = cz;
      worstTriangle = t;
    }
    if (distanceCentroid > maxDistance) {
      maxDistance = distanceCentroid;
      worstX = centroidX;
      worstY = centroidY;
      worstZ = centroidZ;
      worstTriangle = t;
    }
  }

  const sampleCount = triangleCount * 4;
  const sampleSpacingUpperBoundMillimetres =
    triangleCount === 0
      ? Number.POSITIVE_INFINITY
      : SAMPLE_SPACING_EDGE_FACTOR * maxLongestEdge;

  return {
    semantics: "approximate-sampled",
    maximumDistanceMillimetres: normalizeZero(
      triangleCount === 0 ? 0 : maxDistance,
    ),
    meanDistanceMillimetres:
      sampleCount > 0 ? normalizeZero(sumDistance / sampleCount) : 0,
    sampleSpacingUpperBoundMillimetres,
    worstSampleMillimetres: [
      normalizeZero(worstX),
      normalizeZero(worstY),
      normalizeZero(worstZ),
    ],
    worstSampleSourceTriangleIndex: worstTriangle,
    sampledTriangleCount: triangleCount,
  };
}

// ---------------------------------------------------------------------------
// Output model construction
// ---------------------------------------------------------------------------

function buildSimplifiedModel(
  source: NormalizedModel,
  geometry: FlatGeometry,
): NormalizedModel {
  const modelId = `${source.id}.simplified`;
  const meshId = `${source.id}.simplified.mesh`;
  const instanceId = `${source.id}.simplified.instance`;
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id: modelId,
    frame: source.frame,
    meshes: [
      {
        id: meshId,
        geometry: {
          positions: geometry.positions,
          indices: geometry.indices,
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [{ id: instanceId, meshId, meshToModel: IDENTITY_MAT4 }],
    },
    warnings: [],
    provenance: {
      formatId: "voxelspy-simplified-mesh",
      importerId: SIMPLIFY_METHOD_ID,
      importerVersion: SIMPLIFY_METHOD_VERSION,
      sourceName: `${source.provenance.sourceName} (simplified)`,
      detectedSourceUnit: source.provenance.detectedSourceUnit,
      detectedSourceAxis: source.provenance.detectedSourceAxis,
      sourceUnit: source.provenance.sourceUnit,
      sourceAxis: source.provenance.sourceAxis,
      sourceResolution: source.provenance.sourceResolution,
      appliedSourceToModel: source.provenance.appliedSourceToModel,
      notes: [
        `Decimated by ${SIMPLIFY_METHOD_ID} ${SIMPLIFY_METHOD_VERSION} from model "${String(source.id)}"; certified deviation is reported separately on the SimplificationResult that produced this model, not embedded here.`,
      ],
    },
  });
}
