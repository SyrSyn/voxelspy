import {
  IDENTITY_MAT4,
  normalizedModelSchema,
  rigidTransformSchema,
} from "@voxelspy/contracts";
import type {
  Mat4,
  NormalizedModel,
  RigidTransform,
  Vec3,
} from "@voxelspy/contracts";

import {
  ANALYSIS_LIMITS,
  WorkBudget,
  WorkBudgetExceeded,
  WorkBudgetInternalError,
  checkExpandedGeometryBudget,
} from "./analyze.js";
import { normalizeZero } from "./chain-tracing.js";
import {
  closestPointOnTriangle,
  countExpandedGeometry,
  flattenModel,
} from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";
import { TriangleSpatialIndex } from "./spatial-index.js";
import { summarizeModelGeometry } from "./summary.js";
import type { ModelBoundsSummary } from "./summary.js";

/**
 * A caller programming error, not a data-driven runtime outcome: a query's
 * point/ray coordinates were not finite, a ray's direction was degenerate
 * (zero length), or `snap-point`/`point-to-surface` was issued against a
 * model with no triangles after flattening. Mirrors `AlignmentInputError`'s
 * distinction in `src/alignment.ts`.
 */
export class MeasurementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementInputError";
  }
}

/**
 * Thrown when expanded geometry, or a caller-supplied `executionBudget`,
 * cannot accommodate the query -- before any O(vertices + triangles) work
 * runs. Mirrors `AlignmentResourceLimitError` in `src/alignment.ts`.
 */
export class MeasurementResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementResourceLimitError";
  }
}

export const DEFAULT_SNAP_TOLERANCE_MILLIMETRES = 0.5;
/** Implementation ceiling on `MeasureOptions.snapToleranceMillimetres`. */
export const MAX_SNAP_TOLERANCE_MILLIMETRES = 1_000;

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

export interface MeasureOptions {
  /** Defaults to identity. Validated as a proper rigid transform (no scale, shear, or reflection), matching `ClearancePlacement.modelToComparison` -- geometry placed for measurement must never be silently scaled or sheared, which would distort the very distances this function reports. */
  readonly modelToComparison?: RigidTransform;
  /** `snap-point` only. Bounded by `MAX_SNAP_TOLERANCE_MILLIMETRES`. Defaults to `DEFAULT_SNAP_TOLERANCE_MILLIMETRES`. Ignored by every other query kind. */
  readonly snapToleranceMillimetres?: number;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
}

/** A click-to-measure input: either a world-space point, or a ray (e.g. cast from a camera through a clicked pixel) to intersect against the surface. */
export type SnapPointInput =
  | { readonly kind: "point"; readonly point: Vec3 }
  | { readonly kind: "ray"; readonly origin: Vec3; readonly direction: Vec3 };

export interface SnapPointQuery {
  readonly kind: "snap-point";
  readonly at: SnapPointInput;
}

/** Two arbitrary points -- typically both obtained from prior `snap-point` results, but not verified against the surface here (see `measureOnModel`'s doc comment). */
export interface PointToPointQuery {
  readonly kind: "point-to-point";
  readonly first: Vec3;
  readonly second: Vec3;
}

export interface PointToSurfaceQuery {
  readonly kind: "point-to-surface";
  readonly point: Vec3;
}

export interface BoundingExtentQuery {
  readonly kind: "bounding-extent";
}

export type MeasurementQuery =
  | SnapPointQuery
  | PointToPointQuery
  | PointToSurfaceQuery
  | BoundingExtentQuery;

export type SnapClassification =
  | { readonly kind: "vertex"; readonly positionMillimetres: Vec3 }
  | {
      readonly kind: "edge";
      readonly endpointsMillimetres: readonly [Vec3, Vec3];
    }
  | { readonly kind: "face" };

