import {
  analysisRequestSchema,
  analysisResultSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type {
  AnalysisRequest,
  AnalysisResult,
  Mat4,
  MeshAssessment,
  NormalizedModel,
  Vec3,
} from "@voxelspy/contracts";

import {
  countExpandedGeometry,
  flattenModel,
  triangleAreaAt,
  triangleCentroidAt,
} from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";
import {
  canonicalEdgeKey,
  exactEdgeKeyAt,
  groupTrianglesByExactEdgeConnectivity,
  pointKeyAt,
} from "./region-connectivity.js";
import {
  NumericRangeExceededError,
  TriangleSpatialIndex,
} from "./spatial-index.js";

export interface AnalysisResourceLimits {
  readonly maxExpandedVertices: number;
  readonly maxExpandedTriangles: number;
  readonly maxWorkUnits: number;
  readonly maxMemoryBytes: number;
  readonly maxReportedRegions: number;
}

/**
 * Safety ceilings for this implementation, not release-size claims.
 *
 * `maxWorkUnits` is calibrated so the documented `maxExpandedTriangles`
 * ceiling is actually reachable, not just declared: measured against the
 * scaling benchmark tiers (`bench/scaling.mjs`, including its `--large`
 * documented-ceiling tier), a pair totalling the documented 1,000,000
 * combined triangles charges roughly 1.91 billion work units to complete
 * `surface-distance` end to end, in well under a minute of wall-clock time
 * and comfortably inside `maxMemoryBytes`. 2,200,000,000 keeps roughly 15%
 * margin above that measured figure for geometry that prunes the spatial
 * index somewhat less effectively than the benchmark's terrain shape,
 * without weakening the fail-closed behavior charged work still enforces:
 * a caller-supplied budget smaller than what a request needs continues to
 * fail closed as `resource-budget-exceeded` before the corresponding pass
 * runs, exactly as before.
 */
export const ANALYSIS_LIMITS: AnalysisResourceLimits = Object.freeze({
  maxExpandedVertices: 3_000_000,
  maxExpandedTriangles: 1_000_000,
  maxWorkUnits: 2_200_000_000,
  maxMemoryBytes: 768 * 1024 * 1024,
  maxReportedRegions: 2_048,
});

/**
 * Per-element memory accounting for the flattened comparison frame and the
 * working structures built from it, used only to reject requests before
 * allocating anything. `checkResourceBudget` applies this to the combined
 * baseline + candidate vertex and triangle counts.
 *
 * This is a structural safety-margin estimate, not a literal prediction of
 * every possible `process.memoryUsage().heapUsed` sample. Its exact
 * structural baseline -- the data this implementation actually references
 * while a comparison runs -- is:
 *
 *  - 24 bytes/vertex: Float64Array positions (3 * 8 bytes), exact.
 *  - 12 bytes/triangle: Uint32Array indices (3 * 4 bytes), exact.
 *  - ~48 bytes/triangle: TriangleSpatialIndex construction-time working
 *    arrays (per-triangle AABB, centroid, Morton code, and sort-order
 *    typed arrays) -- transient, freed once the index is built.
 *  - ~48 bytes/triangle: BVH node storage (roughly one node per
 *    LEAF_TRIANGLE_COUNT triangles at the leaves, doubling for internal
 *    nodes, each node six bounds numbers plus bookkeeping).
 *  - ~24 bytes/triangle: directional deviation tracking (a changed flag
 *    plus maximum/mean distance per triangle, held as typed arrays for one
 *    directional pass).
 *  - ~168 bytes/triangle: worst-case string-keyed edge maps -- up to three
 *    Map entries per triangle across assessGeometry's manifold census and
 *    the ranking phase's exact-edge connectivity map, each entry costing a
 *    JS string key, a small value object, and V8 Map bucket overhead.
 *
 * Structural baseline: 24 bytes/vertex + 300 bytes/triangle
 * (12 + 48 + 48 + 24 + 168).
 *
 * This estimate is deliberately a relative/structural cost model with a
 * stated safety margin, not a byte-exact prediction that every possible
 * single-sample `heapUsed` reading will stay under. Measurement showed a
 * byte-exact-prediction reading of these constants cannot be honored
 * without either breaking the documented ceilings or rejecting geometry
 * this package already accepts, for two independent, measured reasons:
 *
 *  1. Shape dependence. Vertex-to-triangle ratio varies enormously with
 *     mesh representation for the *same* triangle count: an indexed mesh
 *     (shared vertices, as `bench/scaling.mjs`'s terrain tiles use) has
 *     roughly 0.5 vertices per triangle, while a facet-local mesh (one
 *     private vertex copy per triangle corner, the representation binary
 *     STL import commonly produces -- see the "Topology semantics" section
 *     of ../README.md) has exactly 3, a 6x difference in vertex count at
 *     identical triangle count. A per-element multiplier large enough to
 *     stay conservative against the terrain benchmark's measured heap at
 *     its ~400,000-combined-triangle tier (roughly 230 MiB measured against
 *     a ~180 MiB estimate at these constants) would, applied to a
 *     facet-local pair of that same triangle count, push the estimate for
 *     an existing accepted test case (`test/analyze.test.ts`, "accepts
 *     ordinary facet-local models above the former vertex ceiling") past
 *     its 128 MiB request budget -- rejecting geometry this package
 *     currently, correctly, accepts.
 *  2. GC-timing noise. Repeated runs of byte-identical, deterministic
 *     geometry (`bench/scaling.mjs`) show single-sample, un-forced-GC
 *     `heapUsed` deltas varying by up to roughly 4x at the same input size
 *     (for example 23-92 MiB observed across repeated runs at the same
 *     ~100,000-combined-triangle tier). That spread tracks V8
 *     garbage-collector scheduling within one synchronous call, not a
 *     stable per-vertex/per-triangle cost.
 *
 * Either reason alone rules out a multiplier chosen to dominate every
 * single-sample small/mid-scale reading: this package's worst-case
 * documented combination -- 3,000,000 vertices (the facet-local case) at
 * 1,000,000 triangles -- must still fit under `ANALYSIS_LIMITS.maxMemoryBytes`
 * (768 MiB). The exported constants below apply a stated 1.5x margin over
 * the structural baseline (36 bytes/vertex, 450 bytes/triangle): at that
 * margin the worst-case documented combination estimates to ~532 MiB (31%
 * headroom), while a margin near the ~2.2x some single-sample mid-scale
 * readings would need already estimates to ~781 MiB, over budget on its
 * own. Below the scale where the memory ceiling's protection is actually
 * load-bearing, the absolute byte counts involved (single-digit to low
 * tens of MiB) are far short of anything that threatens a browser tab
 * regardless of the ratio; measured raw memory at and near the documented
 * ceiling -- where it matters -- stays comfortably under this estimate. See
 * the "Resource behavior" section of ../README.md and the benchmark's
 * memory table for the underlying numbers.
 */
const BYTES_PER_VERTEX = 36;
const BYTES_PER_TRIANGLE = 450;

export const SURFACE_DISTANCE_METHOD = Object.freeze({
  id: "surface-distance",
  version: "1.0.0",
  parameters: Object.freeze({}),
});

export const AXIS_ALIGNED_BOX_METHOD = Object.freeze({
  id: "axis-aligned-box-solid",
  version: "1.0.0",
  parameters: Object.freeze({}),
});

export interface AnalysisMethodCapability {
  readonly id: string;
  readonly version: string;
  readonly resultSemantics:
    "approximate" | "exact-within-validated-preconditions";
  readonly requiredPreconditions: readonly string[];
  readonly parameterShape: Readonly<Record<string, string>>;
}

const METHOD_CAPABILITIES: readonly AnalysisMethodCapability[] = Object.freeze([
  Object.freeze({
    id: SURFACE_DISTANCE_METHOD.id,
    version: SURFACE_DISTANCE_METHOD.version,
    resultSemantics: "approximate" as const,
    requiredPreconditions: Object.freeze([
      "non-empty-triangles",
      "non-degenerate-triangles",
    ]),
    parameterShape: Object.freeze({
      maxRegions: "optional positive integer, at most 2048",
    }),
  }),
  Object.freeze({
    id: AXIS_ALIGNED_BOX_METHOD.id,
    version: AXIS_ALIGNED_BOX_METHOD.version,
    resultSemantics: "exact-within-validated-preconditions" as const,
    requiredPreconditions: Object.freeze([
      "closed",
      "consistently-oriented",
      "axis-aligned-box",
    ]),
    parameterShape: Object.freeze({}),
  }),
]);

export function supportedAnalysisMethods(): readonly AnalysisMethodCapability[] {
  return METHOD_CAPABILITIES;
}

export interface AnalysisInput {
  readonly request: AnalysisRequest;
  readonly baseline: NormalizedModel;
  readonly candidate: NormalizedModel;
}

export function analyzeModelPair(input: AnalysisInput): AnalysisResult {
  const request = analysisRequestSchema.parse(input.request);
  const baseline = normalizedModelSchema.parse(input.baseline);
  const candidate = normalizedModelSchema.parse(input.candidate);

  if (
    baseline.id !== request.baseline.modelId ||
    candidate.id !== request.candidate.modelId
  ) {
    return indeterminate(request, "model-binding-mismatch", [
      "The supplied models do not match the request bindings.",
    ]);
  }

  const capability = METHOD_CAPABILITIES.find(
    ({ id, version }) =>
      id === request.method.id && version === request.method.version,
  );
  if (capability === undefined) {
    return indeterminate(request, "unsupported-method", [
      `Method ${String(request.method.id)} version ${request.method.version} is not supported.`,
    ]);
  }

  const budgetProblem = checkResourceBudget(request, baseline, candidate);
  if (budgetProblem !== undefined) {
    return indeterminate(request, "resource-budget-exceeded", [budgetProblem]);
  }

  // Construct the work budget before any O(vertices + triangles)
  // preprocessing runs, and charge flattening and the manifold edge census
  // to it below, so a caller-supplied budget too small for that
  // preprocessing fails closed before it runs rather than after.
  const workLimit = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    request.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  const work = new WorkBudget(workLimit);

  let baselineGeometry: FlatGeometry;
  let candidateGeometry: FlatGeometry;
  let validation: readonly [MeshAssessment, MeshAssessment];
  try {
    baselineGeometry = flattenModel(
      baseline,
      request.baseline.modelToComparison,
      work,
    );
    candidateGeometry = flattenModel(
      candidate,
      request.candidate.modelToComparison,
      work,
    );
    validation = [
      assessGeometry(baseline.id, baselineGeometry, work),
      assessGeometry(candidate.id, candidateGeometry, work),
    ];
  } catch (error) {
    if (error instanceof WorkBudgetExceeded) {
      return indeterminate(request, "resource-budget-exceeded", [
        error.message,
      ]);
    }
    if (error instanceof WorkBudgetInternalError) throw error;
    return indeterminate(request, "comparison-transform-failed", [
      error instanceof Error ? error.message : "Comparison transform failed.",
    ]);
  }

  if (capability.id === SURFACE_DISTANCE_METHOD.id) {
    return analyzeSurfaceDistance(
      request,
      baselineGeometry,
      candidateGeometry,
      validation,
      work,
    );
  }
  return analyzeAxisAlignedBoxes(
    request,
    baselineGeometry,
    candidateGeometry,
    validation,
  );
}

function checkResourceBudget(
  request: AnalysisRequest,
  baseline: NormalizedModel,
  candidate: NormalizedModel,
): string | undefined {
  const first = countExpandedGeometry(baseline);
  const second = countExpandedGeometry(candidate);
  return checkExpandedGeometryBudget(
    first.vertices + second.vertices,
    first.triangles + second.triangles,
    request.executionBudget,
  );
}

/**
 * Checks combined expanded vertex/triangle counts and estimated working
 * memory (`BYTES_PER_VERTEX`/`BYTES_PER_TRIANGLE` above) against
 * `ANALYSIS_LIMITS`, honoring an optional caller-supplied memory budget no
 * larger than `ANALYSIS_LIMITS.maxMemoryBytes`. Returns a human-readable
 * problem description, or `undefined` when the combination fits.
 *
 * Shared by `analyzeModelPair`'s `checkResourceBudget` above and
 * `checkClearance`'s own pre-flight check (`src/clearance.ts`), so every
 * two-model entry point in this package enforces identical ceilings from one
 * implementation rather than two copies of the same arithmetic.
 */
export function checkExpandedGeometryBudget(
  vertices: number,
  triangles: number,
  executionBudget?: { readonly maxMemoryBytes?: number },
): string | undefined {
  if (vertices > ANALYSIS_LIMITS.maxExpandedVertices) {
    return `Expanded geometry requires ${vertices} vertices; the implementation ceiling is ${ANALYSIS_LIMITS.maxExpandedVertices}.`;
  }
  if (triangles > ANALYSIS_LIMITS.maxExpandedTriangles) {
    return `Expanded geometry requires ${triangles} triangles; the implementation ceiling is ${ANALYSIS_LIMITS.maxExpandedTriangles}.`;
  }
  const estimatedMemory =
    vertices * BYTES_PER_VERTEX + triangles * BYTES_PER_TRIANGLE;
  const memoryBudget = Math.min(
    ANALYSIS_LIMITS.maxMemoryBytes,
    executionBudget?.maxMemoryBytes ?? ANALYSIS_LIMITS.maxMemoryBytes,
  );
  if (
    !Number.isSafeInteger(estimatedMemory) ||
    estimatedMemory > memoryBudget
  ) {
    return `Estimated analysis memory is ${estimatedMemory} bytes; the active budget is ${memoryBudget} bytes.`;
  }
  return undefined;
}

/**
 * Charged per triangle in the edge census below. The census keys edges by
 * exact vertex COORDINATE (see `pointKeyAt`/`canonicalEdgeKey`), consistent
 * with region connectivity and `summarizeModelGeometry`: it builds one
 * coordinate-string key per triangle corner (three Float64 reads plus a
 * string join, done once per corner and reused for both edges touching that
 * corner) and one canonicalized edge key plus a Map lookup/write per edge.
 * That coordinate-string construction costs materially more than the
 * previous raw-index keying (integer min/max), so this is charged higher
 * than a plain three-Map-operations estimate would suggest.
 */
const EDGE_CENSUS_TRIANGLE_WORK_UNITS = 12;
/**
 * Preprocessing charges (here and in `flattenModel`) are applied in chunks
 * of this many elements, not per element (millions of `charge` calls would
 * add overhead) and not as one lump sum for the whole geometry (a budget
 * that can only cover part of the census should still fail partway through
 * rather than after the fact).
 */
const PREPROCESSING_CHUNK_ELEMENTS = 1024;

/**
 * Assesses closedness, orientation consistency, and degeneracy from
 * `geometry`'s own triangle data.
 *
 * The edge census below keys each triangle edge by its two endpoints' exact
 * vertex COORDINATES (`pointKeyAt`/`canonicalEdgeKey`), not by raw vertex
 * index -- the same exact-coordinate approach used by region connectivity
 * (`exactEdgeKeyAt` below) and by `summarizeModelGeometry` in summary.ts.
 * Two triangle corners connect if and only if their coordinates are
 * bit-for-bit identical; no tolerance welding is performed. This means a
 * facet-local mesh (one private vertex copy per triangle corner, as binary
 * STL import commonly produces) is recognized as closed when its duplicated
 * corners coincide exactly, matching what `summarizeModelGeometry` already
 * reports for the same input. It also means index-level topology (whether
 * two triangles happen to share a vertex INDEX) is not what this reports.
 */
export function assessGeometry(
  modelId: NormalizedModel["id"],
  geometry: FlatGeometry,
  work: WorkUnitCounter,
): MeshAssessment {
  const edges = new Map<string, { forward: number; reverse: number }>();
  let degenerateTriangleCount = 0;
  const triangleCount = geometry.triangleCount;
  for (
    let chunkStart = 0;
    chunkStart < triangleCount;
    chunkStart += PREPROCESSING_CHUNK_ELEMENTS
  ) {
    const chunkEnd = Math.min(
      chunkStart + PREPROCESSING_CHUNK_ELEMENTS,
      triangleCount,
    );
    work.charge((chunkEnd - chunkStart) * EDGE_CENSUS_TRIANGLE_WORK_UNITS);
    for (let triangle = chunkStart; triangle < chunkEnd; triangle += 1) {
      const area = triangleAreaAt(geometry, triangle);
      if (!(area > 0) || !Number.isFinite(area)) {
        degenerateTriangleCount += 1;
      }
      const base = triangle * 3;
      const a = geometry.indices[base]!;
      const b = geometry.indices[base + 1]!;
      const c = geometry.indices[base + 2]!;
      const keyA = pointKeyAt(geometry, a);
      const keyB = pointKeyAt(geometry, b);
      const keyC = pointKeyAt(geometry, c);
      addEdge(edges, keyA, keyB);
      addEdge(edges, keyB, keyC);
      addEdge(edges, keyC, keyA);
    }
  }
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let inconsistentEdgeCount = 0;
  for (const edge of edges.values()) {
    const total = edge.forward + edge.reverse;
    if (total === 1) boundaryEdgeCount += 1;
    else if (total > 2) nonManifoldEdgeCount += 1;
    else if (edge.forward !== 1 || edge.reverse !== 1) {
      inconsistentEdgeCount += 1;
    }
  }
  const reasons: string[] = [];
  const preconditions: Array<{
    id: string;
    passed: true;
    details?: Record<string, number>;
  }> = [];
  if (geometry.triangleCount === 0) reasons.push("empty-geometry");
  else preconditions.push({ id: "non-empty-triangles", passed: true });
  if (degenerateTriangleCount > 0) reasons.push("degenerate-triangles");
  else preconditions.push({ id: "non-degenerate-triangles", passed: true });
  if (boundaryEdgeCount > 0) reasons.push("boundary-edges");
  else if (nonManifoldEdgeCount === 0) {
    preconditions.push({ id: "closed", passed: true });
  }
  if (nonManifoldEdgeCount > 0) reasons.push("non-manifold-edges");
  if (inconsistentEdgeCount > 0) reasons.push("inconsistent-orientation");
  else if (nonManifoldEdgeCount === 0) {
    preconditions.push({ id: "consistently-oriented", passed: true });
  }
  return {
    modelId,
    closed: boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0,
    consistentlyOriented:
      inconsistentEdgeCount === 0 && nonManifoldEdgeCount === 0,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
    reasons,
    preconditions,
  } as MeshAssessment;
}

function addEdge(
  edges: Map<string, { forward: number; reverse: number }>,
  fromKey: string,
  toKey: string,
): void {
  const { key, forward } = canonicalEdgeKey(fromKey, toKey);
  const edge = edges.get(key) ?? { forward: 0, reverse: 0 };
  if (forward) edge.forward += 1;
  else edge.reverse += 1;
  edges.set(key, edge);
}

function analyzeSurfaceDistance(
  request: AnalysisRequest,
  baseline: FlatGeometry,
  candidate: FlatGeometry,
  validation: readonly [MeshAssessment, MeshAssessment],
  work: WorkUnitCounter,
): AnalysisResult {
  const parameterResult = surfaceParameters(request.method.parameters);
  if (typeof parameterResult === "string") {
    return indeterminate(
      request,
      "invalid-method-parameters",
      [parameterResult],
      validation,
    );
  }
  const tolerance = request.tolerance.distanceMillimetres;
  if (tolerance === undefined) {
    return indeterminate(
      request,
      "distance-tolerance-required",
      ["Surface distance requires a distance tolerance in millimetres."],
      validation,
    );
  }
  const invalid = validation.flatMap((assessment) =>
    assessment.reasons.filter(
      (reason) =>
        reason === "empty-geometry" || reason === "degenerate-triangles",
    ),
  );
  if (invalid.length > 0) {
    return indeterminate(
      request,
      "surface-precondition-failed",
      [`Surface distance preconditions failed: ${unique(invalid).join(", ")}.`],
      validation,
    );
  }
  try {
    const baselineIndex = new TriangleSpatialIndex(baseline, work);
    const candidateIndex = new TriangleSpatialIndex(candidate, work);
    const removedPass = directionalRegions(
      baseline,
      candidateIndex,
      "removed",
      tolerance,
      work,
    );
    const addedPass = directionalRegions(
      candidate,
      baselineIndex,
      "added",
      tolerance,
      work,
    );
    const removed = removedPass.regions;
    const added = addedPass.regions;
    const ranked = [...removed, ...added].sort(compareSurfaceRegion);
    const reported = ranked.slice(0, parameterResult.maxRegions);
    const truncated = reported.length !== ranked.length;

    // Worst-case distance from any point on an analyzed triangle to the
    // nearest of its four samples (three vertices plus centroid), derived
    // from that triangle's longest edge -- see `SAMPLE_SPACING_EDGE_FACTOR`.
    // Reported per model (the pass over each model's own triangles already
    // ran above for sampling, so this piggybacks on it rather than adding a
    // new full pass) and as the pair maximum used for the undersampled
    // check, since either direction's blind spot is governed by its own
    // source model's tessellation.
    const baselineMaxSampleSpacing =
      removedPass.maxLongestEdge * SAMPLE_SPACING_EDGE_FACTOR;
    const candidateMaxSampleSpacing =
      addedPass.maxLongestEdge * SAMPLE_SPACING_EDGE_FACTOR;
    const maxSampleSpacing = Math.max(
      baselineMaxSampleSpacing,
      candidateMaxSampleSpacing,
    );
    const undersampled = maxSampleSpacing > tolerance;

    const warnings = [
      ...(truncated
        ? [
            {
              code: "analysis.region-limit",
              severity: "warning" as const,
              message: `${ranked.length - reported.length} lower-ranked changed regions were omitted by the requested region limit.`,
              details: {
                detectedRegionCount: ranked.length,
                reportedRegionCount: reported.length,
              },
            },
          ]
        : []),
      ...(undersampled
        ? [
            {
              code: "analysis.surface-distance-undersampled",
              severity: "warning" as const,
              message: `The sample spacing bound (${maxSampleSpacing} mm, derived from the coarsest analyzed triangle edges) exceeds the requested distance tolerance (${tolerance} mm); features entirely interior to a coarse triangle can be missed without being reported as a region.`,
              details: {
                maxSampleSpacingMillimetres: maxSampleSpacing,
                baselineMaxSampleSpacingMillimetres: baselineMaxSampleSpacing,
                candidateMaxSampleSpacingMillimetres: candidateMaxSampleSpacing,
                toleranceMillimetres: tolerance,
              },
            },
          ]
        : []),
    ];
    const metrics: Array<{
      id: string;
      value: number;
      unit: "millimetre" | "square-millimetre" | "ratio" | "count";
    }> = [
      {
        id: "surface.maximum-distance",
        value: ranked.reduce(
          (maximum, region) => Math.max(maximum, region.maximumDistance),
          0,
        ),
        unit: "millimetre",
      },
      {
        id: "surface.changed-area",
        value: ranked.reduce((sum, region) => sum + region.area, 0),
        unit: "square-millimetre",
      },
      {
        id: "surface.changed-region-count",
        value: ranked.length,
        unit: "count",
      },
      {
        id: "surface.reported-region-count",
        value: reported.length,
        unit: "count",
      },
    ];
    const regions = reported.map((region) => {
      const prefix = region.id;
      metrics.push(
        {
          id: `${prefix}.maximum-distance`,
          value: region.maximumDistance,
          unit: "millimetre",
        },
        {
          id: `${prefix}.mean-distance`,
          value: region.meanDistance,
          unit: "millimetre",
        },
        {
          id: `${prefix}.area`,
          value: region.area,
          unit: "square-millimetre",
        },
        {
          id: `${prefix}.triangle-count`,
          value: region.triangleCount,
          unit: "count",
        },
      );
      return {
        id: region.id,
        frame: "comparison" as const,
        category: region.category,
        bounds: region.bounds,
        anchor: region.anchor,
        geometry: {
          kind: "triangle-set" as const,
          model: region.category === "added" ? "candidate" : "baseline",
          triangleIndices: [...region.triangleIndices],
        },
        metricIds: [
          `${prefix}.maximum-distance`,
          `${prefix}.mean-distance`,
          `${prefix}.area`,
          `${prefix}.triangle-count`,
        ],
        warningCodes: [],
      };
    });
    return analysisResultSchema.parse({
      contractVersion: 1,
      requestId: request.requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings,
      outcome: {
        state: "complete",
        semantics: "approximate",
        requestedMethod: request.method,
        effectiveMethod: request.method,
        requestedTolerance: request.tolerance,
        effectiveTolerance: request.tolerance,
        validation,
        metrics,
        regions,
        orderedRegionIds: regions.map(({ id }) => id),
        adjustments: [],
        uncertainty: {
          description:
            "Distances use finite vertex and triangle-centroid samples against the opposite tessellated surface. Extrema between samples can be missed, and results depend on tessellation. For each analyzed triangle, the farthest point on that triangle from its nearest sample is at most two-thirds of that triangle's longest edge; the largest such bound across each model's triangles is reported below as its sample spacing. When that spacing exceeds the requested tolerance, features confined to a single coarse triangle's interior can be missed entirely, with no reported region and no defect in the tolerance value itself.",
          parameters: {
            sampling: "vertices-and-triangle-centroids",
            distanceToleranceMillimetres: tolerance,
            maxRegions: parameterResult.maxRegions,
            omittedRegionCount: ranked.length - reported.length,
            maxSampleSpacingMillimetres: maxSampleSpacing,
            baselineMaxSampleSpacingMillimetres: baselineMaxSampleSpacing,
            candidateMaxSampleSpacingMillimetres: candidateMaxSampleSpacing,
            toleranceMillimetres: tolerance,
            undersampled,
          },
        },
      },
    });
  } catch (error) {
    if (error instanceof WorkBudgetExceeded) {
      return indeterminate(
        request,
        "resource-budget-exceeded",
        [error.message],
        validation,
      );
    }
    if (error instanceof WorkBudgetInternalError) throw error;
    if (error instanceof NumericRangeExceededError) {
      return indeterminate(
        request,
        "numeric-range-exceeded",
        [error.message.slice(0, 950)],
        validation,
      );
    }
    // Any other exception here is not a numeric-range failure the code
    // detected -- it is an unexpected defect (a reachable invariant
    // violation, a bug in a dependency, and so on). Reporting it as
    // `numeric-range-exceeded` would misattribute the cause to input
    // magnitude and hide the real problem, so it gets a distinct code
    // instead while still failing closed with no result.
    return indeterminate(
      request,
      "internal-error",
      [
        error instanceof Error
          ? error.message.slice(0, 950)
          : "Surface distance failed with an unexpected error.",
      ],
      validation,
    );
  }
}

interface SurfaceParameters {
  readonly maxRegions: number;
}

function surfaceParameters(
  parameters: Readonly<Record<string, unknown>>,
): SurfaceParameters | string {
  const keys = Object.keys(parameters);
  if (keys.some((key) => key !== "maxRegions")) {
    return "Surface distance received an unknown method parameter.";
  }
  const value = parameters.maxRegions ?? ANALYSIS_LIMITS.maxReportedRegions;
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value > ANALYSIS_LIMITS.maxReportedRegions
  ) {
    return `maxRegions must be a positive integer no greater than ${ANALYSIS_LIMITS.maxReportedRegions}.`;
  }
  return { maxRegions: value };
}

