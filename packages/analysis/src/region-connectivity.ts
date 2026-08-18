import type { FlatGeometry } from "./geometry.js";

/**
 * Union-find over a fixed-size domain (triangle indices). Shared by the
 * `surface-distance` method's changed-region grouping (`analyze.ts`) and
 * `checkClearance`'s tight-region grouping (`clearance.ts`) so both group
 * triangles into connected components with exactly one implementation, never
 * two copies that could drift apart.
 */
export class DisjointSet {
  readonly #parents: Uint32Array;
  readonly #ranks: Uint8Array;

  constructor(size: number) {
    this.#parents = Uint32Array.from({ length: size }, (_, index) => index);
    this.#ranks = new Uint8Array(size);
  }

  find(value: number): number {
    let root = value;
    while (this.#parents[root] !== root) root = this.#parents[root]!;
    while (this.#parents[value] !== value) {
      const parent = this.#parents[value]!;
      this.#parents[value] = root;
      value = parent;
    }
    return root;
  }

  union(left: number, right: number): void {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = this.#ranks[leftRoot]!;
    const rightRank = this.#ranks[rightRoot]!;
    if (leftRank < rightRank) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    this.#parents[rightRoot] = leftRoot;
    if (leftRank === rightRank) this.#ranks[leftRoot] = leftRank + 1;
  }
}

/**
 * Exact vertex-coordinate identity key for `geometry`'s vertex at
 * `vertexIndex`. Two triangle corners are the same point, for every
 * connectivity and topology computation in this package, if and only if
 * their coordinates are bit-for-bit identical -- see "Topology semantics" in
 * ../README.md. No tolerance-based welding happens anywhere here.
 */
export function pointKeyAt(
  geometry: FlatGeometry,
  vertexIndex: number,
): string {
  const base = vertexIndex * 3;
  const positions = geometry.positions;
  return `${positions[base]},${positions[base + 1]},${positions[base + 2]}`;
}

/**
 * Canonicalizes an edge between two exact-coordinate vertex keys into one
 * orientation-independent Map key, plus whether `fromKey -> toKey` is the
 * "forward" traversal under that canonical order. `forward` is only needed
 * by callers that must detect inconsistent winding (`assessGeometry` in
 * `analyze.ts`); region-connectivity callers only need the undirected key.
 */
export function canonicalEdgeKey(
  fromKey: string,
  toKey: string,
): { key: string; forward: boolean } {
  const forward = fromKey <= toKey;
  return {
    key: forward ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`,
    forward,
  };
}

/** The canonical, undirected exact-coordinate edge key between two of `geometry`'s vertices. */
export function exactEdgeKeyAt(
  geometry: FlatGeometry,
  firstVertex: number,
  secondVertex: number,
): string {
  return canonicalEdgeKey(
    pointKeyAt(geometry, firstVertex),
    pointKeyAt(geometry, secondVertex),
  ).key;
}

/**
 * Groups the triangles flagged truthy in `flagged` (indexed by triangle,
 * length `>= geometry.triangleCount`) into maximal edge-connected
 * components, using the same exact-coordinate edge keying every other
 * connectivity computation in this package uses (see "Topology semantics" in
 * ../README.md): two triangle corners connect, and their shared edge is
 * treated as one edge, only when coordinates are bit-for-bit identical.
 * Unflagged triangles never appear in any returned component.
 *
 * Components are returned in the order their root triangle was first
 * discovered while scanning triangles in ascending index order --
 * deterministic for a given `geometry`/`flagged` pair, matching the ordering
 * `surface-distance`'s region grouping has always produced.
 */
export function groupTrianglesByExactEdgeConnectivity(
  geometry: FlatGeometry,
  flagged: Uint8Array,
): number[][] {
  const triangleCount = geometry.triangleCount;
  const indices = geometry.indices;
  const connectivity = new DisjointSet(triangleCount);
  const firstTriangleByEdge = new Map<string, number>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (flagged[triangle] === 0) continue;
    const base = triangle * 3;
    const a = indices[base]!;
    const b = indices[base + 1]!;
    const c = indices[base + 2]!;
    for (const edge of [
      exactEdgeKeyAt(geometry, a, b),
      exactEdgeKeyAt(geometry, b, c),
      exactEdgeKeyAt(geometry, c, a),
    ]) {
      const neighbor = firstTriangleByEdge.get(edge);
      if (neighbor === undefined) {
        firstTriangleByEdge.set(edge, triangle);
      } else {
        connectivity.union(triangle, neighbor);
      }
    }
  }

  const components = new Map<number, number[]>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (flagged[triangle] === 0) continue;
    const root = connectivity.find(triangle);
    const component = components.get(root) ?? [];
    component.push(triangle);
    components.set(root, component);
  }
  return [...components.values()];
}
