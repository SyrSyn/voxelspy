import type { Vec3 } from "@voxelspy/contracts";

/**
 * One traced, undirected edge with known endpoint positions and their
 * exact-coordinate keys (see "Topology semantics" in ../README.md). This is
 * the shared shape both `diagnoseMeshHealth`'s boundary-loop tracer
 * (`src/diagnose.ts`, edges built from the topology census's boundary edges)
 * and `sectionModel`'s section-loop tracer (`src/section.ts`, edges built
 * from triangle-plane intersection segments) feed into `traceAllChains`
 * below -- one chain-tracing implementation, never two copies that could
 * drift apart. `endpointKeys` must be exact-coordinate identity keys (equal
 * if and only if the two positions are bit-for-bit identical), matching this
 * package's no-tolerance-welding rule everywhere else.
 */
export interface PositionedEdge {
  readonly endpointsMillimetres: readonly [Vec3, Vec3];
  readonly endpointKeys: readonly [string, string];
}

/** One traced chain before canonicalization: points in discovery order. */
export interface RawChain {
  readonly points: readonly Vec3[];
  readonly edgeCount: number;
  readonly closed: boolean;
}

interface IncidentEdge {
  readonly edgeId: number;
  readonly neighborKey: string;
  readonly neighborPosition: Vec3;
}

interface AdjacencyEntry {
  readonly position: Vec3;
  /** Sorted once, ascending by (neighbor position, edge id). */
  readonly incident: IncidentEdge[];
}

/**
 * Decomposes `edges` into maximal edge-disjoint chains. Visits vertices with
 * an irregular (not exactly two) incident-edge count first, fully draining
 * each one's incident edges before moving on, so any edge left over
 * afterward belongs to a vertex-disjoint set of pure degree-two cycles --
 * the textbook approach to decomposing a graph into as many simple cycles as
 * possible, with the unavoidable remainder expressed as paths between the
 * irregular vertices. Runs in time proportional to `edges.length`: each
 * vertex's incident-edge list is sorted once, and traversal advances a
 * per-vertex cursor past already-visited entries rather than rescanning, so
 * total pointer movement across the whole trace is bounded by twice the edge
 * count.
 *
 * A chain that returns to its own starting vertex is `closed: true`; one
 * that runs out of unvisited edges at a different vertex is `closed: false`
 * -- reported honestly, never forced into a loop shape. Callers needing a
 * fully deterministic *output* order must also apply `canonicalizeChain` to
 * each result and sort with `compareChains` -- see `diagnoseMeshHealth`'s
 * (`src/diagnose.ts`) and `sectionModel`'s (`src/section.ts`) doc comments
 * for the full determinism rule.
 */
export function traceAllChains(edges: readonly PositionedEdge[]): RawChain[] {
  const adjacency = buildAdjacency(edges);
  const visited = new Array<boolean>(edges.length).fill(false);
  const cursor = new Map<string, number>();

  const pickNext = (key: string): IncidentEdge | undefined => {
    const entry = adjacency.get(key);
    if (entry === undefined) return undefined;
    let index = cursor.get(key) ?? 0;
    while (
      index < entry.incident.length &&
      visited[entry.incident[index]!.edgeId]
    ) {
      index += 1;
    }
    cursor.set(key, index);
    return index < entry.incident.length ? entry.incident[index] : undefined;
  };

  const walkChain = (
    startKey: string,
    startPosition: Vec3,
    first: IncidentEdge,
  ): RawChain => {
    const points: Vec3[] = [startPosition];
    visited[first.edgeId] = true;
    let edgeCount = 1;
    if (first.neighborKey === startKey) {
      // A single edge whose two endpoints coincide exactly.
      return { points, edgeCount, closed: true };
    }
    let currentKey = first.neighborKey;
    points.push(first.neighborPosition);
    for (;;) {
      const next = pickNext(currentKey);
      if (next === undefined) return { points, edgeCount, closed: false };
      visited[next.edgeId] = true;
      edgeCount += 1;
      if (next.neighborKey === startKey) {
        return { points, edgeCount, closed: true };
      }
      currentKey = next.neighborKey;
      points.push(next.neighborPosition);
    }
  };

  const orderedKeys = [...adjacency.keys()].sort((left, right) =>
    compareVertexOrder(adjacency, left, right),
  );

  const chains: RawChain[] = [];
  const drain = (key: string): void => {
    const entry = adjacency.get(key)!;
    for (let next = pickNext(key); next !== undefined; next = pickNext(key)) {
      chains.push(walkChain(key, entry.position, next));
    }
  };

  for (const key of orderedKeys) {
    if (adjacency.get(key)!.incident.length !== 2) drain(key);
  }
  for (const key of orderedKeys) {
    drain(key);
  }

  return chains;
}