interface RankedSurfaceRegion {
  readonly id: string;
  readonly category: "added" | "removed";
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly anchor: Vec3;
  readonly maximumDistance: number;
  readonly meanDistance: number;
  readonly area: number;
  readonly triangleCount: number;
  readonly triangleIndices: readonly number[];
}

const DIRECTIONAL_TRIANGLE_WORK_UNITS = 8;

/**
 * Bounds the worst-case distance from any point on a triangle to the
 * nearest of its four samples (three vertices plus the centroid), as a
 * fraction of that triangle's longest edge `L`.
 *
 * Derivation: the centroid `G` is always inside the (closed, convex)
 * triangle. Distance from the fixed point `G` to a point constrained to a
 * convex region is a convex function of that point, so its maximum over the
 * triangle is attained at one of the three vertices -- i.e. the farthest any
 * point on the triangle can be from the centroid is
 * `max(|GA|, |GB|, |GC|)`. Each of those is two-thirds of the corresponding
 * median (the centroid divides every median 2:1 from the vertex), and every
 * median of a triangle is at most its longest edge: for the median from
 * vertex A, `m_a = sqrt(2b^2 + 2c^2 - a^2) / 2 <= sqrt(2b^2 + 2c^2) / 2 <=
 * sqrt(4L^2) / 2 = L` since the two sides `b`, `c` adjacent to A are each at
 * most `L`, and symmetrically for the medians from B and C. So
 * `max(|GA|, |GB|, |GC|) <= (2/3) * L`, and therefore every point on the
 * triangle is within `(2/3) * L` of the centroid sample alone. Sampling the
 * three vertices in addition can only tighten this, never loosen it, so
 * `(2/3) * L` remains a true (if conservative -- the tight bound is smaller
 * for typical triangle shapes) upper bound on the distance from any point on
 * the triangle to its nearest sample.
 */
