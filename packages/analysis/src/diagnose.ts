import { IDENTITY_MAT4, normalizedModelSchema } from "@voxelspy/contracts";
import type { Mat4, NormalizedModel, Vec3 } from "@voxelspy/contracts";

import { checkResourceCeiling, resolveBound } from "./inspect.js";
import {
  summarizeModelGeometryWithDiagnosticEvidence,
  type TopologyBoundaryEdge,
  type TopologyDegenerateTriangle,
  type TopologyEdgeSegment,
} from "./summary.js";

/** Default number of boundary loops/chains returned before truncation. */
export const DEFAULT_MAX_BOUNDARY_LOOPS = 20;
/** Implementation ceiling on `MeshHealthOptions.maxBoundaryLoops`. */
export const MAX_BOUNDARY_LOOPS = 500;
/** Default total point budget shared across every returned boundary loop. */
export const DEFAULT_MAX_BOUNDARY_LOOP_POINTS = 2_000;
/** Implementation ceiling on `MeshHealthOptions.maxBoundaryLoopPoints`. */
export const MAX_BOUNDARY_LOOP_POINTS = 50_000;
/** Default number of items returned per non-boundary-loop issue kind (non-manifold edges, inconsistent-orientation edges, degenerate triangles). */
export const DEFAULT_MAX_ISSUE_ITEMS = 100;
/** Implementation ceiling on `MeshHealthOptions.maxIssueItems`. */
export const MAX_ISSUE_ITEMS = 2_000;

export interface MeshHealthOptions {
  /** Defaults to identity, matching `InspectOptions.modelToComparison`. */
  readonly modelToComparison?: Mat4;
  /** Bounded by `MAX_BOUNDARY_LOOPS`. Defaults to `DEFAULT_MAX_BOUNDARY_LOOPS`. */
  readonly maxBoundaryLoops?: number;
  /** Total points shared across every returned loop, not per loop. Bounded by `MAX_BOUNDARY_LOOP_POINTS`. Defaults to `DEFAULT_MAX_BOUNDARY_LOOP_POINTS`. */
  readonly maxBoundaryLoopPoints?: number;
  /** Applies independently to non-manifold edges, inconsistent-orientation edges, and degenerate triangles. Bounded by `MAX_ISSUE_ITEMS`. Defaults to `DEFAULT_MAX_ISSUE_ITEMS`. */
  readonly maxIssueItems?: number;
}

/**
 * One traced boundary chain, in canonical point order (see `diagnoseMeshHealth`'s
 * doc comment for the exact rule). `edgeCount` and `perimeterMillimetres`
 * always describe the chain's full, untruncated extent, even when
 * `pointsTruncated` is `true`.
 */
export interface BoundaryLoop {
  /** Ordered vertex positions; for a closed loop this does not repeat the start point at the end. */
  readonly pointsMillimetres: readonly Vec3[];
  /** The chain's true edge count, independent of any point-budget truncation. */
  readonly edgeCount: number;
  /**
   * `true` when this chain returned to its own starting vertex, forming a
   * simple cycle. `false` for a chain that terminated at a dead end instead
   * -- which happens honestly on a non-manifold boundary (a vertex touched
   * by more than two boundary edges), never asserted away.
   */
  readonly closed: boolean;
  /**
   * Sum of consecutive point-to-point distances, including the closing
   * segment back to the start when `closed` is `true`. Approximate in the
   * same sense as the rest of this package's measurements: exact for the
   * traced polyline, not a claim about curvature the tessellation doesn't
   * capture.
   */
  readonly perimeterMillimetres: number;
  /**
   * `true` when `pointsMillimetres` is a canonical-order PREFIX of this
   * loop's full point list because `maxBoundaryLoopPoints` ran out --
   * `edgeCount`/`closed`/`perimeterMillimetres` remain exact, but a closed
   * loop's rendered polyline will not visually close back on itself in that
   * case.
   */
  readonly pointsTruncated: boolean;
}