function buildAdjacency(
  edges: readonly PositionedEdge[],
): Map<string, AdjacencyEntry> {
  const adjacency = new Map<string, AdjacencyEntry>();
  const addIncident = (
    key: string,
    position: Vec3,
    incident: IncidentEdge,
  ): void => {
    let entry = adjacency.get(key);
    if (entry === undefined) {
      entry = { position, incident: [] };
      adjacency.set(key, entry);
    }
    entry.incident.push(incident);
  };

  edges.forEach((edge, edgeId) => {
    const [positionA, positionB] = edge.endpointsMillimetres;
    const [keyA, keyB] = edge.endpointKeys;
    addIncident(keyA, positionA, {
      edgeId,
      neighborKey: keyB,
      neighborPosition: positionB,
    });
    addIncident(keyB, positionB, {
      edgeId,
      neighborKey: keyA,
      neighborPosition: positionA,
    });
  });

  for (const entry of adjacency.values()) {
    entry.incident.sort((left, right) => {
      const byPosition = comparePoints(
        left.neighborPosition,
        right.neighborPosition,
      );
      return byPosition !== 0 ? byPosition : left.edgeId - right.edgeId;
    });
  }
  return adjacency;
}

function compareVertexOrder(
  adjacency: Map<string, AdjacencyEntry>,
  left: string,
  right: string,
): number {
  const byPosition = comparePoints(
    adjacency.get(left)!.position,
    adjacency.get(right)!.position,
  );
  if (byPosition !== 0) return byPosition;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Rotates a closed loop to start at its lexicographically smallest point and
 * walk toward whichever neighbor is smaller; reverses a non-closed chain (a
 * path cannot be rotated) so its lexicographically smaller endpoint comes
 * first.
 */
export function canonicalizeChain(
  points: readonly Vec3[],
  closed: boolean,
): readonly Vec3[] {
  if (points.length <= 1) return points;
  if (!closed) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    return comparePoints(first, last) <= 0 ? points : [...points].reverse();
  }
  let minIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (comparePoints(points[index]!, points[minIndex]!) < 0) minIndex = index;
  }
  const length = points.length;
  const rotated = Array.from(
    { length },
    (_, offset) => points[(minIndex + offset) % length]!,
  );
  if (length > 1 && comparePoints(rotated[length - 1]!, rotated[1]!) < 0) {
    return [rotated[0]!, ...rotated.slice(1).reverse()];
  }
  return rotated;
}

/**
 * Orders chains by descending edge count, then ascending canonical start
 * point, then closed-before-terminated, then a full point-by-point
 * comparison as a last-resort tie-break. `points` must already be
 * canonicalized (`canonicalizeChain`) before comparing.
 */
export function compareChains(left: RawChain, right: RawChain): number {
  if (left.edgeCount !== right.edgeCount)
    return right.edgeCount - left.edgeCount;
  const byStart = comparePoints(left.points[0]!, right.points[0]!);
  if (byStart !== 0) return byStart;
  if (left.closed !== right.closed) return left.closed ? -1 : 1;
  const sharedLength = Math.min(left.points.length, right.points.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const byPoint = comparePoints(left.points[index]!, right.points[index]!);
    if (byPoint !== 0) return byPoint;
  }
  return left.points.length - right.points.length;
}

/**
 * Sum of consecutive point-to-point distances, including the closing
 * segment back to the start when `closed` is `true`.
 */
export function perimeterOf(points: readonly Vec3[], closed: boolean): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distanceBetween(points[index - 1]!, points[index]!);
  }
  if (closed && points.length > 1) {
    total += distanceBetween(points[points.length - 1]!, points[0]!);
  }
  return normalizeZero(total);
}

export function distanceBetween(first: Vec3, second: Vec3): number {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
  );
}

export function comparePoints(left: Vec3, right: Vec3): number {
  for (let axis = 0; axis < 3; axis += 1) {
    const a = normalizeZero(left[axis]!);
    const b = normalizeZero(right[axis]!);
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
