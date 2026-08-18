import type { Vec3 } from "@voxelspy/contracts";

import type { FlatGeometry, WorkUnitCounter } from "../src/geometry.js";

/**
 * Deterministic seeded PRNG (mulberry32). Never use `Math.random` in these
 * property/adversarial tests: every generated fixture must be reproducible
 * bit-for-bit across runs and machines.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A no-op work counter for property tests that only care about correctness. */
export const UNMETERED_WORK: WorkUnitCounter = { charge: () => undefined };

export function randomInRange(
  rng: () => number,
  min: number,
  max: number,
): number {
  return min + rng() * (max - min);
}

export function randomVec3(rng: () => number, scale: number): Vec3 {
  return [
    randomInRange(rng, -scale, scale),
    randomInRange(rng, -scale, scale),
    randomInRange(rng, -scale, scale),
  ];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVec(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function distSq(a: Vec3, b: Vec3): number {
  const d = sub(a, b);
  return dot(d, d);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Builds a facet-local (non-indexed-sharing) `FlatGeometry` directly from
 * triangle triples, bypassing the `NormalizedModel` schema entirely. Used by
 * the spatial-index and point-triangle property tests, which only need valid
 * typed-array geometry -- not a full normalized model -- and in several cases
 * (collinear/zero-area triangles, all-identical triangles) construct
 * geometry the model schema would still accept but that is easier to reason
 * about built directly.
 */
export function flatGeometryFromTriangles(
  triangles: readonly (readonly [Vec3, Vec3, Vec3])[],
): FlatGeometry {
  const positions = new Float64Array(triangles.length * 9);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, triangleIndex) => {
    triangle.forEach((vertex, corner) => {
      positions.set(vertex, (triangleIndex * 3 + corner) * 3);
    });
    indices[triangleIndex * 3] = triangleIndex * 3;
    indices[triangleIndex * 3 + 1] = triangleIndex * 3 + 1;
    indices[triangleIndex * 3 + 2] = triangleIndex * 3 + 2;
  });
  return {
    positions,
    indices,
    vertexCount: triangles.length * 3,
    triangleCount: triangles.length,
  };
}

/** Uniform-random triangles inside a `[-scale, scale]^3` cube. */
export function randomTriangleCloud(
  rng: () => number,
  count: number,
  scale: number,
): [Vec3, Vec3, Vec3][] {
  const triangles: [Vec3, Vec3, Vec3][] = [];
  for (let index = 0; index < count; index += 1) {
    triangles.push([
      randomVec3(rng, scale),
      randomVec3(rng, scale),
      randomVec3(rng, scale),
    ]);
  }
  return triangles;
}

/**
 * Needle-thin ("sliver") triangles: one long edge and one vertex offset by a
 * tiny perpendicular-ish amount, giving triangles with area near (but not
 * exactly) zero.
 */
export function sliverTriangleCloud(
  rng: () => number,
  count: number,
  scale: number,
): [Vec3, Vec3, Vec3][] {
  const triangles: [Vec3, Vec3, Vec3][] = [];
  for (let index = 0; index < count; index += 1) {
    const a = randomVec3(rng, scale);
    const direction = randomVec3(rng, 1);
    const length = randomInRange(rng, scale * 0.1, scale);
    const b = add(a, scaleVec(direction, length));
    const tinyOffset = randomInRange(rng, 1e-6, 1e-3) * scale;
    const perpendicular = randomVec3(rng, 1);
    const c = add(a, scaleVec(perpendicular, tinyOffset));
    triangles.push([a, b, c]);
  }
  return triangles;
}

/** Exactly collinear (true zero-area, not just numerically small) triangles. */
export function collinearTriangleCloud(
  rng: () => number,
  count: number,
  scale: number,
): [Vec3, Vec3, Vec3][] {
  const triangles: [Vec3, Vec3, Vec3][] = [];
  for (let index = 0; index < count; index += 1) {
    const a = randomVec3(rng, scale);
    const direction = randomVec3(rng, 1);
    const b = add(a, scaleVec(direction, randomInRange(rng, -scale, scale)));
    const c = add(a, scaleVec(direction, randomInRange(rng, -scale, scale)));
    triangles.push([a, b, c]);
  }
  return triangles;
}

/** Every triangle bit-identical: all bounds and Morton codes coincide. */
export function identicalTriangleCloud(
  triangle: readonly [Vec3, Vec3, Vec3],
  count: number,
): [Vec3, Vec3, Vec3][] {
  return Array.from({ length: count }, () => [
    [...triangle[0]],
    [...triangle[1]],
    [...triangle[2]],
  ]) as [Vec3, Vec3, Vec3][];
}

export function randomQueryPoints(
  rng: () => number,
  count: number,
  scale: number,
): Vec3[] {
  const points: Vec3[] = [];
  for (let index = 0; index < count; index += 1) {
    points.push(randomVec3(rng, scale));
  }
  return points;
}

/** Squared distance from a point to a closed segment [a, b]. */
export function distSqToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const abLengthSquared = dot(ab, ab);
  const t =
    abLengthSquared === 0
      ? 0
      : clamp(dot(sub(p, a), ab) / abLengthSquared, 0, 1);
  const closest = add(a, scaleVec(ab, t));
  return distSq(p, closest);
}

/**
 * Independent reference for squared point-to-triangle distance, deliberately
 * structured differently from `pointTriangleDistanceSquared`'s Voronoi-region
 * case analysis (Ericson's algorithm): this projects the query point onto
 * the triangle's plane, classifies the foot point with signed sub-triangle
 * barycentric weights, and falls back to the nearest of the three boundary
 * segments when the foot lands outside the triangle. Used to cross-check the
 * production routine over a seeded random sweep.
 */
export function referencePointTriangleDistanceSquared(
  p: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const normal = cross(ab, ac);
  const normalLengthSquared = dot(normal, normal);

  const boundaryDistanceSquared = () =>
    Math.min(
      distSqToSegment(p, a, b),
      distSqToSegment(p, b, c),
      distSqToSegment(p, c, a),
    );

  if (normalLengthSquared === 0) {
    // Degenerate (zero-area) triangle: no interior region exists.
    return boundaryDistanceSquared();
  }

  const ap = sub(p, a);
  const signedPlaneDistance = dot(ap, normal) / Math.sqrt(normalLengthSquared);
  const foot = sub(p, scaleVec(normal, dot(ap, normal) / normalLengthSquared));

  // Signed sub-triangle areas (relative to `normal`), a barycentric
  // formulation independent of the dot-product parametric tests the
  // production routine uses.
  const u =
    dot(cross(sub(b, foot), sub(c, foot)), normal) / normalLengthSquared;
  const v =
    dot(cross(sub(c, foot), sub(a, foot)), normal) / normalLengthSquared;
  const w =
    dot(cross(sub(a, foot), sub(b, foot)), normal) / normalLengthSquared;

  if (u >= 0 && v >= 0 && w >= 0) {
    return signedPlaneDistance * signedPlaneDistance;
  }
  return boundaryDistanceSquared();
}

/** The next representable Float64 strictly above `value` (one ULP up). */
export function oneUlpUp(value: number): number {
  const buffer = new ArrayBuffer(8);
  const floats = new Float64Array(buffer);
  const ints = new BigInt64Array(buffer);
  floats[0] = value;
  ints[0] = value >= 0 ? ints[0]! + 1n : ints[0]! - 1n;
  return floats[0]!;
}

export function rotationZ(
  radians: number,
): [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, 0, 0, -sin, cos, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function scaleTransform(
  x: number,
  y: number,
  z: number,
): [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}