export type SnapPointOutcome =
  | {
      readonly hit: true;
      /** The exact closest point on the tessellated surface (for `at.kind === "point"`) or the exact ray/surface intersection point (for `at.kind === "ray"`). */
      readonly pointMillimetres: Vec3;
      /** Which triangle `pointMillimetres` lies on. Arbitrary but deterministic when the point is equidistant from, or lies exactly on a shared edge/vertex of, more than one triangle. */
      readonly triangleIndex: number;
      readonly snap: SnapClassification;
    }
  | {
      readonly hit: false;
      /** Only reachable for `at.kind === "ray"`: the ray never crosses the model's surface. Not an error -- a ray missing the model is an expected outcome, not a failure. */
      readonly reason: "ray-missed-surface";
    };

export interface SnapPointResult {
  readonly kind: "snap-point";
  /** Always `"exact"` -- see `measureOnModel`'s doc comment for exactly what that claims and does not claim. */
  readonly semantics: "exact";
  readonly snapToleranceMillimetres: number;
  readonly outcome: SnapPointOutcome;
}

export interface PointToPointResult {
  readonly kind: "point-to-point";
  readonly semantics: "exact";
  readonly firstMillimetres: Vec3;
  readonly secondMillimetres: Vec3;
  readonly distanceMillimetres: number;
  /** `second - first`, componentwise. */
  readonly deltaMillimetres: Vec3;
}

export interface PointToSurfaceResult {
  readonly kind: "point-to-surface";
  readonly semantics: "exact";
  readonly queryPointMillimetres: Vec3;
  readonly closestPointMillimetres: Vec3;
  readonly distanceMillimetres: number;
  readonly triangleIndex: number;
}

export interface BoundingExtentResult {
  readonly kind: "bounding-extent";
  readonly semantics: "exact";
  /** Reused, not recomputed, from `summarizeModelGeometry`'s own bounds computation -- see `measureOnModel`'s doc comment. */
  readonly bounds: ModelBoundsSummary;
}

export type MeasurementResult =
  | SnapPointResult
  | PointToPointResult
  | PointToSurfaceResult
  | BoundingExtentResult;

