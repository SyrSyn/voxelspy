import type { Vec3 } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import { rayTriangleIntersectionT } from "../src/geometry.js";
import type { FlatGeometry } from "../src/geometry.js";
import { TriangleSpatialIndex } from "../src/spatial-index.js";
import {
  UNMETERED_WORK,
  collinearTriangleCloud,
  flatGeometryFromTriangles,
  mulberry32,
  randomTriangleCloud,
  randomVec3,
  sliverTriangleCloud,
} from "./test-utils.js";

/**
 * Ground truth for `TriangleSpatialIndex.castRayNearest`: scan every
 * triangle with the exact same `rayTriangleIntersectionT` primitive the
 * index itself calls at its leaves, keeping the smallest `t`. Because both
 * paths route through the identical scalar routine for whichever triangle
 * wins, a hit's `t` is expected to be bit-for-bit identical between the two
 * -- not merely close -- and "hit vs. miss" is expected to agree exactly;
 * any observed mismatch would mean the BVH pruning skipped the true
 * nearest intersection, a real correctness defect. `triangleIndex` is
 * deliberately not compared: on an exact `t` tie between two different
 * triangles, this brute-force scan and the BVH traversal can pick
 * different (but equally correct) winners, the same tie-break ambiguity
 * `spatial-index-property.test.ts` sidesteps by comparing only `distance`.
 */
function bruteForceCastRay(
  geometry: FlatGeometry,
  origin: Vec3,
  direction: Vec3,
  excludeTriangleIndex?: number,
): { readonly t: number } | undefined {
  const positions = geometry.positions;
  const indices = geometry.indices;
  let bestT = Number.POSITIVE_INFINITY;
  let hit = false;
  for (let triangle = 0; triangle < geometry.triangleCount; triangle += 1) {
    if (triangle === excludeTriangleIndex) continue;
    const base = triangle * 3;
    const ia = indices[base]!;
    const ib = indices[base + 1]!;
    const ic = indices[base + 2]!;
    const t = rayTriangleIntersectionT(
      origin[0],
      origin[1],
      origin[2],
      direction[0],
      direction[1],
      direction[2],
      positions,
      ia,
      ib,
      ic,
    );
    if (t !== undefined && t < bestT) {
      bestT = t;
      hit = true;
    }
  }
  return hit ? { t: bestT } : undefined;
}

function assertMatchesBruteForce(
  geometry: FlatGeometry,
  rays: readonly { readonly origin: Vec3; readonly direction: Vec3 }[],
  excludeTriangleIndex?: number,
): void {
  const index = new TriangleSpatialIndex(geometry, UNMETERED_WORK);
  for (const ray of rays) {
    const accelerated = index.castRayNearest(
      ray.origin[0],
      ray.origin[1],
      ray.origin[2],
      ray.direction[0],
      ray.direction[1],
      ray.direction[2],
      UNMETERED_WORK,
      excludeTriangleIndex,
    );
    const brute = bruteForceCastRay(
      geometry,
      ray.origin,
      ray.direction,
      excludeTriangleIndex,
    );
    expect(accelerated !== undefined).toBe(brute !== undefined);
    if (accelerated !== undefined && brute !== undefined) {
      expect(accelerated.t).toBe(brute.t);
    }
  }
}

function randomRays(
  rng: () => number,
  count: number,
  originScale: number,
  directionScale: number,
): { readonly origin: Vec3; readonly direction: Vec3 }[] {
  const rays: { readonly origin: Vec3; readonly direction: Vec3 }[] = [];
  for (let index = 0; index < count; index += 1) {
    rays.push({
      origin: randomVec3(rng, originScale),
      direction: randomVec3(rng, directionScale),
    });
  }
  return rays;
}

