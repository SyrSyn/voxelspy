import {
  normalizedModelSchema,
  rigidTransformSchema,
} from "@voxelspy/contracts";
import type {
  MeshAssessment,
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
  assessGeometry,
  boundsOfTriangles,
  checkExpandedGeometryBudget,
} from "./analyze.js";
import type { Bounds } from "./analyze.js";
import {
  closestPointOnTriangle,
  countExpandedGeometry,
  flattenModel,
  triangleAreaAt,
  triangleCentroidAt,
} from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";
import { resolveBound } from "./inspect.js";
import { groupTrianglesByExactEdgeConnectivity } from "./region-connectivity.js";
import {
  NumericRangeExceededError,
  TriangleSpatialIndex,
} from "./spatial-index.js";
import { trianglesIntersect } from "./triangle-triangle.js";

export const CLEARANCE_METHOD_ID = "clearance-fit-check";
export const CLEARANCE_METHOD_VERSION = "1.0.0";

/** Default number of ranked tight regions returned before truncation. */
export const DEFAULT_MAX_TIGHT_REGIONS = 200;
/**
 * Implementation ceiling on `CheckClearanceOptions.maxTightRegions`. Reuses
 * `ANALYSIS_LIMITS.maxReportedRegions` -- the same ceiling `surface-distance`
 * enforces on its own `maxRegions` parameter -- rather than declaring a
 * second, independently-tuned region-count ceiling.
 */
export const MAX_TIGHT_REGIONS = ANALYSIS_LIMITS.maxReportedRegions;

/** Default number of intersecting triangle pairs returned before truncation. */
export const DEFAULT_MAX_INTERFERING_TRIANGLE_PAIRS = 200;
/**
 * Implementation ceiling on
 * `CheckClearanceOptions.maxInterferingTrianglePairs`. This is a genuinely
 * new bound -- `analyzeModelPair` has no equivalent, since only
 * `checkClearance` reports triangle-pair interference evidence -- chosen at
 * the same order of magnitude as `ANALYSIS_LIMITS.maxReportedRegions` for
 * consistency with this package's other bounded-list ceilings.
 */
export const MAX_INTERFERING_TRIANGLE_PAIRS = 2_048;

export interface CheckClearanceOptions {
  /** Bounded by `MAX_TIGHT_REGIONS`. Defaults to `DEFAULT_MAX_TIGHT_REGIONS`. */
  readonly maxTightRegions?: number;
  /** Bounded by `MAX_INTERFERING_TRIANGLE_PAIRS`. Defaults to `DEFAULT_MAX_INTERFERING_TRIANGLE_PAIRS`. */
  readonly maxInterferingTrianglePairs?: number;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
}

/** One part's model, independently and deliberately placed into the shared comparison frame. Never auto-aligned or recentered. */
export interface ClearancePlacement {
  readonly model: NormalizedModel;
  readonly modelToComparison: RigidTransform;
}

export interface CheckClearanceInput {
  readonly first: ClearancePlacement;
  readonly second: ClearancePlacement;
  /** The desired minimum surface-to-surface clearance, in millimetres. Must be finite and non-negative; zero means "must not touch." */
  readonly desiredClearanceMillimetres: number;
}

/**
 * `clear`: the sampled minimum distance is at least the desired clearance.
 * `tight`: the sampled minimum distance is positive but below the desired
 * clearance. `interfering`: an exact triangle-triangle intersection was
 * detected, or the sampled minimum distance is exactly zero (the surfaces
 * touch or coincide at a sampled point). See `ClearanceCheckComplete`'s doc
 * comment for the full precision this classification is and is not entitled
 * to claim.
 */
export type ClearanceState = "clear" | "tight" | "interfering";

export type ClearancePart = "first" | "second";

export interface ClosestPointPair {
  /** Point on the `first` part's surface, in the comparison frame. */
  readonly first: Vec3;
  /** Point on the `second` part's surface, in the comparison frame. */
  readonly second: Vec3;
}

export interface ClearanceTightRegion {
  readonly id: string;
  /** Which part's surface this region's triangles belong to. */
  readonly part: ClearancePart;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  /** The centroid of this region's closest-approach triangle. */
  readonly anchor: Vec3;
  readonly minimumDistanceMillimetres: number;
  readonly areaSquareMillimetres: number;
  readonly triangleCount: number;
  /** Indices into `part`'s own flattened comparison-frame triangle list. */
  readonly triangleIndices: readonly number[];
}