/**
 * Answers a single measurement query -- `snap-point`, `point-to-point`,
 * `point-to-surface`, or `bounding-extent` -- against one placed model, for
 * a UI to build click-to-measure tooling as a thin layer over this package.
 *
 * **Exactness.** Every result here is `semantics: "exact"`, in contrast to
 * `analyzeModelPair`'s and `checkClearance`'s `"approximate"`: those methods
 * sample a bounded set of points (each triangle's vertices and centroid)
 * against the opposite surface, so a smaller true distance can exist between
 * samples. `snap-point` and `point-to-surface` instead query
 * `TriangleSpatialIndex.nearestTriangle` directly against the query point --
 * an exhaustive, exact nearest-triangle search over every triangle via the
 * same accelerated BVH the rest of this package uses, not a sampled subset
 * -- so the returned point and distance are exact for the tessellated
 * surface as given. `point-to-point` is exact ordinary vector arithmetic on
 * the two supplied coordinates, with no claim that either point actually
 * lies on any surface. `bounding-extent` is an exact min/max over the placed
 * vertex positions. **"Exact" is a claim about the tessellated triangle
 * mesh, not about any original curved or CAD geometry that mesh
 * approximates** -- the same distinction this package's other exact results
 * (`axis-aligned-box-solid`, `checkClearance`'s `interference.trianglePairs`)
 * already draw.
 *
 * **`snap-point`.** Given `at: { kind: "point", point }`, returns the exact
 * closest point on the surface to `point` (reusing
 * `TriangleSpatialIndex.nearestTriangle` and `closestPointOnTriangle`, the
 * same primitives every other exact-nearest-point query in this package
 * uses). Given `at: { kind: "ray", origin, direction }` -- the shape a
 * click-to-measure UI casts from a camera through a clicked pixel -- returns
 * the exact nearest ray/triangle intersection point (a genuine ray cast,
 * Moller-Trumbore, over every triangle; see `castRay` below), or
 * `{ hit: false, reason: "ray-missed-surface" }` when the ray crosses no
 * triangle, which is an honest outcome, not a thrown error. Either way, the
 * resulting point is then classified against its containing triangle's
 * three vertices and three edges: `snap: { kind: "vertex", ... }` when the
 * point is within `snapToleranceMillimetres` of a vertex (checked first,
 * since a point within tolerance of a vertex is always within tolerance of
 * every edge touching that vertex too -- vertex is the more specific,
 * preferred classification); else `snap: { kind: "edge", ... }` when within
 * tolerance of an edge; else `snap: { kind: "face" }` (interior, unsnapped).
 * This is what makes click-to-measure precise: the UI does not need its own
 * approximate raycast/snap logic.
 *
 * **`point-to-point`.** The straight-line distance between two supplied
 * points plus their axis-aligned componentwise delta (`second - first`).
 * Pure arithmetic -- this query kind does not read the model's geometry at
 * all (the two points are typically obtained from prior `snap-point`
 * calls), included here only so a full measurement workflow lives behind
 * one function.
 *
 * **`point-to-surface`.** The exact shortest distance from a supplied point
 * to the model's surface, with the closest surface point and the triangle
 * it lies on. Works identically whether the query point is outside, on, or
 * "inside" the surface (this package makes no inside/outside claim -- see
 * `checkClearance`'s doc comment for why general triangle meshes have no
 * validated solid-volume domain here).
 *
 * **`bounding-extent`.** Overall dimensions and axis-aligned bounds, reused
 * unmodified from `summarizeModelGeometry`'s own bounds computation (the
 * same one `analyzeModelPair`'s comparison summary and `inspectModel` use)
 * rather than a second, differently-computed bounds pass.
 *
 * **Resource discipline.** Every query kind -- including `point-to-point`
 * and `bounding-extent`, which do not need a spatial index -- first
 * validates `model` against `normalizedModelSchema` and checks its expanded
 * vertex/triangle counts (plus estimated memory, honoring an optional
 * caller-supplied `executionBudget.maxMemoryBytes` no larger than this
 * package's own ceiling) via `checkExpandedGeometryBudget`, the same
 * pre-flight `checkClearance` and `estimateAlignment` use, throwing
 * `MeasurementResourceLimitError` before any O(vertices + triangles) work
 * runs if that fails -- a uniform, predictable resource contract across
 * query kinds, even where a specific kind's own work is trivial.
 * `snap-point` and `point-to-surface` additionally flatten the model and
 * build a `TriangleSpatialIndex` under a charge-before-work `WorkBudget`
 * (bounded by `executionBudget.maxWorkUnits`, reusing `ANALYSIS_LIMITS` and
 * `WorkBudget` from `src/analyze.ts` unchanged); an exhausted budget throws
 * `WorkBudgetExceeded` unchanged, matching every other entry point in this
 * package. `snapToleranceMillimetres` and other invalid query input (a
 * non-finite point, a degenerate ray direction) throw
 * `RangeError`/`MeasurementInputError` respectively, matching
 * `InspectOptions`'s and `EstimateAlignmentOptions`'s conventions.
 *
 * **Determinism.** Identical input produces a deeply equal
 * `MeasurementResult` every time: `TriangleSpatialIndex` traversal is
 * deterministic (see `src/spatial-index.ts`), `castRay` resolves ties at
 * identical intersection distance by ascending triangle index, and no step
 * here introduces randomness.
 */
