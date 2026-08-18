/**
 * Exact triangle-triangle intersection testing, used only by `checkClearance`
 * (`src/clearance.ts`) to report interference evidence -- concrete triangle
 * pairs whose surfaces actually overlap, independent of sampling. Nothing
 * else in this package needs this: `surface-distance` and `checkClearance`'s
 * own tight-region/minimum-distance reporting both work by sampling points
 * against `TriangleSpatialIndex`, never by testing triangle pairs directly.
 *
 * `trianglesIntersect` assumes both input triangles are non-degenerate
 * (finite, nonzero area) -- callers must reject degenerate triangles first
 * (as `checkClearance` does via the same `degenerate-triangles` precondition
 * `surface-distance` requires) since a zero-area triangle has no well-defined
 * plane normal for this test to use.
 *
 * The algorithm is Moller's separating-plane triangle-triangle test ("A Fast
 * Triangle-Triangle Intersection Test", Journal of Graphics Tools, 1997):
 * each triangle's plane is first used to try to separate the other
 * triangle's three vertices (cheap early rejection); if neither plane
 * separates, the general (non-coplanar) case is decided by testing each of
 * the six triangle edges against the opposite triangle as a
 * segment-vs-triangle test, and the genuinely-coplanar case (the two planes
 * parallel) falls back to a 2D projected triangle-overlap test.
 *
 * Every comparison here is an exact floating-point sign comparison (`> 0`,
 * `< 0`, `=== 0`, matching this package's no-tolerance-welding philosophy --
 * see "Topology semantics" in ../README.md) with exactly one disclosed
 * exception: deciding whether the two triangles' planes are parallel enough
 * to require the coplanar 2D fallback cannot be an exact `=== 0` test on
 * floating-point cross products computed from independently transformed
 * geometry (two geometrically coincident planes computed via different
 * vertex triples will not generally produce a bit-identical zero cross
 * product), so that one decision uses a small relative-magnitude threshold
 * (`COPLANAR_EPSILON`). Touching -- a shared point, edge, or coincident face
 * -- counts as intersecting throughout (all comparisons are inclusive of the
 * boundary), consistent with `checkClearance` treating coincident surfaces
 * as interference.
 */

type V3 = readonly [number, number, number];

/**
 * Threshold on `|cross(N1, N2)|^2 / (|N1|^2 * |N2|^2)` (approximately
 * `sin^2` of the angle between the two triangles' plane normals) below which
 * the planes are treated as parallel and the coplanar 2D fallback is used.
 * `1e-20` requires the planes to be parallel to within roughly 1e-10 radians
 * of angle -- far tighter than any genuine rotation this package's fixtures
 * or callers use, so real non-parallel triangles are never misrouted into
 * the coplanar path.
 */
const COPLANAR_EPSILON = 1e-20;

function sub3(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function allStrictlySameSign(
  values: readonly [number, number, number],
): boolean {
  const [a, b, c] = values;
  return (a > 0 && b > 0 && c > 0) || (a < 0 && b < 0 && c < 0);
}

/** Index of the largest-magnitude component of `n`, the axis to drop when projecting into 2D. */
function dominantAxis(n: V3): 0 | 1 | 2 {
  const absX = Math.abs(n[0]);
  const absY = Math.abs(n[1]);
  const absZ = Math.abs(n[2]);
  if (absX >= absY && absX >= absZ) return 0;
  if (absY >= absZ) return 1;
  return 2;
}

function project(v: V3, dropAxis: 0 | 1 | 2): readonly [number, number] {
  if (dropAxis === 0) return [v[1], v[2]];
  if (dropAxis === 1) return [v[0], v[2]];
  return [v[0], v[1]];
}

function orientation2D(
  p: readonly [number, number],
  q: readonly [number, number],
  r: readonly [number, number],
): -1 | 0 | 1 {
  const value = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** Whether `q` lies within the axis-aligned bounding box of `p` and `r`, given `p`, `q`, `r` are already known collinear. */
function onSegment2D(
  p: readonly [number, number],
  q: readonly [number, number],
  r: readonly [number, number],
): boolean {
  return (
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1])
  );
}