export interface ClearanceTightRegionSet {
  /** Ranked ascending by `minimumDistanceMillimetres` (tightest first), bounded by the active `maxTightRegions`. */
  readonly regions: readonly ClearanceTightRegion[];
  /** The true number of tight regions found, independent of truncation. */
  readonly detectedRegionCount: number;
  readonly truncated: boolean;
}

export interface ClearanceTrianglePair {
  /** Index into the `first` part's own flattened comparison-frame triangle list. */
  readonly firstTriangleIndex: number;
  /** Index into the `second` part's own flattened comparison-frame triangle list. */
  readonly secondTriangleIndex: number;
}

export interface ClearanceInterferenceVolume {
  readonly available: false;
  readonly reason: string;
}

export interface ClearanceInterference {
  /** Bounded by the active `maxInterferingTrianglePairs`; each pair confirmed by an exact triangle-triangle intersection test. */
  readonly trianglePairs: readonly ClearanceTrianglePair[];
  /** The true number of intersecting triangle pairs found, independent of truncation. */
  readonly detectedPairCount: number;
  readonly truncated: boolean;
  /** Always `{ available: false, ... }` here -- see `ClearanceCheckComplete`'s doc comment for why. */
  readonly volume: ClearanceInterferenceVolume;
}

export interface ClearanceWarning {
  readonly code: string;
  readonly severity: "warning";
  readonly message: string;
  readonly details?: Readonly<Record<string, number>>;
}

/**
 * A completed clearance/fit check between two deliberately placed parts.
 *
 * **Classification rule** (`state`): `minimumDistanceMillimetres` is
 * compared against `desiredClearanceMillimetres`. `interfering` whenever
 * `interference.detectedPairCount > 0` (an exact triangle-triangle
 * intersection was found) OR `minimumDistanceMillimetres === 0` (a sampled
 * point on one surface landed exactly on the other, e.g. flush,
 * face-to-face contact); otherwise `tight` when
 * `0 < minimumDistanceMillimetres < desiredClearanceMillimetres`; otherwise
 * `clear`.
 *
 * **Two different kinds of precision live in this one result, and they must
 * not be confused.** `interference.trianglePairs` is exact: each reported
 * pair is confirmed by an exact triangle-triangle intersection test against
 * the actual tessellated surfaces (see `src/triangle-triangle.ts`),
 * independent of sampling, so a `state: "interfering"` driven by a detected
 * pair is reliable evidence of real overlap. `minimumDistanceMillimetres`,
 * `closestPoints`, and `tightRegions`, in contrast, are sampled: each
 * sampled distance is itself an exact point-to-triangle nearest-surface
 * distance (the same exact query `surface-distance` uses), but only a
 * bounded set of points on each part's own surface -- its triangle vertices
 * and centroids -- are sampled, exactly as `surface-distance` samples. A
 * true minimum distance smaller than any reported here can exist between
 * samples, and a small protrusion confined to one coarse triangle's interior
 * can violate the desired clearance without being reported as tight. This is
 * bounded, not just disclosed in prose: `uncertainty.parameters` reports the
 * same per-triangle sample-spacing bound `surface-distance` reports (at most
 * two-thirds of a triangle's longest edge -- see `SAMPLE_SPACING_EDGE_FACTOR`
 * in `src/analyze.ts`), and `uncertainty.parameters.undersampled` plus the
 * `clearance.undersampled` warning are set explicitly whenever that bound
 * exceeds the desired clearance, so a `clear` result is never a silent
 * geometric guarantee.
 *
 * **No interference volume.** `interference.volume` is always
 * `{ available: false, reason }`: computing an exact Boolean-intersection
 * volume requires a validated domain the way `axis-aligned-box-solid`
 * validates two boxes; general triangle-mesh solids satisfy no such domain
 * here, and approximating a volume without one would silently misrepresent
 * precision this package does not have. Only concrete intersecting triangle
 * pairs are ever reported as interference evidence.
 */