export function measureOnModel(
  model: NormalizedModel,
  query: MeasurementQuery,
  options: MeasureOptions = {},
): MeasurementResult {
  const validated = normalizedModelSchema.parse(model);
  const modelToComparison =
    options.modelToComparison === undefined
      ? IDENTITY_RIGID
      : rigidTransformSchema.parse(options.modelToComparison);
  const snapTolerance = resolveMillimetreBound(
    options.snapToleranceMillimetres,
    DEFAULT_SNAP_TOLERANCE_MILLIMETRES,
    MAX_SNAP_TOLERANCE_MILLIMETRES,
    "snapToleranceMillimetres",
  );

  const counts = countExpandedGeometry(validated);
  const budgetProblem = checkExpandedGeometryBudget(
    counts.vertices,
    counts.triangles,
    options.executionBudget,
  );
  if (budgetProblem !== undefined) {
    throw new MeasurementResourceLimitError(budgetProblem);
  }

  if (query.kind === "point-to-point") {
    return measurePointToPoint(query);
  }
  if (query.kind === "bounding-extent") {
    return measureBoundingExtent(validated, modelToComparison);
  }

  const workLimit = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    options.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  const work = new WorkBudget(workLimit);

  let geometry: FlatGeometry;
  try {
    geometry = flattenModel(validated, modelToComparison, work);
  } catch (error) {
    if (
      error instanceof WorkBudgetExceeded ||
      error instanceof WorkBudgetInternalError
    ) {
      throw error;
    }
    throw new MeasurementInputError(
      error instanceof Error ? error.message : "Comparison transform failed.",
    );
  }
  if (geometry.triangleCount === 0) {
    throw new MeasurementInputError(
      "snap-point and point-to-surface require at least one triangle after flattening.",
    );
  }
  const index = new TriangleSpatialIndex(geometry, work);

  if (query.kind === "point-to-surface") {
    return measurePointToSurface(query, geometry, index, work);
  }
  return measureSnapPoint(query, geometry, index, work, snapTolerance);
}

function resolveMillimetreBound(
  value: number | undefined,
  fallback: number,
  ceiling: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > ceiling) {
    throw new RangeError(
      `${name} must be a finite number between 0 and ${ceiling}; received ${String(value)}.`,
    );
  }
  return value;
}

function validateFiniteVec3(point: Vec3, label: string): void {
  if (!point.every((value) => Number.isFinite(value))) {
    throw new MeasurementInputError(
      `${label} must have finite x/y/z coordinates.`,
    );
  }
}

function measurePointToPoint(query: PointToPointQuery): PointToPointResult {
  validateFiniteVec3(query.first, "first");
  validateFiniteVec3(query.second, "second");
  const deltaMillimetres: Vec3 = [
    normalizeZero(query.second[0] - query.first[0]),
    normalizeZero(query.second[1] - query.first[1]),
    normalizeZero(query.second[2] - query.first[2]),
  ];
  return {
    kind: "point-to-point",
    semantics: "exact",
    firstMillimetres: query.first,
    secondMillimetres: query.second,
    distanceMillimetres: Math.hypot(...deltaMillimetres),
    deltaMillimetres,
  };
}

function measureBoundingExtent(
  model: NormalizedModel,
  modelToComparison: Mat4,
): BoundingExtentResult {
  const summary = summarizeModelGeometry(model, modelToComparison);
  return {
    kind: "bounding-extent",
    semantics: "exact",
    bounds: summary.bounds,
  };
}

function measurePointToSurface(
  query: PointToSurfaceQuery,
  geometry: FlatGeometry,
  index: TriangleSpatialIndex,
  work: WorkUnitCounter,
): PointToSurfaceResult {
  validateFiniteVec3(query.point, "point");
  const [px, py, pz] = query.point;
  const nearest = index.nearestTriangle(px, py, pz, work);
  const closest = closestPointOnTriangleIndex(
    geometry,
    nearest.triangleIndex,
    px,
    py,
    pz,
  );
  return {
    kind: "point-to-surface",
    semantics: "exact",
    queryPointMillimetres: query.point,
    closestPointMillimetres: closest,
    distanceMillimetres: nearest.distance,
    triangleIndex: nearest.triangleIndex,
  };
}

function closestPointOnTriangleIndex(
  geometry: FlatGeometry,
  triangleIndex: number,
  px: number,
  py: number,
  pz: number,
): Vec3 {
  const base = triangleIndex * 3;
  const ia = geometry.indices[base]!;
  const ib = geometry.indices[base + 1]!;
  const ic = geometry.indices[base + 2]!;
  return closestPointOnTriangle(px, py, pz, geometry.positions, ia, ib, ic);
}

