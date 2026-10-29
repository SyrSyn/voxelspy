import {
  IDENTITY_MAT4,
  normalizedModelSchema,
  rigidTransformSchema,
  type NormalizedModel,
  type RigidTransform,
  type Vec3,
} from "@voxelspy/contracts";
import {
  ANALYSIS_LIMITS,
  WorkBudget,
  WorkBudgetExceeded,
  checkExpandedGeometryBudget,
} from "./analyze.js";
import {
  collectPlacedInstances,
  countExpandedGeometry,
  flattenModel,
  type FlatGeometry,
} from "./geometry.js";
import { TriangleSpatialIndex } from "./spatial-index.js";
import type { FlattenedTriangleLocation } from "./triangle-locator.js";

export const SELF_INTERSECTION_LIMITS = Object.freeze({
  triangles: 50_000,
  vertices: 150_000,
  candidatePairs: 1_000_000,
  reportedPairs: 2_000,
  coordinateMagnitudeMillimetres: 1e12,
  minimumDyadicExponent: -128,
});

export interface SelfIntersectionOptions {
  readonly modelToComparison?: RigidTransform;
  readonly maxReportedPairs?: number;
  readonly maxCandidatePairs?: number;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
  /** Synchronous cooperative cancellation; workers may instead terminate the task. Never serialized. */
  readonly isCancelled?: () => boolean;
}
export interface SelfIntersectionPair {
  readonly kind:
    | "duplicate"
    | "coplanar-overlap"
    | "coplanar-contact"
    | "noncoplanar-intersection"
    | "point-contact";
  readonly first: FlattenedTriangleLocation;
  readonly second: FlattenedTriangleLocation;
}
interface CommonResult {
  readonly contractVersion: 1;
  readonly modelId: NormalizedModel["id"];
  readonly method: {
    readonly id: "voxelspy.self-intersection.dyadic";
    readonly version: "1";
  };
  readonly semantics: "exact-predicates-on-transformed-float64-within-domain";
  readonly domain: typeof SELF_INTERSECTION_LIMITS;
  readonly parameters: {
    readonly modelToComparison: RigidTransform;
    readonly maxReportedPairs: number;
    readonly maxCandidatePairs: number;
  };
  readonly triangleCount: number;
  readonly testedPairCount: number;
  readonly pairs: readonly SelfIntersectionPair[];
  readonly truncated: boolean;
}
export type SelfIntersectionResult = CommonResult &
  (
    | { readonly state: "complete"; readonly pairCount: number }
    | {
        readonly state: "indeterminate";
        readonly reason:
          | "resource-limit"
          | "cancelled"
          | "unsupported-numeric-domain"
          | "degenerate-triangle";
        readonly observedPairCount: number;
      }
  );

class Refusal extends Error {
  constructor(
    readonly reason:
      | "cancelled"
      | "unsupported-numeric-domain"
      | "degenerate-triangle"
      | "resource-limit",
  ) {
    super(reason);
  }
}
type I3 = readonly [bigint, bigint, bigint];
interface RationalPoint {
  readonly n: I3;
  readonly d: bigint;
}
const scratch = new DataView(new ArrayBuffer(8));