export interface BoundaryLoopSet {
  /** Bounded by both `maxBoundaryLoops` and the shared `maxBoundaryLoopPoints` budget; ordered per `diagnoseMeshHealth`'s doc comment. */
  readonly loops: readonly BoundaryLoop[];
  /** Total boundary chains found, before `maxBoundaryLoops`/`maxBoundaryLoopPoints` truncation. */
  readonly loopCount: number;
  /** `true` whenever `loopCount > loops.length`, i.e. one or more entire chains were left out. */
  readonly loopsTruncated: boolean;
}

export interface EdgeSegmentSet {
  readonly segments: readonly TopologyEdgeSegment[];
  /** The kind's true count, independent of `maxIssueItems` truncation. */
  readonly count: number;
  readonly truncated: boolean;
}

export interface DegenerateTriangleSet {
  readonly triangles: readonly TopologyDegenerateTriangle[];
  /** The true count, independent of `maxIssueItems` truncation. */
  readonly count: number;
  readonly truncated: boolean;
}

export interface MeshHealthDiagnosis {
  readonly modelId: NormalizedModel["id"];
  readonly boundaryLoops: BoundaryLoopSet;
  readonly nonManifoldEdges: EdgeSegmentSet;
  readonly inconsistentOrientationEdges: EdgeSegmentSet;
  readonly degenerateTriangles: DegenerateTriangleSet;
}

/**
 * Builds a bounded, deterministic, VISUALIZATION-ready breakdown of one
 * model's mesh-health issues, for a UI that lets a user open a diagnostic
 * and highlight it in a viewport. Diagnostic-only: this function never
 * modifies, welds, repairs, or reinterprets the input model's geometry --
 * it only reports on it, exactly like `inspectModel`.
 *
 * A separate, opt-in entry point from `inspectModel` on purpose: every
 * `inspectModel` call stays cheap (a handful of bounded example locations
 * per issue kind); this function is for the moment a user actually opens a
 * diagnostic, so its heavier bounded evidence -- ordered boundary-loop
 * polylines and larger per-kind issue lists -- is only ever computed when
 * asked for.
 *
 * Reuses `summarizeModelGeometryWithDiagnosticEvidence` (`src/summary.ts`),
 * which performs the exact same placed-geometry walk and topology census as
 * `summarizeModelGeometry` and `inspectModel` -- this module adds no second
 * geometry pipeline, only loop tracing and bounded selection over that
 * shared census's evidence.
 *
 * **Boundary-loop tracing.** Boundary edges (touched by exactly one
 * triangle) are joined into maximal edge-disjoint chains using the same
 * exact-coordinate vertex keys the topology census already keys edges by
 * (see the README's "Topology semantics"). A chain that returns to its own
 * start is `closed: true`; one that runs out of unvisited edges at a
 * different vertex is `closed: false` -- this happens at a non-manifold
 * boundary vertex (touched by more than two boundary edges), and is
 * reported honestly rather than forced into a loop shape. Tracing visits
 * every boundary edge exactly once (proportional to the boundary-edge
 * count, which this package's existing expanded-triangle ceiling already
 * bounds before this function runs any O(triangles) work) using a sorted,
 * cursor-advanced adjacency structure, not a per-step rescan, so it stays
 * near-linear even at a single vertex touched by many boundary edges.
 *
 * **Determinism.** Chains are traced in a fixed order (vertices visited
 * ascending by position then vertex key; at each vertex, edges are walked
 * toward the lexicographically smallest unvisited neighbor position, tied
 * broken by a stable per-edge ordinal), so the *set* of chains found for a
 * given input is fixed. Each closed loop is then rotated to a canonical
 * form: start at its lexicographically smallest point (comparing x, then y,
 * then z), and walk in whichever of its two possible directions reaches a
 * lexicographically smaller second point. A non-closed chain is instead
 * oriented so its lexicographically smaller endpoint comes first (reversing
 * the whole chain if needed; a path cannot be rotated without changing
 * which edges are adjacent). Loops are finally ordered by descending edge
 * count, then ascending canonical start point, then closed-before-terminated,
 * then a full point-by-point comparison as a last-resort tie-break --
 * identical input, including a structurally-identical rebuilt model,
 * therefore produces a deeply-equal `MeshHealthDiagnosis` every time.
 *
 * **Bounds.** `maxBoundaryLoops` (default `DEFAULT_MAX_BOUNDARY_LOOPS` = 20,
 * ceiling `MAX_BOUNDARY_LOOPS` = 500) caps how many chains are returned.
 * `maxBoundaryLoopPoints` (default `DEFAULT_MAX_BOUNDARY_LOOP_POINTS` =
 * 2,000, ceiling `MAX_BOUNDARY_LOOP_POINTS` = 50,000) is a single point
 * budget shared across every returned loop, spent in the loops' final
 * sorted order; a loop that only partially fits is still returned with
 * `pointsTruncated: true` and its exact `edgeCount`/`closed`/
 * `perimeterMillimetres`, and `loopsTruncated` is set whenever any chain is
 * left out entirely because the loop or point budget ran out first.
 * `maxIssueItems` (default `DEFAULT_MAX_ISSUE_ITEMS` = 100, ceiling
 * `MAX_ISSUE_ITEMS` = 2,000) independently bounds the non-manifold-edge,
 * inconsistent-orientation-edge, and degenerate-triangle lists, using the
 * same bounded-during-the-walk collection `inspectModel`'s topology
 * examples use, just with a richer per-item shape (both edge endpoints, or
 * all three triangle corners, rather than a single midpoint/centroid) and a
 * larger default. Every bound throws `RangeError` when out of range rather
 * than silently clamping, matching `InspectOptions`.
 *
 * Fails closed exactly like `inspectModel`: `model` is validated against
 * `normalizedModelSchema` first (throwing the Zod error on failure), then
 * expanded vertex/triangle counts are checked against this package's
 * existing `ANALYSIS_LIMITS` ceilings before any O(vertices + triangles)
 * work runs, throwing `InspectionResourceLimitError` if exceeded.
 */