export const SAMPLE_SPACING_EDGE_FACTOR = 2 / 3;

interface DirectionalPassResult {
  readonly regions: RankedSurfaceRegion[];
  /** Longest edge length among this pass's source triangles, in millimetres. */
  readonly maxLongestEdge: number;
}

function directionalRegions(
  source: FlatGeometry,
  target: TriangleSpatialIndex,
  category: "added" | "removed",
  tolerance: number,
  work: WorkUnitCounter,
): DirectionalPassResult {
  const triangleCount = source.triangleCount;
  work.charge(triangleCount * DIRECTIONAL_TRIANGLE_WORK_UNITS);

  // Structure-of-arrays deviation tracking instead of one small object per
  // triangle: a changed flag plus the maximum and mean sampled distance,
  // computed from the triangle's three vertices and centroid.
  const changed = new Uint8Array(triangleCount);
  const maximumDistance = new Float64Array(triangleCount);
  const meanDistance = new Float64Array(triangleCount);

  const positions = source.positions;
  const indices = source.indices;
  let maxLongestEdge = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = triangle * 3;
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

    // Piggybacks on this existing per-triangle pass instead of adding one:
    // the vertex coordinates needed for edge lengths are already loaded
    // above for sampling.
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

    let maximum = distanceA;
    if (distanceB > maximum) maximum = distanceB;
    if (distanceC > maximum) maximum = distanceC;
    if (distanceCentroid > maximum) maximum = distanceCentroid;

    maximumDistance[triangle] = maximum;
    meanDistance[triangle] =
      (distanceA + distanceB + distanceC + distanceCentroid) / 4;
    changed[triangle] = maximum > tolerance ? 1 : 0;
  }

  const components = groupTrianglesByExactEdgeConnectivity(source, changed);

  const regions: RankedSurfaceRegion[] = [];
  for (const component of components) {
    const bounds = boundsOfTriangles(source, component);
    let anchorTriangle = component[0]!;
    for (const triangle of component) {
      if (maximumDistance[triangle]! > maximumDistance[anchorTriangle]!) {
        anchorTriangle = triangle;
      }
    }
    const serial = String(component[0]!).padStart(6, "0");
    let maximum = maximumDistance[component[0]!]!;
    let meanSum = 0;
    let areaSum = 0;
    for (const triangle of component) {
      const value = maximumDistance[triangle]!;
      if (value > maximum) maximum = value;
      meanSum += meanDistance[triangle]!;
      areaSum += triangleAreaAt(source, triangle);
    }
    regions.push({
      id: `region.surface.${category}.${serial}`,
      category,
      bounds,
      anchor: triangleCentroidAt(source, anchorTriangle),
      maximumDistance: maximum,
      meanDistance: meanSum / component.length,
      area: areaSum,
      triangleCount: component.length,
      triangleIndices: component,
    });
  }
  return { regions, maxLongestEdge };
}