function measureSnapPoint(
  query: SnapPointQuery,
  geometry: FlatGeometry,
  index: TriangleSpatialIndex,
  work: WorkUnitCounter,
  snapTolerance: number,
): SnapPointResult {
  const at = query.at;
  let point: Vec3;
  let triangleIndex: number;
  if (at.kind === "point") {
    validateFiniteVec3(at.point, "at.point");
    const [px, py, pz] = at.point;
    const nearest = index.nearestTriangle(px, py, pz, work);
    point = closestPointOnTriangleIndex(
      geometry,
      nearest.triangleIndex,
      px,
      py,
      pz,
    );
    triangleIndex = nearest.triangleIndex;
  } else {
    validateFiniteVec3(at.origin, "at.origin");
    validateFiniteVec3(at.direction, "at.direction");
    const length = Math.hypot(
      at.direction[0],
      at.direction[1],
      at.direction[2],
    );
    if (!(length > 0)) {
      throw new MeasurementInputError(
        "snap-point ray queries require a non-degenerate, finite direction vector.",
      );
    }
    const hit = castRay(geometry, at.origin, at.direction, work);
    if (hit === undefined) {
      return {
        kind: "snap-point",
        semantics: "exact",
        snapToleranceMillimetres: snapTolerance,
        outcome: { hit: false, reason: "ray-missed-surface" },
      };
    }
    point = hit.point;
    triangleIndex = hit.triangleIndex;
  }

  const snap = classifySnap(geometry, triangleIndex, point, snapTolerance);
  return {
    kind: "snap-point",
    semantics: "exact",
    snapToleranceMillimetres: snapTolerance,
    outcome: { hit: true, pointMillimetres: point, triangleIndex, snap },
  };
}

/**
 * Classifies `point` (already known to lie exactly on `triangleIndex`)
 * against that triangle's three vertices and three edges. Vertex distance is
 * always >= the distance to either edge touching that vertex (the vertex is
 * an endpoint of the edge's own closest-point search), so checking vertices
 * first and edges second, rather than the reverse, always yields the more
 * specific classification when both would be within tolerance.
 */
function classifySnap(
  geometry: FlatGeometry,
  triangleIndex: number,
  point: Vec3,
  tolerance: number,
): SnapClassification {
  const base = triangleIndex * 3;
  const ia = geometry.indices[base]!;
  const ib = geometry.indices[base + 1]!;
  const ic = geometry.indices[base + 2]!;
  const positions = geometry.positions;
  const readVertex = (index: number): Vec3 => [
    positions[index * 3]!,
    positions[index * 3 + 1]!,
    positions[index * 3 + 2]!,
  ];
  const vertices: readonly Vec3[] = [
    readVertex(ia),
    readVertex(ib),
    readVertex(ic),
  ];

  let nearestVertexIndex = 0;
  let nearestVertexDistance = distance(point, vertices[0]!);
  for (let index = 1; index < 3; index += 1) {
    const candidate = distance(point, vertices[index]!);
    if (candidate < nearestVertexDistance) {
      nearestVertexDistance = candidate;
      nearestVertexIndex = index;
    }
  }
  if (nearestVertexDistance <= tolerance) {
    return {
      kind: "vertex",
      positionMillimetres: vertices[nearestVertexIndex]!,
    };
  }

  const edges: readonly (readonly [Vec3, Vec3])[] = [
    [vertices[0]!, vertices[1]!],
    [vertices[1]!, vertices[2]!],
    [vertices[2]!, vertices[0]!],
  ];
  let nearestEdgeIndex = 0;
  let nearestEdgeDistance = distanceToSegment(
    point,
    edges[0]![0],
    edges[0]![1],
  );
  for (let index = 1; index < 3; index += 1) {
    const [p0, p1] = edges[index]!;
    const candidate = distanceToSegment(point, p0, p1);
    if (candidate < nearestEdgeDistance) {
      nearestEdgeDistance = candidate;
      nearestEdgeIndex = index;
    }
  }
  if (nearestEdgeDistance <= tolerance) {
    return { kind: "edge", endpointsMillimetres: edges[nearestEdgeIndex]! };
  }
  return { kind: "face" };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const abLengthSquared = abx * abx + aby * aby + abz * abz;
  const t =
    abLengthSquared === 0
      ? 0
      : clamp((apx * abx + apy * aby + apz * abz) / abLengthSquared, 0, 1);
  const cx = a[0] + abx * t;
  const cy = a[1] + aby * t;
  const cz = a[2] + abz * t;
  return Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
}

