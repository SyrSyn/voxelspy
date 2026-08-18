import {
  IDENTITY_MAT4,
  normalizedModelSchema,
  rigidTransformSchema,
} from "@voxelspy/contracts";
import type {
  NormalizedModel,
  RigidTransform,
  Vec3,
} from "@voxelspy/contracts";

import {
  ANALYSIS_LIMITS,
  WorkBudget,
  WorkBudgetExceeded,
  WorkBudgetInternalError,
  checkExpandedGeometryBudget,
} from "./analyze.js";
import {
  canonicalizeChain,
  compareChains,
  normalizeZero,
  perimeterOf,
  traceAllChains,
} from "./chain-tracing.js";
import { countExpandedGeometry, flattenModel } from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";
import { resolveBound } from "./inspect.js";
import { pointKeyAt } from "./region-connectivity.js";
import type { PositionedEdge } from "./chain-tracing.js";

/** A caller programming error: a non-finite plane point/normal, or a degenerate (zero-length) plane normal. Mirrors `AlignmentInputError`/`MeasurementInputError`'s distinction. */
export class SectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionInputError";
  }
}

/** Thrown when expanded geometry, or a caller-supplied `executionBudget`, cannot accommodate the section -- before any O(vertices + triangles) work runs. Mirrors `MeasurementResourceLimitError`/`AlignmentResourceLimitError`. */
export class SectionResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionResourceLimitError";
  }
}

/** Default number of section loops returned before truncation. */
export const DEFAULT_MAX_SECTION_LOOPS = 200;
/** Implementation ceiling on `SectionOptions.maxLoops`. */
export const MAX_SECTION_LOOPS = 2_000;
/** Default total point budget shared across every returned loop. */
export const DEFAULT_MAX_SECTION_LOOP_POINTS = 20_000;
/** Implementation ceiling on `SectionOptions.maxLoopPoints`. */
export const MAX_SECTION_LOOP_POINTS = 200_000;

/** A cutting plane: any point on the plane, plus a normal vector (need not be unit length; `sectionModel` normalizes it). */
export interface SectionPlane {
  readonly point: Vec3;
  readonly normal: Vec3;
}

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

export interface SectionOptions {
  /** Defaults to identity. Validated as a proper rigid transform (no scale, shear, or reflection), matching `ClearancePlacement.modelToComparison` -- geometry placed for sectioning must never be silently scaled or sheared, which would distort the reported perimeters/areas. */
  readonly modelToComparison?: RigidTransform;
  /** Bounded by `MAX_SECTION_LOOPS`. Defaults to `DEFAULT_MAX_SECTION_LOOPS`. */
  readonly maxLoops?: number;
  /** Total points shared across every returned loop, not per loop. Bounded by `MAX_SECTION_LOOP_POINTS`. Defaults to `DEFAULT_MAX_SECTION_LOOP_POINTS`. */
  readonly maxLoopPoints?: number;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
}

/**
 * `available: true` only for a `closed` loop -- a genuinely open polyline
 * has no well-defined enclosed area. `signedSquareMillimetres` is signed
 * relative to the plane's supplied (post-normalization) `normal` direction,
 * via the standard 3D-polygon vector-area formula
 * (`0.5 * sum(P_i x P_{i+1})`, dotted with the unit normal): positive when
 * the loop's `pointsMillimetres` order winds counterclockwise around that
 * normal (right-hand rule, looking against the normal direction), negative
 * when clockwise. That winding is a byproduct of this package's
 * deterministic canonical point ordering (see `sectionModel`'s
 * "Determinism" section), not a measurement of which side of the loop is
 * "solid" or which loop is an outer boundary versus a hole -- do not infer
 * solid/hole or inside/outside from this sign alone.
 * `absoluteSquareMillimetres` is `|signedSquareMillimetres|`, independent of
 * winding direction.
 */
export type SectionLoopArea =
  | {
      readonly available: true;
      readonly signedSquareMillimetres: number;
      readonly absoluteSquareMillimetres: number;
    }
  | { readonly available: false; readonly reason: "not-closed" };

