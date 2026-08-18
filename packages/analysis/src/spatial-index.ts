import { pointTriangleDistanceSquared } from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";

export type { WorkUnitCounter } from "./geometry.js";

/**
 * A genuine, code-detected numeric-range failure: a computed distance was
 * not finite (e.g. coordinates so large that squaring them overflows to
 * `Infinity`). Kept distinct from ordinary `Error` so callers can map only
 * this class to the `numeric-range-exceeded` outcome code and let any other,
 * truly unexpected exception surface as `internal-error` instead of being
 * silently relabelled as a range failure it did not detect.
 */
export class NumericRangeExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumericRangeExceededError";
  }
}

const LEAF_TRIANGLE_COUNT = 8;
const MORTON_AXIS_SCALE = 1023;

interface Bounds6 {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

interface SpatialNode extends Bounds6 {
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

/**
 * Exact nearest-triangle queries accelerated by a deterministic AABB tree.
 *
 * Holds only a Uint32Array triangle-order permutation and a bounded BVH node
 * tree; triangle vertex coordinates are read on demand from the source
 * `FlatGeometry`'s typed arrays rather than duplicated per entry.
 */
export class TriangleSpatialIndex {
  readonly #geometry: FlatGeometry;
  readonly #order: Uint32Array;
  readonly #root: SpatialNode;

  constructor(geometry: FlatGeometry, work: WorkUnitCounter) {
    const triangleCount = geometry.triangleCount;
    work.charge(spatialIndexBuildWorkUnits(triangleCount));
    if (triangleCount === 0) {
      throw new Error("Cannot index an empty surface.");
    }
    this.#geometry = geometry;

    const minX = new Float64Array(triangleCount);
    const minY = new Float64Array(triangleCount);
    const minZ = new Float64Array(triangleCount);
    const maxX = new Float64Array(triangleCount);
    const maxY = new Float64Array(triangleCount);
    const maxZ = new Float64Array(triangleCount);
    const centroidX = new Float64Array(triangleCount);
    const centroidY = new Float64Array(triangleCount);
    const centroidZ = new Float64Array(triangleCount);

    let centroidBoundsMinX = Number.POSITIVE_INFINITY;
    let centroidBoundsMinY = Number.POSITIVE_INFINITY;
    let centroidBoundsMinZ = Number.POSITIVE_INFINITY;
    let centroidBoundsMaxX = Number.NEGATIVE_INFINITY;
    let centroidBoundsMaxY = Number.NEGATIVE_INFINITY;
    let centroidBoundsMaxZ = Number.NEGATIVE_INFINITY;

    const positions = geometry.positions;
    const indices = geometry.indices;
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

      const mnx = Math.min(ax, bx, cx);
      const mny = Math.min(ay, by, cy);
      const mnz = Math.min(az, bz, cz);
      const mxx = Math.max(ax, bx, cx);
      const mxy = Math.max(ay, by, cy);
      const mxz = Math.max(az, bz, cz);
      minX[triangle] = mnx;
      minY[triangle] = mny;
      minZ[triangle] = mnz;
      maxX[triangle] = mxx;
      maxY[triangle] = mxy;
      maxZ[triangle] = mxz;

      const cx2 = (mnx + mxx) / 2;
      const cy2 = (mny + mxy) / 2;
      const cz2 = (mnz + mxz) / 2;
      centroidX[triangle] = cx2;
      centroidY[triangle] = cy2;
      centroidZ[triangle] = cz2;
      if (cx2 < centroidBoundsMinX) centroidBoundsMinX = cx2;
      if (cy2 < centroidBoundsMinY) centroidBoundsMinY = cy2;
      if (cz2 < centroidBoundsMinZ) centroidBoundsMinZ = cz2;
      if (cx2 > centroidBoundsMaxX) centroidBoundsMaxX = cx2;
      if (cy2 > centroidBoundsMaxY) centroidBoundsMaxY = cy2;
      if (cz2 > centroidBoundsMaxZ) centroidBoundsMaxZ = cz2;
    }