/** Inclusive 2D segment-segment intersection (touching endpoints, and collinear overlap, both count). */
function segmentsIntersect2D(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): boolean {
  const o1 = orientation2D(p1, p2, p3);
  const o2 = orientation2D(p1, p2, p4);
  const o3 = orientation2D(p3, p4, p1);
  const o4 = orientation2D(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment2D(p1, p3, p2)) return true;
  if (o2 === 0 && onSegment2D(p1, p4, p2)) return true;
  if (o3 === 0 && onSegment2D(p3, p1, p4)) return true;
  if (o4 === 0 && onSegment2D(p3, p2, p4)) return true;
  return false;
}

/** Inclusive 2D point-in-triangle (boundary counts as inside). */
function pointInTriangle2D(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): boolean {
  const d1 = orientation2D(a, b, p);
  const d2 = orientation2D(b, c, p);
  const d3 = orientation2D(c, a, p);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/** Inclusive 2D overlap test between two triangles, projected by dropping `axis`. */
function trianglesOverlap2D(
  axis: 0 | 1 | 2,
  a0: V3,
  a1: V3,
  a2: V3,
  b0: V3,
  b1: V3,
  b2: V3,
): boolean {
  const pa0 = project(a0, axis);
  const pa1 = project(a1, axis);
  const pa2 = project(a2, axis);
  const pb0 = project(b0, axis);
  const pb1 = project(b1, axis);
  const pb2 = project(b2, axis);
  const edgesA: (readonly [
    readonly [number, number],
    readonly [number, number],
  ])[] = [
    [pa0, pa1],
    [pa1, pa2],
    [pa2, pa0],
  ];
  const edgesB: (readonly [
    readonly [number, number],
    readonly [number, number],
  ])[] = [
    [pb0, pb1],
    [pb1, pb2],
    [pb2, pb0],
  ];
  for (const [p1, p2] of edgesA) {
    for (const [p3, p4] of edgesB) {
      if (segmentsIntersect2D(p1, p2, p3, p4)) return true;
    }
  }
  if (pointInTriangle2D(pa0, pb0, pb1, pb2)) return true;
  if (pointInTriangle2D(pb0, pa0, pa1, pa2)) return true;
  return false;
}

/** Inclusive test: does segment `[p0, p1]` intersect triangle `(a, b, c)`, whose plane normal is `n`? */
function segmentIntersectsTriangle(
  p0: V3,
  p1: V3,
  a: V3,
  b: V3,
  c: V3,
  n: V3,
): boolean {
  const d = -dot3(n, a);
  const s0 = dot3(n, p0) + d;
  const s1 = dot3(n, p1) + d;
  if (s0 > 0 && s1 > 0) return false;
  if (s0 < 0 && s1 < 0) return false;
  if (s0 === 0 && s1 === 0) {
    // The whole segment lies exactly in the triangle's plane: fall back to
    // the 2D projected test (segment-vs-each-edge, plus either endpoint
    // contained) rather than dividing by zero below.
    const axis = dominantAxis(n);
    const pp0 = project(p0, axis);
    const pp1 = project(p1, axis);
    const pa = project(a, axis);
    const pb = project(b, axis);
    const pc = project(c, axis);
    return (
      segmentsIntersect2D(pp0, pp1, pa, pb) ||
      segmentsIntersect2D(pp0, pp1, pb, pc) ||
      segmentsIntersect2D(pp0, pp1, pc, pa) ||
      pointInTriangle2D(pp0, pa, pb, pc) ||
      pointInTriangle2D(pp1, pa, pb, pc)
    );
  }
  const t = s0 / (s0 - s1);
  const point: V3 = [
    p0[0] + (p1[0] - p0[0]) * t,
    p0[1] + (p1[1] - p0[1]) * t,
    p0[2] + (p1[2] - p0[2]) * t,
  ];
  const axis = dominantAxis(n);
  return pointInTriangle2D(
    project(point, axis),
    project(a, axis),
    project(b, axis),
    project(c, axis),
  );
}

/**
 * Exact test for whether triangle `(a0, a1, a2)` and triangle `(b0, b1, b2)`
 * intersect (including touching at a shared point, edge, or coincident
 * face). See the module doc comment for the algorithm and its one disclosed
 * floating-point tolerance.
 */
function trianglesIntersectVectors(
  a0: V3,
  a1: V3,
  a2: V3,
  b0: V3,
  b1: V3,
  b2: V3,
): boolean {
  const normalA = cross3(sub3(a1, a0), sub3(a2, a0));
  const dA = -dot3(normalA, a0);
  const distancesOfBToA: [number, number, number] = [
    dot3(normalA, b0) + dA,
    dot3(normalA, b1) + dA,
    dot3(normalA, b2) + dA,
  ];
  if (allStrictlySameSign(distancesOfBToA)) return false;

  const normalB = cross3(sub3(b1, b0), sub3(b2, b0));
  const dB = -dot3(normalB, b0);
  const distancesOfAToB: [number, number, number] = [
    dot3(normalB, a0) + dB,
    dot3(normalB, a1) + dB,
    dot3(normalB, a2) + dB,
  ];
  if (allStrictlySameSign(distancesOfAToB)) return false;

  const crossNormals = cross3(normalA, normalB);
  const crossLengthSquared = dot3(crossNormals, crossNormals);
  const normalScale = dot3(normalA, normalA) * dot3(normalB, normalB);
  if (crossLengthSquared <= COPLANAR_EPSILON * normalScale) {
    // Neither plane separated the other triangle's vertices, and the planes
    // are parallel: since parallel-but-distinct planes would already have
    // been rejected above (every distance would share one nonzero sign),
    // this can only happen when the two planes coincide.
    const axis = dominantAxis(normalA);
    return trianglesOverlap2D(axis, a0, a1, a2, b0, b1, b2);
  }

  return (
    segmentIntersectsTriangle(a0, a1, b0, b1, b2, normalB) ||
    segmentIntersectsTriangle(a1, a2, b0, b1, b2, normalB) ||
    segmentIntersectsTriangle(a2, a0, b0, b1, b2, normalB) ||
    segmentIntersectsTriangle(b0, b1, a0, a1, a2, normalA) ||
    segmentIntersectsTriangle(b1, b2, a0, a1, a2, normalA) ||
    segmentIntersectsTriangle(b2, b0, a0, a1, a2, normalA)
  );
}

/**
 * Exact triangle-triangle intersection test reading vertex coordinates
 * directly out of two (possibly distinct) typed-array position buffers by
 * index, matching this package's convention of avoiding intermediate
 * per-vertex objects at call sites that read `FlatGeometry` (see
 * `pointTriangleDistanceSquared` in `src/geometry.ts`). Only called on
 * bounded candidate pairs already filtered by AABB overlap
 * (`TriangleSpatialIndex.overlapping`), not in a hot per-sample loop, so the
 * small tuple allocations inside this module are immaterial.
 */
export function trianglesIntersect(
  positionsA: Float64Array,
  ia0: number,
  ia1: number,
  ia2: number,
  positionsB: Float64Array,
  ib0: number,
  ib1: number,
  ib2: number,
): boolean {
  const readVertex = (positions: Float64Array, index: number): V3 => [
    positions[index * 3]!,
    positions[index * 3 + 1]!,
    positions[index * 3 + 2]!,
  ];
  return trianglesIntersectVectors(
    readVertex(positionsA, ia0),
    readVertex(positionsA, ia1),
    readVertex(positionsA, ia2),
    readVertex(positionsB, ib0),
    readVertex(positionsB, ib1),
    readVertex(positionsB, ib2),
  );
}
