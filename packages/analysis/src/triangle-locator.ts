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
  collectPlacedInstances,
  countExpandedGeometry,
  flattenModel,
} from "./geometry.js";
import type {
  FlatGeometry,
  PlacedInstanceId,
  PlacedMeshId,
} from "./geometry.js";

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

/**
 * A caller programming error, not a data-driven runtime outcome: an
 * out-of-range, non-integer, or non-finite `triangleIndex`, or a comparison
 * transform that produced non-finite flattened coordinates. Mirrors
 * `MeasurementInputError` (`src/measure.ts`) / `AlignmentInputError`
 * (`src/alignment.ts`).
 */
export class TriangleLocatorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriangleLocatorInputError";
  }
}

/**
 * Thrown when expanded geometry, or a caller-supplied `executionBudget`,
 * cannot accommodate flattening `model` -- before any O(vertices +
 * triangles) work runs. Mirrors `MeasurementResourceLimitError`
 * (`src/measure.ts`).
 */
export class TriangleLocatorResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriangleLocatorResourceLimitError";
  }
}

export interface FlattenedTriangleLocatorOptions {
  /**
   * Defaults to identity. Must be the exact same rigid transform the
   * reported `triangleIndex` values were originally flattened under (the
   * `modelToComparison` a caller already passed to `analyzeModelPair`,
   * `checkClearance`, `assessPrintability`, etc. for this model) -- this
   * function has no way to detect a mismatched transform, since any rigid
   * transform flattens to the same triangle count and order, only
   * different coordinates.
   */
  readonly modelToComparison?: RigidTransform;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
}

/** Provenance plus world-space geometry for one flattened triangle. See `flattenedTriangleLocator`. */
export interface FlattenedTriangleLocation {
  readonly triangleIndex: number;
  readonly meshId: PlacedMeshId;
  readonly instanceId: PlacedInstanceId;
  /** This triangle's index within its own mesh's `geometry.indices` -- independent of placement, i.e. the same value for every instance of a repeated mesh. */
  readonly meshLocalTriangleIndex: number;
  /** The triangle's three vertex positions, transformed into the comparison frame by the same instance placement and `modelToComparison` this locator was built with, in the mesh's own corner order. */
  readonly positionsMillimetres: readonly [Vec3, Vec3, Vec3];
}

export interface FlattenedTriangleLocator {
  /** The flattened comparison-frame geometry this locator resolves indices against -- identical to a direct `flattenModel` call over the same `(model, modelToComparison)`. */
  readonly geometry: FlatGeometry;
  readonly triangleCount: number;
  /**
   * Resolves one flattened `triangleIndex` -- as reported anywhere in this
   * package's results (region `triangleIndices`, topology-finding
   * `examples`, interference `trianglePairs`, printability island
   * components, and so on) -- to its provenance and world-space vertex
   * positions. Fails closed with `TriangleLocatorInputError` for any index
   * outside `[0, triangleCount)`, including non-finite or non-integer
   * input.
   */
  resolve(triangleIndex: number): FlattenedTriangleLocation;
}

/**
 * Builds a reusable resolver from a reported flattened `triangleIndex` back
 * to `(meshId, instanceId, meshLocalTriangleIndex, world-space vertex
 * positions)`. This is the supported way to map a `triangleIndex` this
 * package reports back to an actual mesh triangle -- for a UI to draw a
 * highlight against, for example -- instead of a consumer re-deriving
 * `flattenModel`'s mesh/instance/placement-tree traversal order in its own
 * code. See `flattenModel`'s doc comment (`src/geometry.ts`) for the full,
 * binding statement of the traversal order this mapping depends on: this
 * function is the one place that order is turned into an index lookup, so a
 * future change to that order (the only kind of change allowed to affect
 * it) only ever needs updating here.
 *
 * Deliberately reuses the package's existing flattening rather than a
 * second geometry pass: `model` is flattened exactly the way every other
 * entry point flattens it (`flattenModel`, under the same `ANALYSIS_LIMITS`
 * ceilings and charge-before-work `WorkBudget` discipline
 * `measureOnModel`/`checkClearance`/`sectionModel`/etc. all use), and
 * `collectPlacedInstances` -- the exact same shared traversal `flattenModel`
 * itself calls internally, never a second, re-derived copy of it -- is
 * called once more, purely to record each queued instance's `(meshId,
 * instanceId)` and its own mesh's triangle count, from which every
 * instance's contiguous flattened-triangle-index range is precomputed. That
 * second call is O(instances) (mesh triangle counts come from typed-array
 * `.length`, not per-triangle iteration), never O(vertices + triangles), so
 * it adds no material cost beyond flattening itself.
 *
 * Call this once per `(model, modelToComparison)` and reuse the returned
 * `resolve` for every index a caller needs -- e.g. every entry in one
 * region's `triangleIndices` -- rather than building a fresh locator per
 * index: building the locator performs the one O(vertices + triangles)
 * flatten, and each `resolve` call after that is O(log instances) (a binary
 * search over the precomputed per-instance triangle-range boundaries), not
 * O(instances) or O(triangles).
 *
 * Fails closed exactly like `measureOnModel`: `model` is validated against
 * `normalizedModelSchema`, `modelToComparison` (default identity) is
 * validated as a proper rigid transform (no scale, shear, or reflection),
 * expanded vertex/triangle counts and estimated memory are checked via
 * `checkExpandedGeometryBudget` before any O(vertices + triangles) work
 * runs (throwing `TriangleLocatorResourceLimitError`), and flattening
 * itself runs under a charge-before-work `WorkBudget` bounded by
 * `options.executionBudget?.maxWorkUnits` (throwing `WorkBudgetExceeded`/
 * `WorkBudgetInternalError` unchanged on exhaustion or misuse, matching
 * every other entry point in this package). `resolve` itself then rejects
 * any `triangleIndex` outside `[0, geometry.triangleCount)` with
 * `TriangleLocatorInputError` rather than reading out of bounds.
 *
 * Deterministic: identical `(model, modelToComparison)` produces an
 * identical `geometry` and identical `resolve` results every time, because
 * it depends on nothing beyond `flattenModel`'s own deterministic traversal
 * and `collectPlacedInstances`, the same function it calls internally.
 */