    const mortonCodes = new Uint32Array(triangleCount);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      mortonCodes[triangle] = mortonCode(
        centroidX[triangle]!,
        centroidY[triangle]!,
        centroidZ[triangle]!,
        centroidBoundsMinX,
        centroidBoundsMinY,
        centroidBoundsMinZ,
        centroidBoundsMaxX,
        centroidBoundsMaxY,
        centroidBoundsMaxZ,
      );
    }

    const order = new Uint32Array(triangleCount);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      order[triangle] = triangle;
    }
    order.sort((left, right) => {
      const diff = mortonCodes[left]! - mortonCodes[right]!;
      return diff !== 0 ? diff : left - right;
    });
    this.#order = order;

    this.#root = buildNode(
      order,
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      0,
      triangleCount,
    );
  }

  distance(px: number, py: number, pz: number, work: WorkUnitCounter): number {
    return this.nearestTriangle(px, py, pz, work).distance;
  }

  /**
   * Same accelerated traversal `distance` uses, but also identifies which
   * opposite-surface triangle achieved the minimum. `distance` is
   * implemented in terms of this method (identical traversal, identical
   * charged work), so the two can never diverge on the value returned.
   *
   * Added for `checkClearance` (`src/clearance.ts`), which needs the actual
   * closest point on the opposite surface, not just its distance, to report
   * a measurable closest-point pair. Knowing which single triangle is
   * nearest lets the caller compute that point cheaply
   * (`closestPointOnTriangle` in `src/geometry.ts`) from one known triangle
   * instead of re-scanning the whole surface.
   */
  nearestTriangle(
    px: number,
    py: number,
    pz: number,
    work: WorkUnitCounter,
  ): { readonly distance: number; readonly triangleIndex: number } {
    const geometry = this.#geometry;
    const order = this.#order;
    const positions = geometry.positions;
    const indices = geometry.indices;
    let minimumSquared = Number.POSITIVE_INFINITY;
    let nearestTriangleIndex = -1;
    const stack: SpatialNode[] = [this.#root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      work.charge(1);
      if (distanceToBoundsSquared(px, py, pz, node) > minimumSquared) continue;

      if (node.left === undefined || node.right === undefined) {
        for (let index = node.start; index < node.end; index += 1) {
          work.charge(1);
          const triangle = order[index]!;
          const base = triangle * 3;
          const ia = indices[base]!;
          const ib = indices[base + 1]!;
          const ic = indices[base + 2]!;
          const squared = pointTriangleDistanceSquared(
            px,
            py,
            pz,
            positions,
            ia,
            ib,
            ic,
          );
          if (squared < minimumSquared) {
            minimumSquared = squared;
            nearestTriangleIndex = triangle;
          }
        }
        continue;
      }

      const leftDistance = distanceToBoundsSquared(px, py, pz, node.left);
      const rightDistance = distanceToBoundsSquared(px, py, pz, node.right);
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
      throw new NumericRangeExceededError(
        "Surface distance exceeded the supported numeric range.",
      );
    }
    return { distance, triangleIndex: nearestTriangleIndex };
  }

  /**
   * Collects every triangle index whose containing BVH leaf's aggregate AABB
   * overlaps the query box `[minX..maxZ]`. Coarser than an exact
   * per-triangle AABB test -- every triangle sharing a leaf is included once
   * that leaf's own bounds overlap the query, since individual triangle
   * bounds are transient construction-time state, not retained per entry
   * (see the class doc comment). This never produces a wrong final answer,
   * only some extra rejected candidates: `checkClearance`'s interference
   * detection (`src/clearance.ts`), the only caller, applies an exact
   * triangle-triangle intersection test to every candidate afterward.
   */
  overlapping(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    work: WorkUnitCounter,
  ): number[] {
    const order = this.#order;
    const candidates: number[] = [];
    const stack: SpatialNode[] = [this.#root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      work.charge(1);
      if (!boundsOverlap(node, minX, minY, minZ, maxX, maxY, maxZ)) continue;

      if (node.left === undefined || node.right === undefined) {
        for (let index = node.start; index < node.end; index += 1) {
          candidates.push(order[index]!);
        }
        continue;
      }
      stack.push(node.left, node.right);
    }
    return candidates;
  }
}