/**
 * Threshold on `det^2 / (|direction|^2 * |normal|^2)` (approximately `sin^2`
 * of the angle between the ray direction and the triangle's plane) below
 * which the ray is treated as parallel to the triangle's plane and that
 * triangle is skipped -- the same relative-magnitude discipline
 * `COPLANAR_EPSILON` in `src/triangle-triangle.ts` uses for an analogous
 * plane-parallelism decision, for the same reason: this cannot be an exact
 * `=== 0` test on a floating-point determinant computed from independently
 * supplied coordinates. `1e-20` requires near-exact parallelism (~1e-10
 * radians), so no genuinely intersecting ray is ever misrouted into being
 * skipped. A triangle whose own three vertices are exactly collinear
 * (zero area) has a zero normal, which this same relative test also treats
 * as unhittable from every direction -- an honest "no hit" rather than a
 * division that could otherwise produce a spurious intersection.
 */
const RAY_PARALLEL_RELATIVE_EPSILON = 1e-20;

/** Charged per triangle tested during `castRay`'s linear scan -- there is no ray-accelerated traversal of `TriangleSpatialIndex` today, only its point-nearest-neighbor traversal, so every triangle is tested exactly once per ray query. */
const RAY_TRIANGLE_WORK_UNITS = 12;

/**
 * Exact ray/triangle-mesh intersection: the Moller-Trumbore algorithm
 * (Moller & Trumbore, "Fast, Minimum Storage Ray-Triangle Intersection",
 * Journal of Graphics Tools, 1997), applied to every triangle in `geometry`
 * (a full linear scan -- see `RAY_TRIANGLE_WORK_UNITS`), returning the
 * closest intersection at or ahead of `origin` (`t >= 0`; touching a
 * triangle's edge or vertex counts as a hit, `u, v, u + v` all tested
 * inclusively, consistent with `trianglesIntersect`'s touching-counts
 * convention in `src/triangle-triangle.ts`). Ties at identical `t` are
 * resolved by ascending triangle index (the first triangle reached in
 * `geometry`'s own order wins), for determinism.
 */
function castRay(
  geometry: FlatGeometry,
  origin: Vec3,
  direction: Vec3,
  work: WorkUnitCounter,
): { readonly point: Vec3; readonly triangleIndex: number } | undefined {
  const positions = geometry.positions;
  const indices = geometry.indices;
  const triangleCount = geometry.triangleCount;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = direction;
  const dirLengthSquared = dx * dx + dy * dy + dz * dz;

  let bestT = Number.POSITIVE_INFINITY;
  let bestTriangle = -1;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    work.charge(RAY_TRIANGLE_WORK_UNITS);
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

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const normalLengthSquared = nx * nx + ny * ny + nz * nz;

    const pvx = dy * e2z - dz * e2y;
    const pvy = dz * e2x - dx * e2z;
    const pvz = dx * e2y - dy * e2x;
    const det = e1x * pvx + e1y * pvy + e1z * pvz;
    if (
      det * det <=
      RAY_PARALLEL_RELATIVE_EPSILON * dirLengthSquared * normalLengthSquared
    ) {
      continue;
    }
    const invDet = 1 / det;

    const tvx = ox - ax;
    const tvy = oy - ay;
    const tvz = oz - az;
    const u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
    if (u < 0 || u > 1) continue;

    const qvx = tvy * e1z - tvz * e1y;
    const qvy = tvz * e1x - tvx * e1z;
    const qvz = tvx * e1y - tvy * e1x;
    const v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
    if (v < 0 || u + v > 1) continue;

    const t = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
    if (t < 0) continue;

    if (t < bestT) {
      bestT = t;
      bestTriangle = triangle;
    }
  }

  if (bestTriangle === -1) return undefined;
  const point: Vec3 = [
    normalizeZero(ox + dx * bestT),
    normalizeZero(oy + dy * bestT),
    normalizeZero(oz + dz * bestT),
  ];
  return { point, triangleIndex: bestTriangle };
}