export interface ClearanceCheckComplete {
  readonly state: ClearanceState;
  readonly minimumDistanceMillimetres: number;
  readonly closestPoints: ClosestPointPair;
  readonly desiredClearanceMillimetres: number;
  readonly tightRegions: ClearanceTightRegionSet;
  readonly interference: ClearanceInterference;
  readonly method: {
    readonly id: string;
    readonly version: string;
    readonly parameters: Readonly<Record<string, number>>;
  };
  /** Always `"approximate"` -- see the doc comment above for exactly which fields that does and does not cover. */
  readonly semantics: "approximate";
  readonly uncertainty: {
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
  readonly validation: readonly [MeshAssessment, MeshAssessment];
  readonly warnings: readonly ClearanceWarning[];
}

export interface ClearanceCheckIndeterminate {
  readonly state: "indeterminate";
  readonly code: string;
  readonly reasons: readonly string[];
  readonly validation: readonly MeshAssessment[];
}

export type ClearanceCheckResult =
  ClearanceCheckComplete | ClearanceCheckIndeterminate;

/**
 * Checks clearance/fit between two independently, deliberately placed parts:
 * collision regions, the minimum surface-to-surface distance (with a
 * measurable closest-point pair), regions below a desired clearance, and
 * exact intersecting-triangle-pair interference evidence.
 *
 * This is adjacent to, not a fork of, `analyzeModelPair`'s `surface-distance`
 * method: both flatten each model into a comparison-frame `FlatGeometry`
 * (`flattenModel`), build a `TriangleSpatialIndex` per part, and sample
 * triangle vertices plus centroids against the opposite part's index. The
 * key difference is placement: `analyzeModelPair` compares one model against
 * a revision of itself, while `checkClearance` takes each part's own,
 * independently supplied `modelToComparison` transform and NEVER
 * auto-aligns, recenters, or otherwise adjusts either part's placement --
 * the caller positions both parts deliberately, and this function only
 * measures the result.
 *
 * Tight-region grouping reuses the exact same exact-coordinate edge
 * connectivity `surface-distance`'s region grouping uses
 * (`groupTrianglesByExactEdgeConnectivity` in `src/region-connectivity.ts`,
 * shared by both, not forked). Interference detection is new: candidate
 * triangle pairs are found by querying one part's `TriangleSpatialIndex` for
 * AABB overlap (`TriangleSpatialIndex.overlapping`), then each candidate is
 * confirmed with an exact triangle-triangle intersection test
 * (`src/triangle-triangle.ts`) -- this is genuinely new geometry math this
 * package did not previously have, not a reuse of the point-to-triangle
 * distance query.
 *
 * **Resource discipline.** Reuses `ANALYSIS_LIMITS` (expanded vertex/triangle
 * ceilings and the estimated-memory ceiling, via
 * `checkExpandedGeometryBudget`, shared with `analyzeModelPair`) and the same
 * charge-before-work `WorkBudget` used throughout this package: flattening,
 * the mesh precondition census, spatial-index construction, sampled-distance
 * queries, tight-region connectivity, and interference candidate
 * gathering/exact testing are all charged to one budget constructed before
 * any O(vertices + triangles) work runs, so a caller-supplied budget too
 * small to complete fails closed as `indeterminate`/`resource-budget-exceeded`
 * before the corresponding pass runs, exactly like `analyzeModelPair`.
 * `maxTightRegions` and `maxInterferingTrianglePairs` are new, independent
 * bounds this module adds beyond `ANALYSIS_LIMITS` -- see their doc comments
 * for ceilings and defaults; an out-of-range value throws `RangeError`
 * (matching `InspectOptions`/`MeshHealthOptions`), since that is a caller
 * programming error, not a data-driven failure.
 *
 * **Determinism.** Identical `model`/`modelToComparison`/
 * `desiredClearanceMillimetres`/`options` input produces a deeply-equal
 * result every time: sampling walks each part's own triangle order, region
 * grouping and ranking use full deterministic tie-breaking (ascending
 * minimum distance, then descending area, then part, then bounds, then id),
 * and interference candidate gathering/testing walks triangles and
 * AABB-overlap candidates in a fixed order.
 */
export function checkClearance(
  input: CheckClearanceInput,
  options: CheckClearanceOptions = {},
): ClearanceCheckResult {
  const first = normalizedModelSchema.parse(input.first.model);
  const second = normalizedModelSchema.parse(input.second.model);
  // Each part's placement transform is validated as a proper rigid
  // transform (no scale, shear, or reflection), the same contract
  // `analysisRequestSchema`'s `modelBinding.modelToComparison` enforces for
  // `analyzeModelPair` -- nothing else in this function's own bespoke input
  // shape would otherwise catch a malformed transform before it silently
  // distorted every downstream distance.
  const firstTransform = rigidTransformSchema.parse(
    input.first.modelToComparison,
  );
  const secondTransform = rigidTransformSchema.parse(
    input.second.modelToComparison,
  );

  const desiredClearance = input.desiredClearanceMillimetres;
  if (!Number.isFinite(desiredClearance) || desiredClearance < 0) {
    return indeterminateClearance("invalid-desired-clearance", [
      "desiredClearanceMillimetres must be a finite, non-negative number.",
    ]);
  }

  const maxTightRegions = resolveBound(
    options.maxTightRegions,
    DEFAULT_MAX_TIGHT_REGIONS,
    MAX_TIGHT_REGIONS,
    "maxTightRegions",
  );
  const maxInterferingTrianglePairs = resolveBound(
    options.maxInterferingTrianglePairs,
    DEFAULT_MAX_INTERFERING_TRIANGLE_PAIRS,
    MAX_INTERFERING_TRIANGLE_PAIRS,
    "maxInterferingTrianglePairs",
  );

  const firstCounts = countExpandedGeometry(first);
  const secondCounts = countExpandedGeometry(second);
  const budgetProblem = checkExpandedGeometryBudget(
    firstCounts.vertices + secondCounts.vertices,
    firstCounts.triangles + secondCounts.triangles,
    options.executionBudget,
  );
  if (budgetProblem !== undefined) {
    return indeterminateClearance("resource-budget-exceeded", [budgetProblem]);
  }

  const workLimit = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    options.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  const work = new WorkBudget(workLimit);

  let firstGeometry: FlatGeometry;
  let secondGeometry: FlatGeometry;
  let validation: readonly [MeshAssessment, MeshAssessment];
  try {
    firstGeometry = flattenModel(first, firstTransform, work);
    secondGeometry = flattenModel(second, secondTransform, work);
    validation = [
      assessGeometry(first.id, firstGeometry, work),
      assessGeometry(second.id, secondGeometry, work),
    ];
  } catch (error) {
    if (error instanceof WorkBudgetExceeded) {
      return indeterminateClearance("resource-budget-exceeded", [
        error.message,
      ]);
    }
    if (error instanceof WorkBudgetInternalError) throw error;
    return indeterminateClearance("comparison-transform-failed", [
      error instanceof Error ? error.message : "Comparison transform failed.",
    ]);
  }

  const invalid = validation.flatMap((assessment) =>
    assessment.reasons.filter(
      (reason) =>
        reason === "empty-geometry" || reason === "degenerate-triangles",
    ),
  );
  if (invalid.length > 0) {
    return indeterminateClearance(
      "clearance-precondition-failed",
      [`Clearance check preconditions failed: ${unique(invalid).join(", ")}.`],
      validation,
    );
  }

  try {
    const firstIndex = new TriangleSpatialIndex(firstGeometry, work);
    const secondIndex = new TriangleSpatialIndex(secondGeometry, work);

    const firstPass = directionalClearancePass(
      firstGeometry,
      secondIndex,
      secondGeometry,
      "first",
      desiredClearance,
      work,
    );
    const secondPass = directionalClearancePass(
      secondGeometry,
      firstIndex,
      firstGeometry,
      "second",
      desiredClearance,
      work,
    );

    const closerToFirstPass =
      firstPass.minimumDistance <= secondPass.minimumDistance;
    const minimumDistance = closerToFirstPass
      ? firstPass.minimumDistance
      : secondPass.minimumDistance;
    const closestPoints: ClosestPointPair = closerToFirstPass
      ? { first: firstPass.minimumSample, second: firstPass.minimumTargetPoint }
      : {
          first: secondPass.minimumTargetPoint,
          second: secondPass.minimumSample,
        };

    const ranked = [...firstPass.regions, ...secondPass.regions].sort(
      compareTightRegion,
    );
    const reportedRegions = ranked.slice(0, maxTightRegions);
    const regionsTruncated = reportedRegions.length !== ranked.length;

    const interference = detectInterference(
      firstGeometry,
      secondGeometry,
      secondIndex,
      maxInterferingTrianglePairs,
      work,
    );

    const state: ClearanceState =
      interference.detectedPairCount > 0 || minimumDistance === 0
        ? "interfering"
        : minimumDistance < desiredClearance
          ? "tight"
          : "clear";

    const firstMaxSampleSpacing =
      firstPass.maxLongestEdge * SAMPLE_SPACING_EDGE_FACTOR;
    const secondMaxSampleSpacing =
      secondPass.maxLongestEdge * SAMPLE_SPACING_EDGE_FACTOR;
    const maxSampleSpacing = Math.max(
      firstMaxSampleSpacing,
      secondMaxSampleSpacing,
    );
    const undersampled = maxSampleSpacing > desiredClearance;

    const omittedRegionCount = ranked.length - reportedRegions.length;
    const omittedInterferingPairCount =
      interference.detectedPairCount - interference.trianglePairs.length;

    const warnings: ClearanceWarning[] = [
      ...(regionsTruncated
        ? [
            {
              code: "clearance.region-limit",
              severity: "warning" as const,
              message: `${omittedRegionCount} lower-ranked tight regions were omitted by the requested region limit.`,
              details: {
                detectedRegionCount: ranked.length,
                reportedRegionCount: reportedRegions.length,
              },
            },
          ]
        : []),
      ...(interference.truncated
        ? [
            {
              code: "clearance.interference-pair-limit",
              severity: "warning" as const,
              message: `${omittedInterferingPairCount} intersecting triangle pairs were omitted by the requested pair limit.`,
              details: {
                detectedPairCount: interference.detectedPairCount,
                reportedPairCount: interference.trianglePairs.length,
              },
            },
          ]
        : []),
      ...(undersampled
        ? [
            {
              code: "clearance.undersampled",
              severity: "warning" as const,
              message: `The sample spacing bound (${maxSampleSpacing} mm, derived from the coarsest analyzed triangle edges) exceeds the desired clearance (${desiredClearance} mm); a feature entirely interior to a coarse triangle can violate the desired clearance without being reported as tight, and a "clear" result here is not a geometric guarantee.`,
              details: {
                maxSampleSpacingMillimetres: maxSampleSpacing,
                firstMaxSampleSpacingMillimetres: firstMaxSampleSpacing,
                secondMaxSampleSpacingMillimetres: secondMaxSampleSpacing,
                desiredClearanceMillimetres: desiredClearance,
              },
            },
          ]
        : []),
    ];

    return {
      state,
      minimumDistanceMillimetres: minimumDistance,
      closestPoints,
      desiredClearanceMillimetres: desiredClearance,
      tightRegions: {
        regions: reportedRegions,
        detectedRegionCount: ranked.length,
        truncated: regionsTruncated,
      },
      interference: {
        trianglePairs: interference.trianglePairs,
        detectedPairCount: interference.detectedPairCount,
        truncated: interference.truncated,
        volume: {
          available: false,
          reason:
            "Exact interference volume requires a validated Boolean-solid domain, the way axis-aligned-box-solid validates two boxes; general triangle-mesh parts satisfy no such domain here, so no volume is computed or approximated -- only concrete intersecting triangle pairs are reported.",
        },
      },
      method: {
        id: CLEARANCE_METHOD_ID,
        version: CLEARANCE_METHOD_VERSION,
        parameters: { maxTightRegions, maxInterferingTrianglePairs },
      },
      semantics: "approximate",
      uncertainty: {
        description:
          'Distances use finite vertex and triangle-centroid samples against the opposite tessellated surface, exactly like the surface-distance comparison method: each sampled distance is an exact point-to-triangle nearest-surface distance, but only a bounded set of points on each surface are sampled, so a smaller true minimum distance can exist between samples. For each analyzed triangle, the farthest point on that triangle from its nearest sample is at most two-thirds of that triangle\'s longest edge; the largest such bound across each part\'s triangles is reported below as its sample spacing. When that spacing exceeds the desired clearance, a feature confined to a single coarse triangle\'s interior can violate the desired clearance while still being reported "clear" -- with no defect in the desired clearance value itself. Interference evidence (interference.trianglePairs) is NOT subject to this sampling limitation: each reported pair is confirmed by an exact triangle-triangle intersection test against the actual tessellated surfaces, independent of where samples fall, so an "interfering" state driven by a detected pair is exact within floating-point precision. No interference volume is computed or approximated (see interference.volume): general triangle-mesh parts have no validated Boolean-solid domain in this package.',
        parameters: {
          sampling: "vertices-and-triangle-centroids",
          desiredClearanceMillimetres: desiredClearance,
          maxSampleSpacingMillimetres: maxSampleSpacing,
          firstMaxSampleSpacingMillimetres: firstMaxSampleSpacing,
          secondMaxSampleSpacingMillimetres: secondMaxSampleSpacing,
          undersampled,
          maxTightRegions,
          omittedRegionCount,
          maxInterferingTrianglePairs,
          omittedInterferingPairCount,
        },
      },
      validation,
      warnings,
    };
  } catch (error) {
    if (error instanceof WorkBudgetExceeded) {
      return indeterminateClearance(
        "resource-budget-exceeded",
        [error.message],
        validation,
      );
    }
    if (error instanceof WorkBudgetInternalError) throw error;
    if (error instanceof NumericRangeExceededError) {
      return indeterminateClearance(
        "numeric-range-exceeded",
        [error.message.slice(0, 950)],
        validation,
      );
    }
    // Any other exception here is an unexpected defect, not a numeric-range
    // failure the code itself detected -- kept as a distinct code rather than
    // misattributed to input magnitude, matching `analyzeSurfaceDistance` in
    // `src/analyze.ts`.
    return indeterminateClearance(
      "internal-error",
      [
        error instanceof Error
          ? error.message.slice(0, 950)
          : "Clearance check failed with an unexpected error.",
      ],
      validation,
    );
  }
}

function indeterminateClearance(
  code: string,
  reasons: readonly string[],
  validation: readonly MeshAssessment[] = [],
): ClearanceCheckIndeterminate {
  return { state: "indeterminate", code, reasons, validation };
}

interface RankedTightRegion {
  readonly id: string;
  readonly part: ClearancePart;
  readonly bounds: Bounds;
  readonly anchor: Vec3;
  readonly minimumDistanceMillimetres: number;
  readonly areaSquareMillimetres: number;
  readonly triangleCount: number;
  readonly triangleIndices: readonly number[];
}

interface ClearancePassResult {
  readonly regions: RankedTightRegion[];
  /** Longest edge length among this pass's source triangles, in millimetres. */
  readonly maxLongestEdge: number;
  /** Smallest sampled distance found from any of this pass's source samples to the target surface. */
  readonly minimumDistance: number;
  /** The source-surface sample point (exact, unsampled coordinates of a vertex or centroid) that achieved `minimumDistance`. */
  readonly minimumSample: Vec3;
  /** The closest point on the target surface's nearest triangle to `minimumSample`. */
  readonly minimumTargetPoint: Vec3;
}

/**
 * Charged per triangle before its four samples are queried, mirroring
 * `DIRECTIONAL_TRIANGLE_WORK_UNITS` in `src/analyze.ts`: this pass performs
 * the same per-triangle work (read three vertices plus compute a centroid,
 * measure edge lengths, run four nearest-surface queries) that
 * `directionalRegions` does, just with a different threshold direction.
 */
const CLEARANCE_TRIANGLE_WORK_UNITS = 8;

/**
 * Samples `source`'s triangle vertices and centroids against `target` (the
 * opposite part's spatial index), exactly as `analyzeSurfaceDistance`'s
 * `directionalRegions` does, but with the clearance-specific threshold: a
 * triangle is "tight" when its minimum (not maximum) sampled distance to the
 * opposite surface is below `desiredClearance` -- the closest approach of
 * that triangle to the other part, not its worst-case deviation. Tight
 * triangles are grouped into regions using the shared exact-coordinate edge
 * connectivity (`groupTrianglesByExactEdgeConnectivity`), never a forked
 * copy of it.
 */
function directionalClearancePass(
  source: FlatGeometry,
  target: TriangleSpatialIndex,
  targetGeometry: FlatGeometry,
  part: ClearancePart,
  desiredClearance: number,
  work: WorkUnitCounter,
): ClearancePassResult {
  const triangleCount = source.triangleCount;
  work.charge(triangleCount * CLEARANCE_TRIANGLE_WORK_UNITS);

  const tight = new Uint8Array(triangleCount);
  const minimumDistancePerTriangle = new Float64Array(triangleCount);

  const positions = source.positions;
  const indices = source.indices;
  let maxLongestEdge = 0;
  let globalMinimum = Number.POSITIVE_INFINITY;
  let globalSample: Vec3 = [0, 0, 0];
  let globalTargetPoint: Vec3 = [0, 0, 0];

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

    const edgeAB = Math.hypot(bx - ax, by - ay, bz - az);
    const edgeBC = Math.hypot(cx - bx, cy - by, cz - bz);
    const edgeCA = Math.hypot(ax - cx, ay - cy, az - cz);
    const longestEdge = Math.max(edgeAB, edgeBC, edgeCA);
    if (longestEdge > maxLongestEdge) maxLongestEdge = longestEdge;

    let triangleMinimum = Number.POSITIVE_INFINITY;
    const samples: readonly [number, number, number][] = [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
      [centroidX, centroidY, centroidZ],
    ];
    for (const [sx, sy, sz] of samples) {
      work.charge(1);
      const nearest = target.nearestTriangle(sx, sy, sz, work);
      if (nearest.distance < triangleMinimum)
        triangleMinimum = nearest.distance;
      if (nearest.distance < globalMinimum) {
        globalMinimum = nearest.distance;
        globalSample = [sx, sy, sz];
        const targetBase = nearest.triangleIndex * 3;
        const ja = targetGeometry.indices[targetBase]!;
        const jb = targetGeometry.indices[targetBase + 1]!;
        const jc = targetGeometry.indices[targetBase + 2]!;
        globalTargetPoint = closestPointOnTriangle(
          sx,
          sy,
          sz,
          targetGeometry.positions,
          ja,
          jb,
          jc,
        );
      }
    }
    minimumDistancePerTriangle[triangle] = triangleMinimum;
    tight[triangle] = triangleMinimum < desiredClearance ? 1 : 0;
  }