export function flattenedTriangleLocator(
  model: NormalizedModel,
  options: FlattenedTriangleLocatorOptions = {},
): FlattenedTriangleLocator {
  const validated = normalizedModelSchema.parse(model);
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
    throw new TriangleLocatorResourceLimitError(budgetProblem);
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
    throw new TriangleLocatorInputError(
      error instanceof Error ? error.message : "Comparison transform failed.",
    );
  }

  const meshes = new Map<string, NormalizedModel["meshes"][number]>(
    validated.meshes.map((mesh) => [mesh.id, mesh]),
  );
  const orderedInstances = collectPlacedInstances(validated, modelToComparison);
  const triangleRangeStart = new Array<number>(orderedInstances.length);
  let cursor = 0;
  for (let index = 0; index < orderedInstances.length; index += 1) {
    triangleRangeStart[index] = cursor;
    const mesh = meshes.get(orderedInstances[index]!.meshId)!;
    cursor += mesh.geometry.indices.length / 3;
  }

  function resolve(triangleIndex: number): FlattenedTriangleLocation {
    if (
      !Number.isSafeInteger(triangleIndex) ||
      triangleIndex < 0 ||
      triangleIndex >= geometry.triangleCount
    ) {
      throw new TriangleLocatorInputError(
        `triangleIndex must be a safe integer between 0 and ${geometry.triangleCount - 1}; received ${String(triangleIndex)}.`,
      );
    }

    // Binary search for the last instance whose triangle range starts at or
    // before `triangleIndex` -- the instance that contains it, since ranges
    // are contiguous and non-overlapping in `orderedInstances` order.
    let low = 0;
    let high = orderedInstances.length - 1;
    let instanceOrdinal = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (triangleRangeStart[mid]! <= triangleIndex) {
        instanceOrdinal = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const instance = orderedInstances[instanceOrdinal]!;
    const meshLocalTriangleIndex =
      triangleIndex - triangleRangeStart[instanceOrdinal]!;

    const base = triangleIndex * 3;
    const ia = geometry.indices[base]!;
    const ib = geometry.indices[base + 1]!;
    const ic = geometry.indices[base + 2]!;
    const positions = geometry.positions;
    const vertexAt = (vertexIndex: number): Vec3 => [
      positions[vertexIndex * 3]!,
      positions[vertexIndex * 3 + 1]!,
      positions[vertexIndex * 3 + 2]!,
    ];

    return {
      triangleIndex,
      meshId: instance.meshId,
      instanceId: instance.instanceId,
      meshLocalTriangleIndex,
      positionsMillimetres: [vertexAt(ia), vertexAt(ib), vertexAt(ic)],
    };
  }

  return { geometry, triangleCount: geometry.triangleCount, resolve };
}

/**
 * Convenience one-shot wrapper over `flattenedTriangleLocator` for a caller
 * that needs to resolve a single index. Resolving more than one index
 * against the same `(model, modelToComparison)` -- the common case, since
 * this package's `triangleIndices` fields are usually reported as bounded
 * lists -- should build one locator with `flattenedTriangleLocator` and call
 * its `resolve` repeatedly instead, so `model` is flattened once rather than
 * once per index.
 */
export function resolveFlattenedTriangle(
  model: NormalizedModel,
  triangleIndex: number,
  options: FlattenedTriangleLocatorOptions = {},
): FlattenedTriangleLocation {
  return flattenedTriangleLocator(model, options).resolve(triangleIndex);
}