function compareSurfaceRegion(
  left: RankedSurfaceRegion,
  right: RankedSurfaceRegion,
): number {
  return (
    right.maximumDistance - left.maximumDistance ||
    right.area - left.area ||
    categoryRank(left.category) - categoryRank(right.category) ||
    compareVec3(left.bounds.min, right.bounds.min) ||
    compareText(left.id, right.id)
  );
}

/** Legitimate, expected fail-closed outcome: the active budget ran out. */
export class WorkBudgetExceeded extends Error {
  constructor(limit: number, used: number, requested: number) {
    super(
      `Analysis exhausted the active budget of ${limit} work units after ${used} charged units; the next operation required ${requested} more.`,
    );
    this.name = "WorkBudgetExceeded";
  }
}

/**
 * A programming error, not an expected outcome: some call site tried to
 * charge a negative or non-integer number of work units. This is kept
 * distinct from `WorkBudgetExceeded` so it is never reported to a caller as
 * an ordinary "resource-budget-exceeded" result -- callers that catch only
 * `WorkBudgetExceeded` let this propagate, which still fails closed (no
 * result is returned) but surfaces the bug instead of masking it as a
 * routine budget exhaustion.
 */
export class WorkBudgetInternalError extends Error {
  constructor(units: number) {
    super(
      `WorkBudget.charge received invalid units (${String(units)}); charge amounts must be non-negative safe integers. This indicates an internal bug, not caller-supplied input.`,
    );
    this.name = "WorkBudgetInternalError";
  }
}