export interface SectionLoop {
  /** Ordered vertex positions in the comparison frame; for a closed loop this does not repeat the start point at the end. */
  readonly pointsMillimetres: readonly Vec3[];
  /** The loop's true segment count, independent of point-budget truncation. */
  readonly edgeCount: number;
  /** `true` when this chain returned to its own starting point; `false` when it terminated instead (an open mesh cut by the plane, or a boundary the plane grazes only partway). */
  readonly closed: boolean;
  /** Sum of consecutive point-to-point distances (including the closing segment when `closed`). Exact for the traced polyline -- not a claim about curvature the tessellation doesn't capture -- and exact even when `pointsMillimetres` is truncated. */
  readonly perimeterMillimetres: number;
  /** `true` when `pointsMillimetres` is a canonical-order prefix of this loop's full point list because `maxLoopPoints` ran out -- `edgeCount`/`closed`/`perimeterMillimetres`/`area` remain exact. */
  readonly pointsTruncated: boolean;
  readonly area: SectionLoopArea;
}

export interface SectionLoopSet {
  /** Bounded by both `maxLoops` and the shared `maxLoopPoints` budget; ordered per `sectionModel`'s "Determinism" section. */
  readonly loops: readonly SectionLoop[];
  /** Total loops/chains found, before `maxLoops`/`maxLoopPoints` truncation. */
  readonly loopCount: number;
  /** `true` whenever `loopCount > loops.length`, i.e. one or more entire loops were left out. */
  readonly loopsTruncated: boolean;
}

export interface SectionWarning {
  readonly code: string;
  readonly severity: "warning";
  readonly message: string;
}

export interface SectionResult {
  readonly modelId: NormalizedModel["id"];
  /** The plane actually used: `point` as supplied, `normal` normalized to unit length. */
  readonly plane: {
    readonly pointMillimetres: Vec3;
    readonly unitNormal: Vec3;
  };
  /** Always `"exact"` -- triangle/plane intersection is exact arithmetic, not sampled. See `sectionModel`'s doc comment for the precise claim. */
  readonly semantics: "exact";
  readonly loops: SectionLoopSet;
  /** Triangles whose all three vertices lie exactly in the cutting plane -- see the "Coincident-plane" section of `sectionModel`'s doc comment for how this degenerate case is handled. */
  readonly coincidentTriangleCount: number;
  readonly warnings: readonly SectionWarning[];
}

