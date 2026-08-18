import { IDENTITY_MAT4, normalizedModelSchema } from "@voxelspy/contracts";
import type { Mat4, NormalizedModel, Vec3 } from "@voxelspy/contracts";

import {
  canonicalizeChain,
  compareChains,
  perimeterOf,
  traceAllChains,
} from "./chain-tracing.js";
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

function buildBoundaryLoopSet(
  boundaryEdges: readonly TopologyBoundaryEdge[],
  maxBoundaryLoops: number,
  maxBoundaryLoopPoints: number,
): BoundaryLoopSet {
  // Tracing itself (`traceAllChains`, `canonicalizeChain`, `compareChains`,
  // `perimeterOf`) is shared with `sectionModel`'s section-loop tracer --
  // see `src/chain-tracing.ts` -- rather than forked; `TopologyBoundaryEdge`
  // structurally satisfies `PositionedEdge`, so no adapter is needed here.
  const chains = traceAllChains(boundaryEdges)
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