export class WorkBudget implements WorkUnitCounter {
  readonly #limit: number;
  #used = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  charge(units: number): void {
    if (!Number.isSafeInteger(units) || units < 0) {
      throw new WorkBudgetInternalError(units);
    }
    if (this.#used > this.#limit - units) {
      throw new WorkBudgetExceeded(this.#limit, this.#used, units);
    }
    this.#used += units;
  }
}

function analyzeAxisAlignedBoxes(
  request: AnalysisRequest,
  baseline: FlatGeometry,
  candidate: FlatGeometry,
  validation: readonly [MeshAssessment, MeshAssessment],
): AnalysisResult {
  if (Object.keys(request.method.parameters).length !== 0) {
    return indeterminate(
      request,
      "invalid-method-parameters",
      ["Axis-aligned box comparison does not accept method parameters."],
      validation,
    );
  }
  const baselineBox = validatedAxisAlignedBox(baseline, validation[0]);
  const candidateBox = validatedAxisAlignedBox(candidate, validation[1]);
  if (baselineBox === undefined || candidateBox === undefined) {
    return indeterminate(
      request,
      "solid-precondition-failed",
      [
        "Exact solid comparison requires each input to be one closed, consistently oriented, indexed axis-aligned box with eight corner vertices and twelve non-degenerate triangles.",
      ],
      validation,
    );
  }
  const exactValidation = validation.map((assessment) => ({
    ...assessment,
    preconditions: [
      ...assessment.preconditions,
      { id: "axis-aligned-box", passed: true as const },
    ],
  })) as [MeshAssessment, MeshAssessment];
  try {
    const cells = symmetricDifferenceCells(baselineBox, candidateBox);
    const baselineVolume = boxVolume(baselineBox);
    const candidateVolume = boxVolume(candidateBox);
    const intersection = intersectionBox(baselineBox, candidateBox);
    const intersectionVolume =
      intersection === undefined ? 0 : boxVolume(intersection);
    const symmetricDifferenceVolume =
      baselineVolume + candidateVolume - 2 * intersectionVolume;
    const values = [
      baselineVolume,
      candidateVolume,
      intersectionVolume,
      symmetricDifferenceVolume,
      ...cells.map(({ volume }) => volume),
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("Solid volume exceeded the supported numeric range.");
    }
    const ranked = cells.sort(
      (left, right) =>
        right.volume - left.volume ||
        categoryRank(left.category) - categoryRank(right.category) ||
        compareVec3(left.bounds.min, right.bounds.min),
    );
    const metrics: Array<{
      id: string;
      value: number;
      unit: "cubic-millimetre" | "count";
    }> = [
      {
        id: "solid.baseline-volume",
        value: baselineVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.candidate-volume",
        value: candidateVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.intersection-volume",
        value: intersectionVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.symmetric-difference-volume",
        value: symmetricDifferenceVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.changed-region-count",
        value: ranked.length,
        unit: "count",
      },
    ];
    const regions = ranked.map((cell, index) => {
      const id = `region.solid.${cell.category}.${String(index).padStart(3, "0")}`;
      const metricId = `${id}.volume`;
      metrics.push({
        id: metricId,
        value: cell.volume,
        unit: "cubic-millimetre",
      });
      return {
        id,
        frame: "comparison" as const,
        category: cell.category,
        bounds: cell.bounds,
        anchor: midpoint(cell.bounds),
        metricIds: [metricId],
        warningCodes: [],
      };
    });
    return analysisResultSchema.parse({
      contractVersion: 1,
      requestId: request.requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings: [],
      outcome: {
        state: "complete",
        semantics: "exact-within-validated-preconditions",
        requestedMethod: request.method,
        effectiveMethod: request.method,
        requestedTolerance: request.tolerance,
        effectiveTolerance: request.tolerance,
        validation: exactValidation,
        metrics,
        regions,
        orderedRegionIds: regions.map(({ id }) => id),
        adjustments: [],
        validatedDomain: {
          id: "axis-aligned-box-domain-v1",
          description:
            "Exact set-volume decomposition for two validated, closed, consistently oriented axis-aligned boxes in the comparison frame.",
          preconditionIds: [
            "closed",
            "consistently-oriented",
            "axis-aligned-box",
          ],
        },
      },
    });
  } catch (error) {
    return indeterminate(
      request,
      "numeric-range-exceeded",
      [
        error instanceof Error
          ? error.message
          : "Solid comparison exceeded the supported numeric range.",
      ],
      exactValidation,
    );
  }
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

function validatedAxisAlignedBox(
  geometry: FlatGeometry,
  assessment: MeshAssessment,
): Bounds | undefined {
  if (
    geometry.vertexCount !== 8 ||
    geometry.triangleCount !== 12 ||
    !assessment.closed ||
    !assessment.consistentlyOriented ||
    assessment.degenerateTriangleCount !== 0
  ) {
    return undefined;
  }
  const bounds = boundsOfPositions(geometry.positions, geometry.vertexCount);
  if (bounds.min.some((value, axis) => value === bounds.max[axis])) {
    return undefined;
  }
  const expected = new Set<string>();
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        expected.add(pointKey([x, y, z]));
      }
    }
  }
  const actual = new Set<string>();
  for (let vertex = 0; vertex < geometry.vertexCount; vertex += 1) {
    actual.add(pointKeyAt(geometry, vertex));
  }
  if (actual.size !== 8 || [...actual].some((point) => !expected.has(point))) {
    return undefined;
  }
  return bounds;
}