/**
 * Cross-sections `model` with `plane`, returning the section as ordered,
 * bounded polylines -- for a UI to render a 2D cut view or measure a
 * profile.
 *
 * **Algorithm.** Every triangle in the flattened comparison-frame geometry
 * is classified against the plane by the exact sign of
 * `unitNormal . vertex + d` at each of its three corners (`0` for a vertex
 * exactly on the plane, matching this package's no-tolerance-welding
 * philosophy for values that are direct evaluations of caller-supplied
 * input rather than accumulated error -- see "Topology semantics" in
 * ../README.md). Each triangle contributes at most one segment:
 *
 * - All three corners strictly the same side: no segment.
 * - All three corners exactly on the plane: the triangle is coincident with
 *   the cutting plane -- see "Coincident-plane" below.
 * - Exactly two corners on the plane: that edge lies exactly in the plane
 *   and is itself the segment.
 * - Exactly one corner on the plane, the other two strictly the same side:
 *   the plane only touches this triangle at that one vertex -- no segment
 *   (there is no crossing to trace).
 * - Exactly one corner on the plane, the other two on opposite sides: the
 *   segment runs from the on-plane vertex to the exact crossing point on
 *   the opposite edge.
 * - No corner on the plane, a 2-1 sign split: the segment runs between the
 *   exact crossing points on the two edges connecting the minority-sign
 *   vertex to each majority-sign vertex.
 *
 * A crossing point on a shared edge is computed identically regardless of
 * which of the edge's two triangles (or which vertex-index numbering,
 * facet-local or shared) supplies it: `edgeCrossing` below always orders the
 * edge's two endpoints by their exact-coordinate key (`pointKeyAt`, the same
 * key `assessGeometry` and `groupTrianglesByExactEdgeConnectivity` use) and
 * interpolates from the coordinate-lesser endpoint toward the
 * coordinate-greater one -- so two triangles sharing a bit-identical edge
 * always compute a bit-identical crossing point, which is what lets loop
 * tracing below key segment endpoints by exact string equality.
 *
 * **Loop tracing.** Segments are chained into loops using the same
 * exact-coordinate-keyed chain tracer `diagnoseMeshHealth`'s boundary-loop
 * tracer uses -- literally the same implementation, `traceAllChains` in
 * `src/chain-tracing.ts`, not a forked copy -- so a section of a closed,
 * watertight model produces `closed: true` loops, while a section of an
 * open mesh (a panel, a box missing a face) can produce `closed: false`
 * chains that terminate at the mesh's own boundary instead of looping back
 * on themselves, reported honestly rather than forced closed.
 *
 * **Determinism.** Identical to `diagnoseMeshHealth`'s rule (see its doc
 * comment in `src/diagnose.ts` for the full statement): each closed loop is
 * rotated to start at its lexicographically smallest point and walk toward
 * whichever of its two directions reaches a lexicographically smaller
 * second point; a non-closed chain is oriented so its lexicographically
 * smaller endpoint comes first. Loops are ordered by descending edge count,
 * then ascending canonical start point, then closed-before-terminated, then
 * a full point-by-point comparison as a last resort. `coincidentTriangleCount`
 * and segment classification are themselves deterministic (a fixed walk of
 * `geometry`'s own triangle order). Identical `model`/`plane`/`options`
 * therefore produces a deeply equal `SectionResult` every time.
 *
 * **Coincident-plane (degenerate case).** When the plane exactly coincides
 * with one or more triangles (every vertex on-plane), those triangles
 * contribute no segment of their own -- extracting a meaningful outline from
 * an in-plane triangle soup (which triangles form its boundary, accounting
 * for overlaps and holes) is a 2D-outline-extraction problem out of scope
 * here, the same kind of "no validated domain, so no approximation offered"
 * decision `checkClearance` makes for interference volume. Those triangles
 * are counted in `coincidentTriangleCount` and reported via a
 * `section.plane-coincident-with-faces` warning -- always surface this to
 * the caller rather than trusting the returned loops alone when it is
 * nonzero. In practice this is often harmless: any *adjacent* triangle that
 * has exactly one edge in the plane (two on-plane corners, one off-plane)
 * still contributes that edge as an ordinary segment (see the algorithm
 * list above), so a coincident face's own boundary is frequently still
 * recovered correctly from its neighbors -- but this is not guaranteed for
 * every mesh (an isolated coincident triangle with no such neighbor
 * contributes nothing), so `coincidentTriangleCount > 0` should always be
 * surfaced, not silently trusted.
 *
 * **A plane missing the model entirely** is not an error: `loops.loops` is
 * simply empty (`loopCount: 0`).
 *
 * **Bounds.** `maxLoops` (default `DEFAULT_MAX_SECTION_LOOPS` = 200, ceiling
 * `MAX_SECTION_LOOPS` = 2,000) caps how many loops are returned.
 * `maxLoopPoints` (default `DEFAULT_MAX_SECTION_LOOP_POINTS` = 20,000,
 * ceiling `MAX_SECTION_LOOP_POINTS` = 200,000) is a single point budget
 * shared across every returned loop, spent in the loops' final sorted
 * order -- a loop that only partially fits is still returned with
 * `pointsTruncated: true` and its exact `edgeCount`/`closed`/
 * `perimeterMillimetres`/`area`, and `loopsTruncated` is set whenever any
 * loop is left out entirely because either budget ran out first. Every
 * bound throws `RangeError` when out of range, matching
 * `InspectOptions`/`MeshHealthOptions`.
 *
 * **Resource discipline.** `model` is validated against
 * `normalizedModelSchema` first. Expanded vertex/triangle counts (plus
 * estimated memory, honoring an optional caller-supplied
 * `executionBudget.maxMemoryBytes`) are checked via
 * `checkExpandedGeometryBudget` -- the same pre-flight `checkClearance` and
 * `measureOnModel` use -- throwing `SectionResourceLimitError` before any
 * O(vertices + triangles) work runs if that fails. Flattening and the
 * per-triangle plane-intersection walk are charged to a charge-before-work
 * `WorkBudget` (bounded by `executionBudget.maxWorkUnits`, reusing
 * `ANALYSIS_LIMITS` from `src/analyze.ts` unchanged); an exhausted budget
 * throws `WorkBudgetExceeded` unchanged, matching every other entry point
 * in this package. An invalid `plane` (a non-finite point, a non-finite or
 * zero-length normal) throws `SectionInputError`.
 */