function boundsOverlap(
  bounds: Bounds6,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  return (
    bounds.minX <= maxX &&
    bounds.maxX >= minX &&
    bounds.minY <= maxY &&
    bounds.maxY >= minY &&
    bounds.minZ <= maxZ &&
    bounds.maxZ >= minZ
  );
}

function buildNode(
  order: Uint32Array,
  minX: Float64Array,
  minY: Float64Array,
  minZ: Float64Array,
  maxX: Float64Array,
  maxY: Float64Array,
  maxZ: Float64Array,
  start: number,
  end: number,
): SpatialNode {
  if (end - start <= LEAF_TRIANGLE_COUNT) {
    const bounds = boundsOfRange(
      order,
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      start,
      end,
    );
    return { ...bounds, start, end };
  }
  const middle = start + Math.floor((end - start) / 2);
  const left = buildNode(
    order,
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    start,
    middle,
  );
  const right = buildNode(
    order,
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    middle,
    end,
  );
  return { ...mergeBounds(left, right), start, end, left, right };
}

function boundsOfRange(
  order: Uint32Array,
  minX: Float64Array,
  minY: Float64Array,
  minZ: Float64Array,
  maxX: Float64Array,
  maxY: Float64Array,
  maxZ: Float64Array,
  start: number,
  end: number,
): Bounds6 {
  const first = order[start]!;
  let mnx = minX[first]!;
  let mny = minY[first]!;
  let mnz = minZ[first]!;
  let mxx = maxX[first]!;
  let mxy = maxY[first]!;
  let mxz = maxZ[first]!;
  for (let index = start + 1; index < end; index += 1) {
    const triangle = order[index]!;
    mnx = Math.min(mnx, minX[triangle]!);
    mny = Math.min(mny, minY[triangle]!);
    mnz = Math.min(mnz, minZ[triangle]!);
    mxx = Math.max(mxx, maxX[triangle]!);
    mxy = Math.max(mxy, maxY[triangle]!);
    mxz = Math.max(mxz, maxZ[triangle]!);
  }
  return { minX: mnx, minY: mny, minZ: mnz, maxX: mxx, maxY: mxy, maxZ: mxz };
}

function mergeBounds(left: Bounds6, right: Bounds6): Bounds6 {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    minZ: Math.min(left.minZ, right.minZ),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
    maxZ: Math.max(left.maxZ, right.maxZ),
  };
}

function mortonCode(
  x: number,
  y: number,
  z: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  const coordinate = (value: number, minimum: number, maximum: number) => {
    const span = maximum - minimum;
    if (!(span > 0)) return 0;
    const normalized = (value - minimum) / span;
    return Math.max(
      0,
      Math.min(MORTON_AXIS_SCALE, Math.floor(normalized * MORTON_AXIS_SCALE)),
    );
  };
  return (
    (expandMortonBits(coordinate(x, minX, maxX)) |
      (expandMortonBits(coordinate(y, minY, maxY)) << 1) |
      (expandMortonBits(coordinate(z, minZ, maxZ)) << 2)) >>>
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
  px: number,
  py: number,
  pz: number,
  bounds: Bounds6,
): number {
  const dx =
    px < bounds.minX
      ? bounds.minX - px
      : px > bounds.maxX
        ? px - bounds.maxX
        : 0;
  const dy =
    py < bounds.minY
      ? bounds.minY - py
      : py > bounds.maxY
        ? py - bounds.maxY
        : 0;
  const dz =
    pz < bounds.minZ
      ? bounds.minZ - pz
      : pz > bounds.maxZ
        ? pz - bounds.maxZ
        : 0;
  return dx * dx + dy * dy + dz * dz;
}
