import type { Vec3 } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import { pointTriangleDistanceSquared } from "../src/geometry.js";
import type { FlatGeometry } from "../src/geometry.js";
import { TriangleSpatialIndex } from "../src/spatial-index.js";
import {
  UNMETERED_WORK,
  collinearTriangleCloud,
  flatGeometryFromTriangles,
  identicalTriangleCloud,
  mulberry32,
  randomQueryPoints,
  randomTriangleCloud,
  randomVec3,
  rotationZ,
  sliverTriangleCloud,
} from "./test-utils.js";

/**
 * Ground truth for `TriangleSpatialIndex.distance`: scan every triangle with
 * the exact same `pointTriangleDistanceSquared` routine the index itself
 * calls at its leaves, then take the minimum. Because both paths route
 * through the identical scalar subroutine and both apply exactly one
 * `Math.sqrt` to the minimal squared distance found, the accelerated result
 * is expected to be bit-for-bit identical to this brute-force result, not
 * merely close to it -- any observed mismatch would mean the BVH pruning
 * skipped the true nearest triangle, a real correctness defect.
 */
function bruteForceDistance(geometry: FlatGeometry, point: Vec3): number {
  let minimumSquared = Number.POSITIVE_INFINITY;
  const positions = geometry.positions;
  const indices = geometry.indices;
  for (let triangle = 0; triangle < geometry.triangleCount; triangle += 1) {
    const base = triangle * 3;
    const ia = indices[base]!;
    const ib = indices[base + 1]!;
    const ic = indices[base + 2]!;
    const squared = pointTriangleDistanceSquared(
      point[0],
      point[1],
      point[2],
      positions,
      ia,
      ib,
      ic,
    );
    if (squared < minimumSquared) minimumSquared = squared;
  }
  return Math.sqrt(minimumSquared);
}

function assertMatchesBruteForce(
  geometry: FlatGeometry,
  queryPoints: readonly Vec3[],
): void {
  const index = new TriangleSpatialIndex(geometry, UNMETERED_WORK);
  for (const point of queryPoints) {
    const accelerated = index.distance(
      point[0],
      point[1],
      point[2],
      UNMETERED_WORK,
    );
    const brute = bruteForceDistance(geometry, point);
    expect(accelerated).toBe(brute);
  }
}

function rotateTriangles(
  triangles: readonly (readonly [Vec3, Vec3, Vec3])[],
  radians: number,
): [Vec3, Vec3, Vec3][] {
  const matrix = rotationZ(radians);
  const rotatePoint = (point: Vec3): Vec3 => [
    matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2],
    matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2],
    matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2],
  ];
  return triangles.map(
    ([a, b, c]) =>
      [rotatePoint(a), rotatePoint(b), rotatePoint(c)] as [Vec3, Vec3, Vec3],
  );
}

describe("TriangleSpatialIndex vs. brute force (property)", () => {
  it("matches brute force exactly across varied seeded triangle-cloud scales", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const scale of [0.001, 1, 1_000, 1_000_000]) {
        const rng = mulberry32(seed * 1000 + scale);
        const triangles = randomTriangleCloud(rng, 200, scale);
        const geometry = flatGeometryFromTriangles(triangles);
        const queryPoints = randomQueryPoints(rng, 40, scale * 2);
        assertMatchesBruteForce(geometry, queryPoints);
      }
    }
  });

  it("matches brute force exactly for needle-thin sliver triangles", () => {
    const rng = mulberry32(42);
    const triangles = sliverTriangleCloud(rng, 300, 50);
    const geometry = flatGeometryFromTriangles(triangles);
    const queryPoints = randomQueryPoints(rng, 60, 100);
    assertMatchesBruteForce(geometry, queryPoints);
  });

  it("matches brute force exactly for exactly collinear (true zero-area) triangles", () => {
    const rng = mulberry32(1337);
    const triangles = collinearTriangleCloud(rng, 150, 30);
    const geometry = flatGeometryFromTriangles(triangles);
    const queryPoints = randomQueryPoints(rng, 60, 60);
    assertMatchesBruteForce(geometry, queryPoints);
  });

  it("matches brute force exactly for axis-aligned triangle clouds", () => {
    // Triangles snapped onto axis-aligned planes: many share exact AABB
    // faces and centroids on the sampled axes, exercising Morton-code ties
    // along entire coordinate planes rather than generic 3D scatter.
    const rng = mulberry32(7);
    const triangles: [Vec3, Vec3, Vec3][] = [];
    for (let index = 0; index < 200; index += 1) {
      const plane = Math.floor(rng() * 3);
      const level = Math.round(rng() * 10) * 5;
      const point = (): Vec3 => {
        const p = randomVec3(rng, 40);
        p[plane] = level;
        return p;
      };
      triangles.push([point(), point(), point()]);
    }
    const geometry = flatGeometryFromTriangles(triangles);
    const queryPoints = randomQueryPoints(rng, 50, 60);
    assertMatchesBruteForce(geometry, queryPoints);
  });

  it("matches brute force exactly for rotated triangle clouds", () => {
    const rng = mulberry32(99);
    const triangles = rotateTriangles(
      randomTriangleCloud(rng, 200, 40),
      Math.PI / 5,
    );
    const geometry = flatGeometryFromTriangles(triangles);
    const queryPoints = randomQueryPoints(rng, 50, 80);
    assertMatchesBruteForce(geometry, queryPoints);
  });

  it("matches brute force exactly when every triangle is bit-identical (all Morton codes coincide)", () => {
    // Degenerate construction input for the Morton-ordered median split:
    // every centroid is identical, so the centroid-bounds span used to
    // normalize Morton coordinates is zero on every axis.
    const rng = mulberry32(5);
    const triangle: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [3, 0, 0],
      [0, 4, 0],
    ];
    const triangles = identicalTriangleCloud(triangle, 64);
    const geometry = flatGeometryFromTriangles(triangles);
    const queryPoints = randomQueryPoints(rng, 30, 20);
    assertMatchesBruteForce(geometry, queryPoints);
  });

  it("matches brute force exactly for a single triangle", () => {
    const geometry = flatGeometryFromTriangles([
      [
        [1, 1, 1],
        [5, 1, 1],
        [1, 6, 1],
      ],
    ]);
    const queryPoints: Vec3[] = [
      [0, 0, 0],
      [1, 1, 1],
      [100, -50, 3],
      [3, 3, 1],
      [-1e6, 1e6, -1e6],
    ];
    assertMatchesBruteForce(geometry, queryPoints);
  });

  it("matches brute force exactly for a query point exactly on a triangle's surface", () => {
    const geometry = flatGeometryFromTriangles([
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
    ]);
    // Centroid of the single triangle: distance must be exactly 0.
    assertMatchesBruteForce(geometry, [[10 / 3, 10 / 3, 0]]);
  });

  it("still returns a finite exact-matching distance for a large mixed cloud (slivers, collinear, and regular triangles together)", () => {
    const rng = mulberry32(2024);
    const triangles = [
      ...randomTriangleCloud(mulberry32(1), 150, 25),
      ...sliverTriangleCloud(mulberry32(2), 150, 25),
      ...collinearTriangleCloud(mulberry32(3), 150, 25),
    ];
    const geometry = flatGeometryFromTriangles(triangles);
    const queryPoints = randomQueryPoints(rng, 80, 50);
    assertMatchesBruteForce(geometry, queryPoints);
  });
});