export function sectionModel(
  model: NormalizedModel,
  plane: SectionPlane,
  options: SectionOptions = {},
): SectionResult {
  const validated = normalizedModelSchema.parse(model);
  validateFiniteVec3(plane.point, "plane.point");
  validateFiniteVec3(plane.normal, "plane.normal");
  const normalLength = Math.hypot(
    plane.normal[0],
    plane.normal[1],
    plane.normal[2],
  );
  if (!(normalLength > 0)) {
    throw new SectionInputError(
      "plane.normal must be a finite, non-degenerate (nonzero-length) vector.",
    );
  }
  const unitNormal: Vec3 = [
    plane.normal[0] / normalLength,
    plane.normal[1] / normalLength,
    plane.normal[2] / normalLength,
  ];
  const planePoint: Vec3 = [
    normalizeZero(plane.point[0]),
    normalizeZero(plane.point[1]),
    normalizeZero(plane.point[2]),
  ];

  const maxLoops = resolveBound(
    options.maxLoops,
    DEFAULT_MAX_SECTION_LOOPS,
    MAX_SECTION_LOOPS,
    "maxLoops",
  );
  const maxLoopPoints = resolveBound(
    options.maxLoopPoints,
    DEFAULT_MAX_SECTION_LOOP_POINTS,
    MAX_SECTION_LOOP_POINTS,
    "maxLoopPoints",
  );
  const modelToComparison =
    options.modelToComparison === undefined
      ? IDENTITY_RIGID
      : rigidTransformSchema.parse(options.modelToComparison);

  const counts = countExpandedGeometry(validated);
  const budgetProblem = checkExpandedGeometryBudget(
    counts.vertices,
    counts.triangles,
    options.executionBudget,
  );
  if (budgetProblem !== undefined) {
    throw new SectionResourceLimitError(budgetProblem);
  }

  const workLimit = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    options.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  const work = new WorkBudget(workLimit);

  let geometry: FlatGeometry;
  try {
    geometry = flattenModel(validated, modelToComparison, work);
  } catch (error) {
    if (
      error instanceof WorkBudgetExceeded ||
      error instanceof WorkBudgetInternalError
    ) {
      throw error;
    }
    throw new SectionInputError(
      error instanceof Error ? error.message : "Comparison transform failed.",
    );
  }

  const { segments, coincidentTriangleCount } = computeSegments(
    geometry,
    unitNormal,
    planePoint,
    work,
  );

  const chains = traceAllChains(segments)
    .map((chain) => ({
      ...chain,
      points: canonicalizeChain(chain.points, chain.closed),
    }))
    .sort(compareChains);

  const loopCount = chains.length;
  const loops: SectionLoop[] = [];
  let remainingPoints = maxLoopPoints;
  for (const chain of chains) {
    if (loops.length >= maxLoops || remainingPoints <= 0) break;
    const take = Math.min(chain.points.length, remainingPoints);
    loops.push({
      pointsMillimetres: chain.points.slice(0, take),
      edgeCount: chain.edgeCount,
      closed: chain.closed,
      perimeterMillimetres: perimeterOf(chain.points, chain.closed),
      pointsTruncated: take < chain.points.length,
      area: chain.closed
        ? computeLoopArea(chain.points, unitNormal)
        : { available: false, reason: "not-closed" },
    });
    remainingPoints -= take;
  }

  const warnings: SectionWarning[] = [];
  if (loops.length < loopCount) {
    warnings.push({
      code: "section.loop-limit",
      severity: "warning",
      message: `${loopCount - loops.length} lower-ranked section loops were omitted by the requested loop/point limit.`,
    });
  }
  if (coincidentTriangleCount > 0) {
    warnings.push({
      code: "section.plane-coincident-with-faces",
      severity: "warning",
      message: `${coincidentTriangleCount} triangle(s) lie exactly in the cutting plane; they contribute no segment on their own and are excluded from the traced loops -- see sectionModel's "Coincident-plane" documentation.`,
    });
  }

  return {
    modelId: validated.id,
    plane: { pointMillimetres: planePoint, unitNormal },
    semantics: "exact",
    loops: { loops, loopCount, loopsTruncated: loops.length < loopCount },
    coincidentTriangleCount,
    warnings,
  };
}

