import type { Vec3 } from "@voxelspy/contracts";

import { pointTriangleDistanceSquared } from "./geometry.js";
import type { Triangle } from "./geometry.js";

const LEAF_TRIANGLE_COUNT = 8;
const MORTON_AXIS_SCALE = 1023;

export interface WorkUnitCounter {
  charge(units: number): void;
}

interface TriangleEntry {
  readonly triangle: Triangle;
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly centroid: Vec3;
  mortonCode: number;
}

interface SpatialNode {
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly start: number;
  readonly end: number;
  readonly left?: SpatialNode;
  readonly right?: SpatialNode;
}

/**
 * Accounts conservatively for bounds, one deterministic sort, and hierarchy
 * construction before allocating or sorting the index.
 */
export function spatialIndexBuildWorkUnits(triangleCount: number): number {
  if (triangleCount === 0) return 0;
  const levels = Math.ceil(Math.log2(triangleCount));
  return triangleCount * (4 + levels * 2);
}

/** Exact nearest-triangle queries accelerated by a deterministic AABB tree. */
export class TriangleSpatialIndex {
  readonly #entries: TriangleEntry[];
  readonly #root: SpatialNode;

  constructor(triangles: readonly Triangle[], work: WorkUnitCounter) {
    work.charge(spatialIndexBuildWorkUnits(triangles.length));
    this.#entries = triangles.map(triangleEntry);
    const centroidBounds = boundsOfEntries(this.#entries, true);
    for (const entry of this.#entries) {
      entry.mortonCode = mortonCode(entry.centroid, centroidBounds);
    }
    this.#entries.sort(
      (left, right) =>
        left.mortonCode - right.mortonCode ||
        left.triangle.index - right.triangle.index,
    );
    this.#root = buildNode(this.#entries, 0, this.#entries.length);
  }

  distance(point: Vec3, work: WorkUnitCounter): number {
    let minimumSquared = Number.POSITIVE_INFINITY;
    const stack: SpatialNode[] = [this.#root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      work.charge(1);
      if (distanceToBoundsSquared(point, node) > minimumSquared) continue;

      if (node.left === undefined || node.right === undefined) {
        for (let index = node.start; index < node.end; index += 1) {
          work.charge(1);
          const triangle = this.#entries[index]!.triangle;
          const [first, second, third] = triangle.points;
          minimumSquared = Math.min(
            minimumSquared,
            pointTriangleDistanceSquared(point, first, second, third),
          );
        }
        continue;
      }

      const leftDistance = distanceToBoundsSquared(point, node.left);
      const rightDistance = distanceToBoundsSquared(point, node.right);
      if (leftDistance <= rightDistance) {
        if (rightDistance <= minimumSquared) stack.push(node.right);
        if (leftDistance <= minimumSquared) stack.push(node.left);
      } else {
        if (leftDistance <= minimumSquared) stack.push(node.left);
        if (rightDistance <= minimumSquared) stack.push(node.right);
      }
    }

    const distance = Math.sqrt(minimumSquared);
    if (!Number.isFinite(distance)) {
      throw new Error("Surface distance exceeded the supported numeric range.");
    }
    return distance;
  }
}

function triangleEntry(triangle: Triangle): TriangleEntry {
  const [first, second, third] = triangle.points;
  const minimum: Vec3 = [
    Math.min(first[0], second[0], third[0]),
    Math.min(first[1], second[1], third[1]),
    Math.min(first[2], second[2], third[2]),
  ];
  const maximum: Vec3 = [
    Math.max(first[0], second[0], third[0]),
    Math.max(first[1], second[1], third[1]),
    Math.max(first[2], second[2], third[2]),
  ];
  return {
    triangle,
    minimum,
    maximum,
    centroid: [
      (minimum[0] + maximum[0]) / 2,
      (minimum[1] + maximum[1]) / 2,
      (minimum[2] + maximum[2]) / 2,
    ],
    mortonCode: 0,
  };
}

function buildNode(
  entries: readonly TriangleEntry[],
  start: number,
  end: number,
): SpatialNode {
  if (end - start <= LEAF_TRIANGLE_COUNT) {
    return { ...boundsOfEntries(entries, false, start, end), start, end };
  }
  const middle = start + Math.floor((end - start) / 2);
  const left = buildNode(entries, start, middle);
  const right = buildNode(entries, middle, end);
  return {
    ...mergeBounds(left, right),
    start,
    end,
    left,
    right,
  };
}

function mergeBounds(
  left: { readonly minimum: Vec3; readonly maximum: Vec3 },
  right: { readonly minimum: Vec3; readonly maximum: Vec3 },
): { minimum: Vec3; maximum: Vec3 } {
  return {
    minimum: [
      Math.min(left.minimum[0], right.minimum[0]),
      Math.min(left.minimum[1], right.minimum[1]),
      Math.min(left.minimum[2], right.minimum[2]),
    ],
    maximum: [
      Math.max(left.maximum[0], right.maximum[0]),
      Math.max(left.maximum[1], right.maximum[1]),
      Math.max(left.maximum[2], right.maximum[2]),
    ],
  };
}

function boundsOfEntries(
  entries: readonly TriangleEntry[],
  useCentroids: boolean,
  start = 0,
  end = entries.length,
): { minimum: Vec3; maximum: Vec3 } {
  const first = entries[start];
  if (first === undefined) throw new Error("Cannot index an empty surface.");
  const firstMinimum = useCentroids ? first.centroid : first.minimum;
  const firstMaximum = useCentroids ? first.centroid : first.maximum;
  const minimum: Vec3 = [...firstMinimum] as Vec3;
  const maximum: Vec3 = [...firstMaximum] as Vec3;
  for (let index = start + 1; index < end; index += 1) {
    const entry = entries[index]!;
    const nextMinimum = useCentroids ? entry.centroid : entry.minimum;
    const nextMaximum = useCentroids ? entry.centroid : entry.maximum;
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, nextMinimum[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, nextMaximum[axis]!);
    }
  }
  return { minimum, maximum };
}

function mortonCode(
  point: Vec3,
  bounds: { readonly minimum: Vec3; readonly maximum: Vec3 },
): number {
  const coordinate = (axis: number) => {
    const span = bounds.maximum[axis]! - bounds.minimum[axis]!;
    if (!(span > 0)) return 0;
    const normalized = (point[axis]! - bounds.minimum[axis]!) / span;
    return Math.max(
      0,
      Math.min(MORTON_AXIS_SCALE, Math.floor(normalized * MORTON_AXIS_SCALE)),
    );
  };
  return (
    (expandMortonBits(coordinate(0)) |
      (expandMortonBits(coordinate(1)) << 1) |
      (expandMortonBits(coordinate(2)) << 2)) >>>
    0
  );
}

function expandMortonBits(value: number): number {
  let expanded = value & 0x000003ff;
  expanded = (expanded | (expanded << 16)) & 0x030000ff;
  expanded = (expanded | (expanded << 8)) & 0x0300f00f;
  expanded = (expanded | (expanded << 4)) & 0x030c30c3;
  expanded = (expanded | (expanded << 2)) & 0x09249249;
  return expanded;
}

function distanceToBoundsSquared(
  point: Vec3,
  bounds: { readonly minimum: Vec3; readonly maximum: Vec3 },
): number {
  let distance = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const value = point[axis]!;
    const offset =
      value < bounds.minimum[axis]!
        ? bounds.minimum[axis]! - value
        : value > bounds.maximum[axis]!
          ? value - bounds.maximum[axis]!
          : 0;
    distance += offset * offset;
  }
  return distance;
}