  const components = groupTrianglesByExactEdgeConnectivity(source, tight);
  const regions: RankedTightRegion[] = [];
  for (const component of components) {
    const bounds = boundsOfTriangles(source, component);
    let anchorTriangle = component[0]!;
    for (const triangle of component) {
      if (
        minimumDistancePerTriangle[triangle]! <
        minimumDistancePerTriangle[anchorTriangle]!
      ) {
        anchorTriangle = triangle;
      }
    }
    const serial = String(component[0]!).padStart(6, "0");
    let minimum = minimumDistancePerTriangle[component[0]!]!;
    let areaSum = 0;
    for (const triangle of component) {
      const value = minimumDistancePerTriangle[triangle]!;
      if (value < minimum) minimum = value;
      areaSum += triangleAreaAt(source, triangle);
    }
    regions.push({
      id: `region.clearance.tight.${part}.${serial}`,
      part,
      bounds,
      anchor: triangleCentroidAt(source, anchorTriangle),
      minimumDistanceMillimetres: minimum,
      areaSquareMillimetres: areaSum,
      triangleCount: component.length,
      triangleIndices: component,
    });
  }

  return {
    regions,
    maxLongestEdge,
    minimumDistance: globalMinimum,
    minimumSample: globalSample,
    minimumTargetPoint: globalTargetPoint,
  };
}