/** Exact integer on a 2^-128 mm lattice, rejecting values outside the documented domain. */
function integerCoordinate(value: number): bigint {
  if (
    !Number.isFinite(value) ||
    Math.abs(value) > SELF_INTERSECTION_LIMITS.coordinateMagnitudeMillimetres
  )
    throw new Refusal("unsupported-numeric-domain");
  if (value === 0) return 0n;
  scratch.setFloat64(0, value, false);
  const bits = scratch.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 2047n);
  let mantissa = bits & ((1n << 52n) - 1n);
  let exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  if (exponentBits !== 0) mantissa |= 1n << 52n;
  while ((mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent += 1;
  }
  if (exponent < -128) throw new Refusal("unsupported-numeric-domain");
  const result = mantissa << BigInt(exponent + 128);
  return bits >> 63n === 0n ? result : -result;
}
function sub(a: I3, b: I3): I3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: I3, b: I3): I3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a: I3, b: I3): bigint {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function zero(a: I3): boolean {
  return a.every((v) => v === 0n);
}
function equal(a: I3, b: I3): boolean {
  return a.every((v, i) => v === b[i]);
}
function sign(v: bigint): number {
  return v > 0n ? 1 : v < 0n ? -1 : 0;
}
function point(n: I3, d = 1n): RationalPoint {
  return d < 0n ? { n: [-n[0], -n[1], -n[2]], d: -d } : { n, d };
}
function scaledDifference(p: RationalPoint, q: RationalPoint): I3 {
  return [
    p.n[0] * q.d - q.n[0] * p.d,
    p.n[1] * q.d - q.n[1] * p.d,
    p.n[2] * q.d - q.n[2] * p.d,
  ];
}
function samePoint(p: RationalPoint, q: RationalPoint): boolean {
  return zero(scaledDifference(p, q));
}
function inside(p: RationalPoint, t: readonly I3[], n: I3): boolean {
  return t.every(
    (a, i) =>
      dot(
        cross(
          sub(t[(i + 1) % 3]!, a),
          sub(p.n, [a[0] * p.d, a[1] * p.d, a[2] * p.d]),
        ),
        n,
      ) >= 0n,
  );
}
function onShared(p: RationalPoint, shared: readonly I3[]): boolean {
  if (shared.some((v) => samePoint(p, point(v)))) return true;
  if (shared.length !== 2) return false;
  const a = shared[0]!,
    b = shared[1]!,
    delta = sub(p.n, [a[0] * p.d, a[1] * p.d, a[2] * p.d]);
  if (!zero(cross(sub(b, a), delta))) return false;
  return p.n.every(
    (v, i) =>
      v >= (a[i]! < b[i]! ? a[i]! : b[i]!) * p.d &&
      v <= (a[i]! > b[i]! ? a[i]! : b[i]!) * p.d,
  );
}
function projectedCross(a: I3, b: I3, drop: number): bigint {
  const x = (drop + 1) % 3,
    y = (drop + 2) % 3;
  return a[x]! * b[y]! - a[y]! * b[x]!;
}

/** Intersection vertices suffice: triangle intersections are convex. No rounded intersection point is computed. */
function classify(
  a: readonly I3[],
  b: readonly I3[],
): SelfIntersectionPair["kind"] | undefined {
  const na = cross(sub(a[1]!, a[0]!), sub(a[2]!, a[0]!));
  const nb = cross(sub(b[1]!, b[0]!), sub(b[2]!, b[0]!));
  const shared = a.filter((v) => b.some((w) => equal(v, w)));
  if (shared.length === 3) return "duplicate";
  const coplanar = zero(cross(na, nb)) && dot(na, sub(b[0]!, a[0]!)) === 0n;
  const points: RationalPoint[] = [];
  for (const [source, target, normal] of [
    [a, b, nb],
    [b, a, na],
  ] as const) {
    for (let i = 0; i < 3; i++) {
      const start = source[i]!,
        end = source[(i + 1) % 3]!;
      const s = dot(normal, sub(start, target[0]!)),
        e = dot(normal, sub(end, target[0]!));
      if (s === 0n && inside(point(start), target, normal))
        points.push(point(start));
      if (sign(s) * sign(e) < 0) {
        const d = s - e;
        const p = point(
          [
            end[0] * s - start[0] * e,
            end[1] * s - start[1] * e,
            end[2] * s - start[2] * e,
          ],
          d,
        );
        if (inside(p, target, normal)) points.push(p);
      }
    }
  }
  if (coplanar) {
    const drop = na.findIndex((v) => v !== 0n);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const p = a[i]!,
          q = b[j]!,
          r = sub(a[(i + 1) % 3]!, p),
          s = sub(b[(j + 1) % 3]!, q);
        const denominator = projectedCross(r, s, drop);
        if (denominator === 0n) continue; // Collinear overlap endpoints were handled by the inside tests.
        const offset = sub(q, p),
          tn = projectedCross(offset, s, drop),
          un = projectedCross(offset, r, drop);
        const denominatorSign = sign(denominator);
        if (
          sign(tn) * denominatorSign < 0 ||
          sign(denominator - tn) * denominatorSign < 0 ||
          sign(un) * denominatorSign < 0 ||
          sign(denominator - un) * denominatorSign < 0
        )
          continue;
        points.push(
          point(
            [
              p[0] * denominator + r[0] * tn,
              p[1] * denominator + r[1] * tn,
              p[2] * denominator + r[2] * tn,
            ],
            denominator,
          ),
        );
      }
  }
  if (
    points.length === 0 ||
    (shared.length > 0 && points.every((p) => onShared(p, shared)))
  )
    return undefined;
  const first = points[0]!,
    other = points.find((p) => !samePoint(p, first));
  if (!other) return "point-contact";
  if (!coplanar) return "noncoplanar-intersection";
  const direction = scaledDifference(other, first);
  return points.some((p) => !zero(cross(direction, scaledDifference(p, first))))
    ? "coplanar-overlap"
    : "coplanar-contact";
}
function readTriangle(
  geometry: FlatGeometry,
  index: number,
): readonly [Vec3, Vec3, Vec3] {
  return [0, 1, 2].map((corner) => {
    const offset = geometry.indices[index * 3 + corner]! * 3;
    return [
      geometry.positions[offset]!,
      geometry.positions[offset + 1]!,
      geometry.positions[offset + 2]!,
    ] as Vec3;
  }) as unknown as readonly [Vec3, Vec3, Vec3];
}
function integerTriangle(vertices: readonly Vec3[]): readonly I3[] {
  return vertices.map((p) => p.map(integerCoordinate) as unknown as I3);
}
function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new RangeError(
      `Self-intersection option must be an integer in [${minimum}, ${maximum}].`,
    );
  return result;
}