export function diagnoseMeshHealth(
  model: NormalizedModel,
  options: MeshHealthOptions = {},
): MeshHealthDiagnosis {
  const validated = normalizedModelSchema.parse(model);
  checkResourceCeiling(validated);

  const maxBoundaryLoops = resolveBound(
    options.maxBoundaryLoops,
    DEFAULT_MAX_BOUNDARY_LOOPS,
    MAX_BOUNDARY_LOOPS,
    "maxBoundaryLoops",
  );
  const maxBoundaryLoopPoints = resolveBound(
    options.maxBoundaryLoopPoints,
    DEFAULT_MAX_BOUNDARY_LOOP_POINTS,
    MAX_BOUNDARY_LOOP_POINTS,
    "maxBoundaryLoopPoints",
  );
  const maxIssueItems = resolveBound(
    options.maxIssueItems,
    DEFAULT_MAX_ISSUE_ITEMS,
    MAX_ISSUE_ITEMS,
    "maxIssueItems",
  );
  const modelToComparison = options.modelToComparison ?? IDENTITY_MAT4;

  const { evidence } = summarizeModelGeometryWithDiagnosticEvidence(
    validated,
    modelToComparison,
    maxIssueItems,
  );

  return {
    modelId: validated.id,
    boundaryLoops: buildBoundaryLoopSet(
      evidence.boundaryEdges ?? [],
      maxBoundaryLoops,
      maxBoundaryLoopPoints,
    ),
    nonManifoldEdges: buildEdgeSegmentSet(
      evidence.nonManifoldEdgeCount,
      evidence.nonManifoldEdgeSegments ?? [],
    ),
    inconsistentOrientationEdges: buildEdgeSegmentSet(
      evidence.inconsistentEdgeCount,
      evidence.inconsistentEdgeSegments ?? [],
    ),
    degenerateTriangles: buildDegenerateTriangleSet(
      evidence.degenerateTriangleCount,
      evidence.degenerateTriangleEntries ?? [],
    ),
  };
}