function compareTightRegion(
  left: RankedTightRegion,
  right: RankedTightRegion,
): number {
  return (
    left.minimumDistanceMillimetres - right.minimumDistanceMillimetres ||
    right.areaSquareMillimetres - left.areaSquareMillimetres ||
    partRank(left.part) - partRank(right.part) ||
    compareVec3(left.bounds.min, right.bounds.min) ||
    compareText(left.id, right.id)
  );
}

function partRank(part: ClearancePart): number {
  return part === "first" ? 0 : 1;
}

/**
 * Charged per `first`-part triangle before its candidate range query, for
 * the AABB computation and general per-triangle bookkeeping. The range query
 * itself (`TriangleSpatialIndex.overlapping`) charges its own per-node work.
 * A genuinely new bound this module adds -- `analyzeModelPair` has no
 * equivalent pass.
 */
const INTERFERENCE_TRIANGLE_WORK_UNITS = 4;
/**
 * Charged per AABB-overlap candidate pair before running the exact
 * triangle-triangle intersection test, reflecting that test's cost (up to
 * two plane-separation checks, a parallel-plane check, and up to six
 * segment-vs-triangle tests).
 */
const TRIANGLE_TRIANGLE_TEST_WORK_UNITS = 24;

interface InterferenceResult {
  readonly trianglePairs: ClearanceTrianglePair[];
  readonly detectedPairCount: number;
  readonly truncated: boolean;
}