function validateFiniteVec3(point: Vec3, label: string): void {
  if (!point.every((value) => Number.isFinite(value))) {
    throw new SectionInputError(`${label} must have finite x/y/z coordinates.`);
  }
}

/** Charged per triangle in `computeSegments`'s classification walk: reading three vertex coordinates, three plane-sign dot products, classification, and up to two `edgeCrossing` calls (each an exact-coordinate key lookup plus interpolation). */
const SECTION_TRIANGLE_WORK_UNITS = 20;

function computeSegments(
  geometry: FlatGeometry,
  unitNormal: Vec3,
  planePoint: Vec3,
  work: WorkUnitCounter,
): { segments: PositionedEdge[]; coincidentTriangleCount: number } {
  const [nx, ny, nz] = unitNormal;
  const d = -(nx * planePoint[0] + ny * planePoint[1] + nz * planePoint[2]);
  const triangleCount = geometry.triangleCount;
  const indices = geometry.indices;
  const positions = geometry.positions;
  const segments: PositionedEdge[] = [];
  let coincidentTriangleCount = 0;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    work.charge(SECTION_TRIANGLE_WORK_UNITS);
    const base = triangle * 3;
    const ia = indices[base]!;
    const ib = indices[base + 1]!;
    const ic = indices[base + 2]!;
    const sa = planeSignOf(positions, ia, nx, ny, nz, d);
    const sb = planeSignOf(positions, ib, nx, ny, nz, d);
    const sc = planeSignOf(positions, ic, nx, ny, nz, d);

    const outcome = classifyTriangle(geometry, ia, sa, ib, sb, ic, sc);
    if (outcome.kind === "coincident") {
      coincidentTriangleCount += 1;
      continue;
    }
    if (outcome.kind === "none") continue;
    segments.push({
      endpointsMillimetres: [outcome.p0, outcome.p1],
      endpointKeys: [sectionPointKey(outcome.p0), sectionPointKey(outcome.p1)],
    });
  }
  return { segments, coincidentTriangleCount };
}

function planeSignOf(
  positions: Float64Array,
  vertexIndex: number,
  nx: number,
  ny: number,
  nz: number,
  d: number,
): number {
  const base = vertexIndex * 3;
  return (
    nx * positions[base]! +
    ny * positions[base + 1]! +
    nz * positions[base + 2]! +
    d
  );
}

type TriangleClassification =
  | { readonly kind: "none" }
  | { readonly kind: "coincident" }
  | { readonly kind: "segment"; readonly p0: Vec3; readonly p1: Vec3 };

function classifyTriangle(
  geometry: FlatGeometry,
  ia: number,
  sa: number,
  ib: number,
  sb: number,
  ic: number,
  sc: number,
): TriangleClassification {
  const idx: readonly number[] = [ia, ib, ic];
  const signs: readonly number[] = [sa, sb, sc];
  const isZero: readonly boolean[] = signs.map((value) => value === 0);
  const zeroCount = isZero.filter(Boolean).length;

  if (zeroCount === 3) return { kind: "coincident" };

  if (zeroCount === 2) {
    const zeroIndices = [0, 1, 2].filter((corner) => isZero[corner]!);
    const [i, j] = zeroIndices as [number, number];
    return {
      kind: "segment",
      p0: normalizeVec3(vertexAt(geometry, idx[i]!)),
      p1: normalizeVec3(vertexAt(geometry, idx[j]!)),
    };
  }

  if (zeroCount === 1) {
    const zIndex = [0, 1, 2].find((corner) => isZero[corner]!)!;
    const others = [0, 1, 2].filter((corner) => corner !== zIndex) as [
      number,
      number,
    ];
    const [i, j] = others;
    if (Math.sign(signs[i]!) === Math.sign(signs[j]!)) return { kind: "none" };
    const crossing = edgeCrossing(
      geometry,
      idx[i]!,
      signs[i]!,
      idx[j]!,
      signs[j]!,
    );
    return {
      kind: "segment",
      p0: normalizeVec3(vertexAt(geometry, idx[zIndex]!)),
      p1: crossing,
    };
  }

  // zeroCount === 0: a strict 3-0 (no crossing) or 2-1 (one segment) split.
  const s0Positive = signs[0]! > 0;
  const s1Positive = signs[1]! > 0;
  const s2Positive = signs[2]! > 0;
  if (s0Positive === s1Positive && s1Positive === s2Positive) {
    return { kind: "none" };
  }
  const oddIndex =
    s0Positive === s1Positive ? 2 : s0Positive === s2Positive ? 1 : 0;
  const others = [0, 1, 2].filter((corner) => corner !== oddIndex) as [
    number,
    number,
  ];
  const p0 = edgeCrossing(
    geometry,
    idx[oddIndex]!,
    signs[oddIndex]!,
    idx[others[0]]!,
    signs[others[0]]!,
  );
  const p1 = edgeCrossing(
    geometry,
    idx[oddIndex]!,
    signs[oddIndex]!,
    idx[others[1]]!,
    signs[others[1]]!,
  );
  return { kind: "segment", p0, p1 };
}