interface DifferenceCell {
  readonly category: "added" | "removed";
  readonly bounds: Bounds;
  readonly volume: number;
}

function symmetricDifferenceCells(
  baseline: Bounds,
  candidate: Bounds,
): DifferenceCell[] {
  const axes = [0, 1, 2].map((axis) =>
    uniqueNumbers([
      baseline.min[axis]!,
      baseline.max[axis]!,
      candidate.min[axis]!,
      candidate.max[axis]!,
    ]).sort((left, right) => left - right),
  );
  const cells: DifferenceCell[] = [];
  for (let x = 0; x < axes[0]!.length - 1; x += 1) {
    for (let y = 0; y < axes[1]!.length - 1; y += 1) {
      for (let z = 0; z < axes[2]!.length - 1; z += 1) {
        const bounds: Bounds = {
          min: [axes[0]![x]!, axes[1]![y]!, axes[2]![z]!],
          max: [axes[0]![x + 1]!, axes[1]![y + 1]!, axes[2]![z + 1]!],
        };
        const center = midpoint(bounds);
        const inBaseline = contains(baseline, center);
        const inCandidate = contains(candidate, center);
        if (inBaseline === inCandidate) continue;
        cells.push({
          category: inCandidate ? "added" : "removed",
          bounds,
          volume: boxVolume(bounds),
        });
      }
    }
  }
  return cells;
}