/** Diagnostic evidence on placed, already-rounded Float64 triangles. Never repairs or welds geometry. */
export function checkSelfIntersections(
  model: NormalizedModel,
  options: SelfIntersectionOptions = {},
): SelfIntersectionResult {
  const validated = normalizedModelSchema.parse(model);
  const transform = rigidTransformSchema.parse(
    options.modelToComparison ?? IDENTITY_MAT4,
  );
  const maximum = boundedOption(
    options.maxReportedPairs,
    100,
    SELF_INTERSECTION_LIMITS.reportedPairs,
    0,
  );
  const candidateLimit = boundedOption(
    options.maxCandidatePairs,
    100_000,
    SELF_INTERSECTION_LIMITS.candidatePairs,
    1,
  );
  for (const value of [
    options.executionBudget?.maxWorkUnits,
    options.executionBudget?.maxMemoryBytes,
  ])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new RangeError("Execution budgets must be positive safe integers.");
  const counts = countExpandedGeometry(validated);
  const pairs: SelfIntersectionPair[] = [];
  let testedPairCount = 0,
    pairCount = 0;
  const common = (): CommonResult => ({
    contractVersion: 1,
    modelId: validated.id,
    method: { id: "voxelspy.self-intersection.dyadic", version: "1" },
    semantics: "exact-predicates-on-transformed-float64-within-domain",
    domain: SELF_INTERSECTION_LIMITS,
    parameters: {
      modelToComparison: transform,
      maxReportedPairs: maximum,
      maxCandidatePairs: candidateLimit,
    },
    triangleCount: counts.triangles,
    testedPairCount,
    pairs,
    truncated: pairCount > pairs.length,
  });
  try {
    const budget = new WorkBudget(
      Math.min(
        options.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
        ANALYSIS_LIMITS.maxWorkUnits,
      ),
    );
    const work = {
      charge(units: number) {
        if (options.isCancelled?.()) throw new Refusal("cancelled");
        budget.charge(units);
      },
    };
    work.charge(1);
    if (
      counts.triangles > SELF_INTERSECTION_LIMITS.triangles ||
      counts.vertices > SELF_INTERSECTION_LIMITS.vertices ||
      checkExpandedGeometryBudget(
        counts.vertices,
        counts.triangles,
        options.executionBudget,
      )
    )
      throw new Refusal("resource-limit");
    let geometry: FlatGeometry;
    try {
      geometry = flattenModel(validated, transform, work);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "A comparison transform produced non-finite coordinates"
      )
        throw new Refusal("unsupported-numeric-domain");
      throw error;
    }
    // Validate the entire domain before returning any clear outcome, even when BVH boxes never meet.
    for (let i = 0; i < geometry.triangleCount; i++) {
      work.charge(64);
      const t = integerTriangle(readTriangle(geometry, i));
      if (zero(cross(sub(t[1]!, t[0]!), sub(t[2]!, t[0]!))))
        throw new Refusal("degenerate-triangle");
    }
    const meshes = new Map(validated.meshes.map((m) => [m.id, m]));
    const ranges = collectPlacedInstances(validated, transform).map(
      (instance) => ({ instance, start: 0, end: 0 }),
    );
    let cursor = 0;
    for (const range of ranges) {
      work.charge(1);
      range.start = cursor;
      cursor += meshes.get(range.instance.meshId)!.geometry.indices.length / 3;
      range.end = cursor;
    }
    const locate = (triangleIndex: number): FlattenedTriangleLocation => {
      let low = 0,
        high = ranges.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (ranges[middle]!.end <= triangleIndex) low = middle + 1;
        else high = middle;
      }
      const range = ranges[low]!;
      return {
        triangleIndex,
        meshId: range.instance.meshId,
        instanceId: range.instance.instanceId,
        meshLocalTriangleIndex: triangleIndex - range.start,
        positionsMillimetres: readTriangle(geometry, triangleIndex),
      };
    };
    if (geometry.triangleCount > 0) {
      const index = new TriangleSpatialIndex(geometry, work);
      for (let first = 0; first < geometry.triangleCount; first++) {
        work.charge(64);
        const vertices = readTriangle(geometry, first);
        const mins = [0, 1, 2].map((axis) =>
            Math.min(...vertices.map((p) => p[axis]!)),
          ),
          maxs = [0, 1, 2].map((axis) =>
            Math.max(...vertices.map((p) => p[axis]!)),
          );
        const candidates = index.overlapping(
          mins[0]!,
          mins[1]!,
          mins[2]!,
          maxs[0]!,
          maxs[1]!,
          maxs[2]!,
          work,
        );
        work.charge(
          candidates.length * Math.ceil(Math.log2(candidates.length + 1)),
        );
        candidates.sort((a, b) => a - b);
        for (const second of candidates) {
          work.charge(1);
          if (second <= first) continue;
          if (testedPairCount >= candidateLimit)
            throw new Refusal("resource-limit");
          // All integer coordinates have at most 168 bits; rational intermediate
          // products are bounded to a few thousand bits. Fixed cost is structural,
          // not a promise about BigInt runtime on a particular device.
          work.charge(4096);
          const kind = classify(
            integerTriangle(vertices),
            integerTriangle(readTriangle(geometry, second)),
          );
          testedPairCount++;
          if (kind !== undefined) {
            pairCount++;
            if (pairs.length < maximum)
              pairs.push({
                kind,
                first: locate(first),
                second: locate(second),
              });
          }
        }
      }
    }
    return { ...common(), state: "complete", pairCount };
  } catch (error) {
    if (error instanceof Refusal || error instanceof WorkBudgetExceeded)
      return {
        ...common(),
        state: "indeterminate",
        reason: error instanceof Refusal ? error.reason : "resource-limit",
        observedPairCount: pairCount,
      };
    throw error;
  }
}
