import type { Vec3 } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import { pointTriangleDistanceSquared } from "../src/geometry.js";
import {
  mulberry32,
  randomTriangleCloud,
  randomVec3,
  referencePointTriangleDistanceSquared,
} from "./test-utils.js";

/**
 * Fixed reference triangle for the seven-Voronoi-region hand cases:
 * A = (0,0,0), B = (12,0,0), C = (0,12,0) -- a right triangle in the z = 0
 * plane with legs of length 12 along x and y.
 *
 * Every query point and expected squared distance below was verified by
 * hand-simulating `pointTriangleDistanceSquared`'s branch conditions (the
 * d1..d6/va/vb/vc dot-product tests from Ericson's algorithm) against this
 * triangle, confirming which of the seven regions (three vertices, three
 * edge interiors, one face interior) each point falls into and that every
 * intermediate division reduces to an exact rational value in double
 * precision (halves and thirds of small integers), so the expected values
 * below are exact integers, not tolerances.
 */
const A: Vec3 = [0, 0, 0];
const B: Vec3 = [12, 0, 0];
const C: Vec3 = [0, 12, 0];

function distanceSquaredTo(point: Vec3): number {
  return pointTriangleDistanceSquared(
    point[0],
    point[1],
    point[2],
    new Float64Array([...A, ...B, ...C]),
    0,
    1,
    2,
  );
}

describe("pointTriangleDistanceSquared Voronoi regions (hand-verified)", () => {
  it("vertex region A: nearest feature is vertex A", () => {
    // P is behind both edges AB and AC from A (AP.AB <= 0 and AP.AC <= 0).
    expect(distanceSquaredTo([-3, -4, 0])).toBe(25);
  });

  it("vertex region B: nearest feature is vertex B", () => {
    expect(distanceSquaredTo([17, -3, 0])).toBe(34);
  });

  it("vertex region C: nearest feature is vertex C", () => {
    expect(distanceSquaredTo([-3, 17, 0])).toBe(34);
  });

  it("edge region AB: nearest feature is the interior of edge AB", () => {
    // Perpendicular foot at (6,0,0), edge parameter t = 0.5 (strictly
    // interior, not either endpoint).
    expect(distanceSquaredTo([6, -5, 0])).toBe(25);
  });

  it("edge region AC: nearest feature is the interior of edge AC", () => {
    expect(distanceSquaredTo([-5, 6, 0])).toBe(25);
  });

  it("edge region BC: nearest feature is the interior of edge BC", () => {
    // Perpendicular foot at the midpoint of BC, (6,6,0), edge parameter
    // t = 0.5.
    expect(distanceSquaredTo([11, 11, 0])).toBe(50);
  });

  it("face-interior region: nearest feature is the interior of the triangle", () => {
    // Directly above the centroid (4,4,0); barycentric weights (1/3,1/3,1/3).
    expect(distanceSquaredTo([4, 4, 7])).toBe(49);
  });

  it("agrees with the independently-implemented reference distance on all seven hand cases", () => {
    const cases: Vec3[] = [
      [-3, -4, 0],
      [17, -3, 0],
      [-3, 17, 0],
      [6, -5, 0],
      [-5, 6, 0],
      [11, 11, 0],
      [4, 4, 7],
    ];
    for (const point of cases) {
      expect(referencePointTriangleDistanceSquared(point, A, B, C)).toBeCloseTo(
        distanceSquaredTo(point),
        9,
      );
    }
  });
});

describe("pointTriangleDistanceSquared vs. an independently-implemented reference (seeded sweep)", () => {
  it("matches a barycentric-projection reference within a tight tolerance across varied seeded triangles and query points", () => {
    for (const seed of [11, 22, 33, 44, 55]) {
      const rng = mulberry32(seed);
      for (let trial = 0; trial < 300; trial += 1) {
        const scale = 0.01 + rng() * 1000;
        const a = randomVec3(rng, scale);
        const b = randomVec3(rng, scale);
        const c = randomVec3(rng, scale);
        const point = randomVec3(rng, scale * 1.5);

        const actual = pointTriangleDistanceSquared(
          point[0],
          point[1],
          point[2],
          new Float64Array([...a, ...b, ...c]),
          0,
          1,
          2,
        );
        const reference = referencePointTriangleDistanceSquared(point, a, b, c);

        // Tight but scale-relative tolerance: both implementations use
        // double-precision arithmetic with a handful of operations, so
        // rounding differences should stay many orders of magnitude below
        // the geometry's own scale.
        const tolerance = Math.max(1e-6, reference * 1e-9);
        expect(Math.abs(actual - reference)).toBeLessThan(tolerance);
      }
    }
  });

  it("matches the reference for a seeded sweep of sliver (near-zero-area) triangles", () => {
    const rng = mulberry32(777);
    for (let trial = 0; trial < 200; trial += 1) {
      const scale = 10;
      const a = randomVec3(rng, scale);
      const direction = randomVec3(rng, 1);
      const b: Vec3 = [
        a[0] + direction[0] * scale,
        a[1] + direction[1] * scale,
        a[2] + direction[2] * scale,
      ];
      const tinyOffset = 1e-4 * scale;
      const perpendicular = randomVec3(rng, 1);
      const c: Vec3 = [
        a[0] + perpendicular[0] * tinyOffset,
        a[1] + perpendicular[1] * tinyOffset,
        a[2] + perpendicular[2] * tinyOffset,
      ];
      const point = randomVec3(rng, scale * 2);

      const actual = pointTriangleDistanceSquared(
        point[0],
        point[1],
        point[2],
        new Float64Array([...a, ...b, ...c]),
        0,
        1,
        2,
      );
      const reference = referencePointTriangleDistanceSquared(point, a, b, c);
      const tolerance = Math.max(1e-4, reference * 1e-6);
      expect(Math.abs(actual - reference)).toBeLessThan(tolerance);
    }
  });

  it("matches the reference for triangles from a shared random cloud generator", () => {
    const rng = mulberry32(2025);
    const triangles = randomTriangleCloud(rng, 100, 200);
    const queryRng = mulberry32(4050);
    for (const [a, b, c] of triangles) {
      const point = randomVec3(queryRng, 300);
      const actual = pointTriangleDistanceSquared(
        point[0],
        point[1],
        point[2],
        new Float64Array([...a, ...b, ...c]),
        0,
        1,
        2,
      );
      const reference = referencePointTriangleDistanceSquared(point, a, b, c);
      const tolerance = Math.max(1e-6, reference * 1e-9);
      expect(Math.abs(actual - reference)).toBeLessThan(tolerance);
    }
  });
});