function intersectionBox(first: Bounds, second: Bounds): Bounds | undefined {
  const bounds: Bounds = {
    min: [
      Math.max(first.min[0], second.min[0]),
      Math.max(first.min[1], second.min[1]),
      Math.max(first.min[2], second.min[2]),
    ],
    max: [
      Math.min(first.max[0], second.max[0]),
      Math.min(first.max[1], second.max[1]),
      Math.min(first.max[2], second.max[2]),
    ],
  };
  return bounds.min.some((value, axis) => value >= bounds.max[axis]!)
    ? undefined
    : bounds;
}

function boxVolume(bounds: Bounds): number {
  return (
    (bounds.max[0] - bounds.min[0]) *
    (bounds.max[1] - bounds.min[1]) *
    (bounds.max[2] - bounds.min[2])
  );
}

function contains(bounds: Bounds, point: Vec3): boolean {
  return point.every(
    (value, axis) => value > bounds.min[axis]! && value < bounds.max[axis]!,
  );
}

function midpoint(bounds: Bounds): Vec3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

/** Bounds over every vertex in `positions`, reading the typed array in place. */
function boundsOfPositions(
  positions: Float64Array,
  vertexCount: number,
): Bounds {
  if (vertexCount === 0) throw new Error("Cannot bound empty geometry.");
  let minX = positions[0]!;
  let minY = positions[1]!;
  let minZ = positions[2]!;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let vertex = 1; vertex < vertexCount; vertex += 1) {
    const base = vertex * 3;
    const x = positions[base]!;
    const y = positions[base + 1]!;
    const z = positions[base + 2]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Bounds over the vertices touched by `triangleIndices`, reading geometry
 * positions directly instead of materializing a Vec3 array of the region's
 * (possibly duplicated) triangle corners.
 */
export function boundsOfTriangles(
  geometry: FlatGeometry,
  triangleIndices: readonly number[],
): Bounds {
  if (triangleIndices.length === 0) {
    throw new Error("Cannot bound empty geometry.");
  }
  const positions = geometry.positions;
  const indices = geometry.indices;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const triangleIndex of triangleIndices) {
    const base = triangleIndex * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[base + corner]!;
      const vertexBase = vertex * 3;
      const x = positions[vertexBase]!;
      const y = positions[vertexBase + 1]!;
      const z = positions[vertexBase + 2]!;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function pointKey(point: Vec3): string {
  return `${point[0]},${point[1]},${point[2]}`;
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function categoryRank(category: "added" | "removed"): number {
  return category === "added" ? 0 : 1;
}

function compareVec3(left: Vec3, right: Vec3): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function indeterminate(
  request: AnalysisRequest,
  code: string,
  reasons: readonly string[],
  validation: readonly MeshAssessment[] = [],
): AnalysisResult {
  return analysisResultSchema.parse({
    contractVersion: 1,
    requestId: request.requestId,
    baseline: request.baseline,
    candidate: request.candidate,
    warnings: [],
    outcome: {
      state: "indeterminate",
      code,
      reasons,
      requestedMethod: request.method,
      requestedTolerance: request.tolerance,
      validation,
    },
  });
}