describe("TriangleSpatialIndex.castRayNearest vs. brute force (property)", () => {
  it("matches brute force exactly across varied seeded triangle-cloud scales", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const scale of [0.001, 1, 1_000, 1_000_000]) {
        const rng = mulberry32(seed * 2000 + scale);
        const triangles = randomTriangleCloud(rng, 150, scale);
        const geometry = flatGeometryFromTriangles(triangles);
        const rays = randomRays(rng, 40, scale * 2, scale);
        assertMatchesBruteForce(geometry, rays);
      }
    }
  });

  it("matches brute force exactly for needle-thin sliver triangles", () => {
    const rng = mulberry32(42);
    const triangles = sliverTriangleCloud(rng, 200, 50);
    const geometry = flatGeometryFromTriangles(triangles);
    const rays = randomRays(rng, 60, 100, 50);
    assertMatchesBruteForce(geometry, rays);
  });

  it("matches brute force exactly for exactly collinear (true zero-area) triangles", () => {
    const rng = mulberry32(1337);
    const triangles = collinearTriangleCloud(rng, 150, 30);
    const geometry = flatGeometryFromTriangles(triangles);
    const rays = randomRays(rng, 60, 60, 30);
    assertMatchesBruteForce(geometry, rays);
  });

  it("matches brute force exactly for axis-aligned rays (exercises zero-direction-component slab handling)", () => {
    const rng = mulberry32(7);
    const triangles = randomTriangleCloud(rng, 150, 40);
    const geometry = flatGeometryFromTriangles(triangles);
    const rays: { readonly origin: Vec3; readonly direction: Vec3 }[] = [];
    for (let index = 0; index < 40; index += 1) {
      const origin = randomVec3(rng, 60);
      const axis = Math.floor(rng() * 3);
      const direction: Vec3 = [0, 0, 0];
      direction[axis] = rng() < 0.5 ? 1 : -1;
      rays.push({ origin, direction });
    }
    assertMatchesBruteForce(geometry, rays);
  });

  it("matches brute force exactly when a ray origin lies exactly on a node bounding-box face (zero-direction slab boundary)", () => {
    // A grid of unit-square triangles in the z = 0 plane; rays cast straight
    // up from points exactly on the grid's own axis-aligned boundaries.
    const triangles: [Vec3, Vec3, Vec3][] = [];
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        triangles.push([
          [x, y, 0],
          [x + 1, y, 0],
          [x, y + 1, 0],
        ]);
      }
    }
    const geometry = flatGeometryFromTriangles(triangles);
    const rays: { readonly origin: Vec3; readonly direction: Vec3 }[] = [];
    for (let x = 0; x <= 5; x += 1) {
      rays.push({ origin: [x, 2, -5], direction: [0, 0, 1] });
    }
    assertMatchesBruteForce(geometry, rays);
  });

  it("excludes the given triangle index from consideration, matching a brute-force scan with the same exclusion", () => {
    const rng = mulberry32(99);
    const triangles = randomTriangleCloud(rng, 100, 30);
    const geometry = flatGeometryFromTriangles(triangles);
    const rays = randomRays(rng, 30, 40, 30);
    for (
      let excludeTriangleIndex = 0;
      excludeTriangleIndex < 5;
      excludeTriangleIndex += 1
    ) {
      assertMatchesBruteForce(geometry, rays.slice(0, 6), excludeTriangleIndex);
    }
  });

  it("matches brute force exactly for a single triangle", () => {
    const geometry = flatGeometryFromTriangles([
      [
        [1, 1, 1],
        [5, 1, 1],
        [1, 6, 1],
      ],
    ]);
    const rays: { readonly origin: Vec3; readonly direction: Vec3 }[] = [
      { origin: [2, 2, -10], direction: [0, 0, 1] },
      { origin: [2, 2, 10], direction: [0, 0, 1] },
      { origin: [2, 2, 10], direction: [0, 0, -1] },
      { origin: [-100, -100, -100], direction: [1, 1, 1] },
      { origin: [0, 0, 0], direction: [0, 1, 0] },
    ];
    assertMatchesBruteForce(geometry, rays);
  });

  it("still matches brute force for a large mixed cloud (slivers, collinear, and regular triangles together)", () => {
    const rng = mulberry32(2024);
    const triangles = [
      ...randomTriangleCloud(mulberry32(1), 120, 25),
      ...sliverTriangleCloud(mulberry32(2), 120, 25),
      ...collinearTriangleCloud(mulberry32(3), 120, 25),
    ];
    const geometry = flatGeometryFromTriangles(triangles);
    const rays = randomRays(rng, 60, 50, 25);
    assertMatchesBruteForce(geometry, rays);
  });
});