function buildEdgeSegmentSet(
  count: number,
  segments: readonly TopologyEdgeSegment[],
): EdgeSegmentSet {
  return { segments, count, truncated: segments.length < count };
}

function buildDegenerateTriangleSet(
  count: number,
  triangles: readonly TopologyDegenerateTriangle[],
): DegenerateTriangleSet {
  return { triangles, count, truncated: triangles.length < count };
}

// ---------------------------------------------------------------------------
// Boundary-loop tracing
// ---------------------------------------------------------------------------

interface RawChain {
  /** Canonical-order points; see `diagnoseMeshHealth`'s doc comment. */
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

function buildBoundaryLoopSet(
  boundaryEdges: readonly TopologyBoundaryEdge[],
  maxBoundaryLoops: number,
  maxBoundaryLoopPoints: number,
): BoundaryLoopSet {
  const chains = traceAllBoundaryChains(boundaryEdges)
    .map((chain) => ({
      ...chain,
      points: canonicalizeChain(chain.points, chain.closed),
    }))
    .sort(compareChains);

  const loopCount = chains.length;
  const loops: BoundaryLoop[] = [];
  let remainingPoints = maxBoundaryLoopPoints;
  for (const chain of chains) {
    if (loops.length >= maxBoundaryLoops || remainingPoints <= 0) break;
    const take = Math.min(chain.points.length, remainingPoints);
    loops.push({
      pointsMillimetres: chain.points.slice(0, take),
      edgeCount: chain.edgeCount,
      closed: chain.closed,
      perimeterMillimetres: perimeterOf(chain.points, chain.closed),
      pointsTruncated: take < chain.points.length,
    });
    remainingPoints -= take;
  }

  return { loops, loopCount, loopsTruncated: loops.length < loopCount };
}

/**
 * Decomposes every boundary edge into maximal edge-disjoint chains. Visits
 * vertices with an irregular (not exactly two) incident boundary-edge count
 * first, fully draining each one's incident edges before moving on, so any
 * edge left over afterward belongs to a vertex-disjoint set of pure
 * degree-two cycles -- the textbook approach to decomposing a graph into as
 * many simple cycles as possible with the unavoidable remainder expressed
 * as paths between the irregular vertices. Runs in time proportional to the
 * boundary-edge count: each vertex's incident-edge list is sorted once, and
 * traversal advances a per-vertex cursor past already-visited entries
 * rather than rescanning, so total pointer movement across the whole trace
 * is bounded by twice the edge count.
 */
function traceAllBoundaryChains(
  boundaryEdges: readonly TopologyBoundaryEdge[],
): RawChain[] {
  const adjacency = buildAdjacency(boundaryEdges);
  const visited = new Array<boolean>(boundaryEdges.length).fill(false);
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
      // A single boundary edge whose two endpoints coincide exactly.
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
  boundaryEdges: readonly TopologyBoundaryEdge[],
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

  boundaryEdges.forEach((edge, edgeId) => {
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
function canonicalizeChain(
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

function compareChains(left: RawChain, right: RawChain): number {
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

function perimeterOf(points: readonly Vec3[], closed: boolean): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distanceBetween(points[index - 1]!, points[index]!);
  }
  if (closed && points.length > 1) {
    total += distanceBetween(points[points.length - 1]!, points[0]!);
  }
  return normalizeZero(total);
}

function distanceBetween(first: Vec3, second: Vec3): number {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
  );
}

function comparePoints(left: Vec3, right: Vec3): number {
  for (let axis = 0; axis < 3; axis += 1) {
    const a = normalizeZero(left[axis]!);
    const b = normalizeZero(right[axis]!);
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