function vertexAt(geometry: FlatGeometry, index: number): Vec3 {
  const base = index * 3;
  return [
    geometry.positions[base]!,
    geometry.positions[base + 1]!,
    geometry.positions[base + 2]!,
  ];
}

function normalizeVec3(point: Vec3): Vec3 {
  return [
    normalizeZero(point[0]),
    normalizeZero(point[1]),
    normalizeZero(point[2]),
  ];
}

/**
 * The exact plane-crossing point on the edge between vertex `indexA` (plane
 * sign `signA`) and vertex `indexB` (plane sign `signB`), where `signA` and
 * `signB` are known to have opposite signs. Always orders the two endpoints
 * by their exact-coordinate key (`pointKeyAt`, shared with region
 * connectivity and the manifold-edge census) before interpolating, so two
 * triangles sharing a bit-identical edge -- regardless of which one calls
 * this function, or which of the two vertex-index numberings a facet-local
 * mesh happens to assign them -- always compute a bit-identical result. This
 * is what makes exact-coordinate-keyed chain tracing (`traceAllChains`)
 * correctly connect segments computed from different triangles.
 */
function edgeCrossing(
  geometry: FlatGeometry,
  indexA: number,
  signA: number,
  indexB: number,
  signB: number,
): Vec3 {
  const keyA = pointKeyAt(geometry, indexA);
  const keyB = pointKeyAt(geometry, indexB);
  const [lowIndex, lowSign, highIndex, highSign] =
    keyA <= keyB
      ? [indexA, signA, indexB, signB]
      : [indexB, signB, indexA, signA];
  const low = vertexAt(geometry, lowIndex);
  const high = vertexAt(geometry, highIndex);
  const t = lowSign / (lowSign - highSign);
  return [
    normalizeZero(low[0] + (high[0] - low[0]) * t),
    normalizeZero(low[1] + (high[1] - low[1]) * t),
    normalizeZero(low[2] + (high[2] - low[2]) * t),
  ];
}

function sectionPointKey(point: Vec3): string {
  return `${point[0]},${point[1]},${point[2]}`;
}

/**
 * Vector area of a planar polygon via `0.5 * sum(P_i x P_{i+1})` (exact for
 * a planar loop, which every traced section loop is by construction --
 * every point lies exactly on the cutting plane). `absoluteSquareMillimetres`
 * is the vector's magnitude (orientation-independent); `signedSquareMillimetres`
 * is that vector dotted with `unitNormal` -- see `SectionLoopArea`'s doc
 * comment for exactly what the sign does and does not claim.
 */
function computeLoopArea(
  points: readonly Vec3[],
  unitNormal: Vec3,
): SectionLoopArea {
  if (points.length < 3) {
    return {
      available: true,
      signedSquareMillimetres: 0,
      absoluteSquareMillimetres: 0,
    };
  }
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    vx += a[1] * b[2] - a[2] * b[1];
    vy += a[2] * b[0] - a[0] * b[2];
    vz += a[0] * b[1] - a[1] * b[0];
  }
  vx /= 2;
  vy /= 2;
  vz /= 2;
  const signedSquareMillimetres = normalizeZero(
    vx * unitNormal[0] + vy * unitNormal[1] + vz * unitNormal[2],
  );
  const absoluteSquareMillimetres = normalizeZero(Math.hypot(vx, vy, vz));
  return {
    available: true,
    signedSquareMillimetres,
    absoluteSquareMillimetres,
  };
}