interface Bounds6 {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * Finds every triangle pair (one from `firstGeometry`, one from
 * `secondGeometry`) whose surfaces actually intersect, bounded by
 * `maxPairs`. Candidate pairs are found cheaply via AABB overlap
 * (`secondIndex.overlapping`, reusing the same BVH `directionalClearancePass`
 * already built for sampled-distance queries), then each candidate is
 * confirmed with an exact triangle-triangle intersection test
 * (`trianglesIntersect`) -- a coarse candidate set can only produce extra
 * rejected candidates, never a missed or false intersection. When the two
 * parts' whole-geometry bounding boxes do not overlap at all, no candidate
 * can possibly intersect, so the per-triangle scan is skipped entirely.
 *
 * The full candidate set is scanned (never stopped early at `maxPairs`) so
 * `detectedPairCount` is always the true total, matching
 * `diagnoseMeshHealth`'s boundary-loop/issue-list truncation convention in
 * `src/diagnose.ts`: only the bounded, stored `trianglePairs` list stops
 * growing once `maxPairs` is reached.
 */
function detectInterference(
  firstGeometry: FlatGeometry,
  secondGeometry: FlatGeometry,
  secondIndex: TriangleSpatialIndex,
  maxPairs: number,
  work: WorkUnitCounter,
): InterferenceResult {
  const firstBounds = wholeGeometryBounds(firstGeometry);
  const secondBounds = wholeGeometryBounds(secondGeometry);
  if (!bounds6Overlap(firstBounds, secondBounds)) {
    return { trianglePairs: [], detectedPairCount: 0, truncated: false };
  }

  const trianglePairs: ClearanceTrianglePair[] = [];
  let detectedPairCount = 0;
  const triangleCount = firstGeometry.triangleCount;
  const positions = firstGeometry.positions;
  const indices = firstGeometry.indices;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    work.charge(INTERFERENCE_TRIANGLE_WORK_UNITS);
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
    const minX = Math.min(ax, bx, cx);
    const minY = Math.min(ay, by, cy);
    const minZ = Math.min(az, bz, cz);
    const maxX = Math.max(ax, bx, cx);
    const maxY = Math.max(ay, by, cy);
    const maxZ = Math.max(az, bz, cz);

    const candidates = secondIndex
      .overlapping(minX, minY, minZ, maxX, maxY, maxZ, work)
      .sort((left, right) => left - right);
    for (const candidate of candidates) {
      work.charge(TRIANGLE_TRIANGLE_TEST_WORK_UNITS);
      const candidateBase = candidate * 3;
      const ja = secondGeometry.indices[candidateBase]!;
      const jb = secondGeometry.indices[candidateBase + 1]!;
      const jc = secondGeometry.indices[candidateBase + 2]!;
      if (
        trianglesIntersect(
          firstGeometry.positions,
          ia,
          ib,
          ic,
          secondGeometry.positions,
          ja,
          jb,
          jc,
        )
      ) {
        detectedPairCount += 1;
        if (trianglePairs.length < maxPairs) {
          trianglePairs.push({
            firstTriangleIndex: triangle,
            secondTriangleIndex: candidate,
          });
        }
      }
    }
  }
  return {
    trianglePairs,
    detectedPairCount,
    truncated: trianglePairs.length < detectedPairCount,
  };
}

function wholeGeometryBounds(geometry: FlatGeometry): Bounds6 {
  const positions = geometry.positions;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < geometry.vertexCount; vertex += 1) {
    const base = vertex * 3;
    const x = positions[base]!;
    const y = positions[base + 1]!;
    const z = positions[base + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function bounds6Overlap(left: Bounds6, right: Bounds6): boolean {
  return (
    left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY &&
    left.minZ <= right.maxZ &&
    left.maxZ >= right.minZ
  );
}

function compareVec3(left: Vec3, right: Vec3): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}
