import type {
  AffineTransform,
  Mat4,
  NormalizedModel,
  RigidTransform,
  Vec3,
} from "@voxelspy/contracts";

/** A charge-before-work budget shared by preprocessing and analysis phases. */
export interface WorkUnitCounter {
  charge(units: number): void;
}

/**
 * Flattened comparison-frame geometry backed by typed arrays.
 *
 * `positions` packs one Float64 triple per vertex (`[x0,y0,z0,x1,y1,z1,...]`,
 * length `vertexCount * 3`). `indices` packs one Uint32 triple per triangle
 * (`[a0,b0,c0,a1,b1,c1,...]`, length `triangleCount * 3`), each entry a
 * vertex index into `positions`. Neither array is ever copied into
 * per-vertex or per-triangle JS objects; downstream consumers read
 * coordinates directly by index.
 */
export interface FlatGeometry {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Charged per vertex streamed through the comparison transform. */
const FLATTEN_VERTEX_WORK_UNITS = 2;
/** Charged per triangle whose indices are copied into the flattened buffer. */
const FLATTEN_TRIANGLE_WORK_UNITS = 1;
/**
 * Preprocessing charges are applied in chunks of this many elements rather
 * than per element (to avoid millions of `charge` calls) or as one lump sum
 * for the whole model (so a budget too small to finish flattening still
 * fails before finishing it, not merely before starting).
 */
const PREPROCESSING_CHUNK_ELEMENTS = 1024;

export function countExpandedGeometry(model: NormalizedModel): {
  vertices: number;
  triangles: number;
} {
  const meshes = new Map<string, NormalizedModel["meshes"][number]>(
    model.meshes.map((mesh) => [mesh.id, mesh]),
  );
  let vertices = 0;
  let triangles = 0;
  for (const instance of model.placement.instances) {
    const mesh = meshes.get(instance.meshId);
    if (mesh === undefined) continue;
    vertices += mesh.geometry.positions.length / 3;
    triangles += mesh.geometry.indices.length / 3;
  }
  return { vertices, triangles };
}

/** Branded id types re-derived from the contract shape, matching `InspectionResult`/`MeshBreakdownEntry`'s convention (`src/inspect.ts`) of exposing the schema's own branded id types rather than widening to plain `string`. */
export type PlacedMeshId = NormalizedModel["meshes"][number]["id"];
export type PlacedInstanceId =
  NormalizedModel["placement"]["instances"][number]["id"];

export interface QueuedInstance {
  readonly meshId: PlacedMeshId;
  readonly instanceId: PlacedInstanceId;
  readonly transform: AffineTransform;
}

/**
 * Collects every mesh instance `model.placement` places, resolved to
 * `(meshId, instanceId, instance-to-comparison transform)` triples, in the
 * exact order `flattenModel` walks and flattens them -- see that function's
 * doc comment for the full, binding statement of what this order is and why
 * it is a stability guarantee. `flattenModel` and `flattenedTriangleLocator`
 * (`src/triangle-locator.ts`) both call this one function rather than each
 * re-deriving the walk, so there is exactly one implementation of this order
 * and the two can never silently diverge on it.
 *
 * An instance referencing an unknown mesh id is silently skipped (defensive:
 * schema-valid input, per `normalizedModelSchema`, cannot reach this), which
 * is why this is O(instances) plus one `Map` lookup per instance, never
 * O(vertices + triangles).
 */
export function collectPlacedInstances(
  model: NormalizedModel,
  modelToComparison: RigidTransform,
): QueuedInstance[] {
  const meshes = new Map<string, NormalizedModel["meshes"][number]>(
    model.meshes.map((mesh) => [mesh.id, mesh]),
  );
  const instances: QueuedInstance[] = [];

  const queueInstance = (
    meshId: PlacedMeshId,
    instanceId: PlacedInstanceId,
    instanceToModel: AffineTransform,
  ) => {
    if (!meshes.has(meshId)) return;
    instances.push({
      meshId,
      instanceId,
      transform: multiply(modelToComparison, instanceToModel),
    });
  };

  if (model.placement.kind === "flat") {
    for (const instance of model.placement.instances) {
      queueInstance(instance.meshId, instance.id, instance.meshToModel);
    }
  } else {
    const nodes = new Map(model.placement.nodes.map((node) => [node.id, node]));
    const nodeInstances = new Map(
      model.placement.instances.map((instance) => [instance.id, instance]),
    );
    const stack = [...model.placement.rootIds]
      .reverse()
      .map((id) => ({ id, parentToModel: IDENTITY as AffineTransform }));
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const node = nodes.get(current.id);
      if (node === undefined) continue;
      const nodeToModel = multiply(current.parentToModel, node.localToParent);
      for (const instanceId of node.instanceIds) {
        const instance = nodeInstances.get(instanceId);
        if (instance !== undefined) {
          queueInstance(
            instance.meshId,
            instance.id,
            multiply(nodeToModel, instance.meshToNode),
          );
        }
      }
      for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
        const childId = node.childIds[index];
        if (childId !== undefined) {
          stack.push({ id: childId, parentToModel: nodeToModel });
        }
      }
    }
  }

  return instances;
}

/**
 * Flattens a model's mesh instances into one comparison-frame typed-array
 * buffer.
 *
 * **Traversal order -- a stability guarantee.** Every `triangleIndex` this
 * package reports anywhere (region evidence, topology examples, interference
 * pairs, island components, and so on) is an index into the flattened
 * `indices` array this function produces, for a specific `(model,
 * modelToComparison)` pair. Consumers -- including UIs mapping a reported
 * index back to a specific mesh triangle to draw a highlight -- may rely on
 * the exact order below. Changing it is a breaking change to this package's
 * contract, not an internal refactor:
 *
 * 1. **Instance order** (which mesh instance contributes which contiguous
 *    run of the output): see `collectPlacedInstances` above for the precise
 *    walk --
 *    - `placement.kind === "flat"`: `placement.instances`, in array order.
 *    - `placement.kind === "hierarchy"`: a pre-order depth-first walk
 *      starting from `placement.rootIds` in array order; at each node, its
 *      own `instanceIds` are queued (in array order) before descending into
 *      its `childIds` (in array order, each child's entire subtree queued
 *      before moving to the next child).
 * 2. **Within each instance**, vertices are appended in that instance's own
 *    mesh's `geometry.positions` order (mesh-local vertex `0, 1, 2, ...`),
 *    and triangles are appended in that mesh's `geometry.indices` order
 *    (mesh-local triangle `0, 1, 2, ...`), each triangle's three vertex
 *    indices offset by that instance's cumulative vertex count so far.
 *
 * Consequently, each queued instance contributes one contiguous,
 * non-overlapping run of flattened triangle indices, in the order above,
 * whose length equals that instance's own mesh's triangle count -- so
 * flattened triangle index `i` always denotes mesh-local triangle
 * `i - (cumulative triangle count of every instance queued before it)` of
 * the instance found at that cumulative position. A consumer that needs to
 * resolve a reported `triangleIndex` back to `(meshId, instanceId,
 * meshLocalTriangleIndex, world-space vertex positions)` should call
 * `flattenedTriangleLocator` / `resolveFlattenedTriangle`
 * (`src/triangle-locator.ts`) rather than re-deriving this walk itself --
 * that is the one supported, tested way to do it, kept correct by
 * construction because it calls `collectPlacedInstances` and `flattenModel`
 * -- this same function -- rather than a second copy of either.
 *
 * The mesh-instance walk itself is O(instances): mesh sizes come from
 * typed-array `.length`, never per-element iteration. The O(vertices +
 * triangles) work is the transform-and-copy fill pass below, which charges
 * `work` in chunks before touching each chunk so an insufficient budget
 * fails closed before most (in the worst case, before any) of that work
 * runs.
 */
export function flattenModel(
  model: NormalizedModel,
  modelToComparison: RigidTransform,
  work: WorkUnitCounter,
): FlatGeometry {
  const meshes = new Map<string, NormalizedModel["meshes"][number]>(
    model.meshes.map((mesh) => [mesh.id, mesh]),
  );
  const instances = collectPlacedInstances(model, modelToComparison);

  let vertexCount = 0;
  let triangleCount = 0;
  for (const instance of instances) {
    const mesh = meshes.get(instance.meshId)!;
    vertexCount += mesh.geometry.positions.length / 3;
    triangleCount += mesh.geometry.indices.length / 3;
  }

  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);

  let vertexOffset = 0;
  let triangleOffset = 0;
  for (const instance of instances) {
    const mesh = meshes.get(instance.meshId)!;
    const transform = instance.transform;
    const meshPositions = mesh.geometry.positions;
    const meshIndices = mesh.geometry.indices;
    const baseVertex = vertexOffset;
    const meshVertexCount = meshPositions.length / 3;
    const meshTriangleCount = meshIndices.length / 3;

    for (
      let chunkStart = 0;
      chunkStart < meshVertexCount;
      chunkStart += PREPROCESSING_CHUNK_ELEMENTS
    ) {
      const chunkEnd = Math.min(
        chunkStart + PREPROCESSING_CHUNK_ELEMENTS,
        meshVertexCount,
      );
      work.charge((chunkEnd - chunkStart) * FLATTEN_VERTEX_WORK_UNITS);
      for (let vertex = chunkStart; vertex < chunkEnd; vertex += 1) {
        const px = meshPositions[vertex * 3] ?? 0;
        const py = meshPositions[vertex * 3 + 1] ?? 0;
        const pz = meshPositions[vertex * 3 + 2] ?? 0;
        const tx =
          (transform[0] ?? 0) * px +
          (transform[4] ?? 0) * py +
          (transform[8] ?? 0) * pz +
          (transform[12] ?? 0);
        const ty =
          (transform[1] ?? 0) * px +
          (transform[5] ?? 0) * py +
          (transform[9] ?? 0) * pz +
          (transform[13] ?? 0);
        const tz =
          (transform[2] ?? 0) * px +
          (transform[6] ?? 0) * py +
          (transform[10] ?? 0) * pz +
          (transform[14] ?? 0);
        if (
          !Number.isFinite(tx) ||
          !Number.isFinite(ty) ||
          !Number.isFinite(tz)
        ) {
          throw new Error(
            "A comparison transform produced non-finite coordinates",
          );
        }
        const outBase = vertexOffset * 3;
        positions[outBase] = tx;
        positions[outBase + 1] = ty;
        positions[outBase + 2] = tz;
        vertexOffset += 1;
      }
    }

    for (
      let chunkStart = 0;
      chunkStart < meshTriangleCount;
      chunkStart += PREPROCESSING_CHUNK_ELEMENTS
    ) {
      const chunkEnd = Math.min(
        chunkStart + PREPROCESSING_CHUNK_ELEMENTS,
        meshTriangleCount,
      );
      work.charge((chunkEnd - chunkStart) * FLATTEN_TRIANGLE_WORK_UNITS);
      for (let triangle = chunkStart; triangle < chunkEnd; triangle += 1) {
        const outBase = triangleOffset * 3;
        indices[outBase] = baseVertex + (meshIndices[triangle * 3] ?? 0);
        indices[outBase + 1] =
          baseVertex + (meshIndices[triangle * 3 + 1] ?? 0);
        indices[outBase + 2] =
          baseVertex + (meshIndices[triangle * 3 + 2] ?? 0);
        triangleOffset += 1;
      }
    }
  }

  return { positions, indices, vertexCount, triangleCount };
}

export function multiply(
  left: readonly number[],
  right: readonly number[],
): AffineTransform {
  const output = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        value +=
          (left[inner * 4 + row] ?? 0) * (right[column * 4 + inner] ?? 0);
      }
      output[column * 4 + row] = value;
    }
  }
  return output as AffineTransform;
}

/** Triangle area at `triangleIndex`, read directly from typed-array storage. */
export function triangleAreaAt(
  geometry: FlatGeometry,
  triangleIndex: number,
): number {
  const base = triangleIndex * 3;
  const ia = geometry.indices[base]!;
  const ib = geometry.indices[base + 1]!;
  const ic = geometry.indices[base + 2]!;
  const positions = geometry.positions;
  const ax = positions[ia * 3]!;
  const ay = positions[ia * 3 + 1]!;
  const az = positions[ia * 3 + 2]!;
  const abx = positions[ib * 3]! - ax;
  const aby = positions[ib * 3 + 1]! - ay;
  const abz = positions[ib * 3 + 2]! - az;
  const acx = positions[ic * 3]! - ax;
  const acy = positions[ic * 3 + 1]! - ay;
  const acz = positions[ic * 3 + 2]! - az;
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  return Math.hypot(crossX, crossY, crossZ) / 2;
}

/** Triangle centroid at `triangleIndex`. Bounded region-count call sites only. */
export function triangleCentroidAt(
  geometry: FlatGeometry,
  triangleIndex: number,
): Vec3 {
  const base = triangleIndex * 3;
  const ia = geometry.indices[base]!;
  const ib = geometry.indices[base + 1]!;
  const ic = geometry.indices[base + 2]!;
  const positions = geometry.positions;
  return [
    (positions[ia * 3]! + positions[ib * 3]! + positions[ic * 3]!) / 3,
    (positions[ia * 3 + 1]! + positions[ib * 3 + 1]! + positions[ic * 3 + 1]!) /
      3,
    (positions[ia * 3 + 2]! + positions[ib * 3 + 2]! + positions[ic * 3 + 2]!) /
      3,
  ];
}

/**
 * Squared distance from point `(px, py, pz)` to the triangle whose vertex
 * indices are `ia`, `ib`, `ic` in `positions`. Uses plain scalar arithmetic
 * throughout -- no intermediate Vec3 allocation -- since this is invoked
 * once per leaf-triangle candidate per sample point, i.e. potentially
 * hundreds of millions of times for large comparisons.
 */
export function pointTriangleDistanceSquared(
  px: number,
  py: number,
  pz: number,
  positions: Float64Array,
  ia: number,
  ib: number,
  ic: number,
): number {
  const ax = positions[ia * 3]!;
  const ay = positions[ia * 3 + 1]!;
  const az = positions[ia * 3 + 2]!;
  const bx = positions[ib * 3]!;
  const by = positions[ib * 3 + 1]!;
  const bz = positions[ib * 3 + 2]!;
  const cx = positions[ic * 3]!;
  const cy = positions[ic * 3 + 1]!;
  const cz = positions[ic * 3 + 2]!;

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    return apx * apx + apy * apy + apz * apz;
  }

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    return bpx * bpx + bpy * bpy + bpz * bpz;
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = px - (ax + abx * v);
    const dy = py - (ay + aby * v);
    const dz = pz - (az + abz * v);
    return dx * dx + dy * dy + dz * dz;
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    return cpx * cpx + cpy * cpy + cpz * cpz;
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = px - (ax + acx * w);
    const dy = py - (ay + acy * w);
    const dz = pz - (az + acz * w);
    return dx * dx + dy * dy + dz * dz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edgex = cx - bx;
    const edgey = cy - by;
    const edgez = cz - bz;
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const dx = px - (bx + edgex * w);
    const dy = py - (by + edgey * w);
    const dz = pz - (bz + edgez * w);
    return dx * dx + dy * dy + dz * dz;
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  const dx = px - (ax + abx * v + acx * w);
  const dy = py - (ay + aby * v + acy * w);
  const dz = pz - (az + abz * v + acz * w);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * The closest point on the triangle whose vertex indices are `ia`, `ib`,
 * `ic` in `positions` to point `(px, py, pz)`, as a comparison-frame `Vec3`.
 *
 * Deliberately a separate routine from `pointTriangleDistanceSquared`
 * (rather than that routine's cases refactored to also return a point)
 * because that function is invoked up to hundreds of millions of times for
 * large comparisons and must stay allocation-free; this routine runs only
 * once per final answer -- `checkClearance`'s closest-point-pair report
 * (`src/clearance.ts`) calls it exactly once, on the one triangle a prior
 * `TriangleSpatialIndex.nearestTriangle` call already identified as nearest
 * -- so the small cost of returning a `Vec3` is immaterial. Uses the exact
 * same Voronoi-region case analysis (Ericson, "Real-Time Collision
 * Detection"), so the point returned here is always consistent with the
 * squared distance that routine would compute for the same inputs.
 */
export function closestPointOnTriangle(
  px: number,
  py: number,
  pz: number,
  positions: Float64Array,
  ia: number,
  ib: number,
  ic: number,
): Vec3 {
  const ax = positions[ia * 3]!;
  const ay = positions[ia * 3 + 1]!;
  const az = positions[ia * 3 + 2]!;
  const bx = positions[ib * 3]!;
  const by = positions[ib * 3 + 1]!;
  const bz = positions[ib * 3 + 2]!;
  const cx = positions[ic * 3]!;
  const cy = positions[ic * 3 + 1]!;
  const cz = positions[ic * 3 + 2]!;

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    return [ax, ay, az];
  }

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    return [bx, by, bz];
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [ax + abx * v, ay + aby * v, az + abz * v];
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    return [cx, cy, cz];
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [ax + acx * w, ay + acy * w, az + acz * w];
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edgex = cx - bx;
    const edgey = cy - by;
    const edgez = cz - bz;
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [bx + edgex * w, by + edgey * w, bz + edgez * w];
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return [
    ax + abx * v + acx * w,
    ay + aby * v + acy * w,
    az + abz * v + acz * w,
  ];
}

/**
 * Threshold on `det^2 / (|direction|^2 * |normal|^2)` (approximately `sin^2`
 * of the angle between the ray direction and the triangle's plane) below
 * which a ray is treated as parallel to the triangle's plane and the
 * triangle is skipped. Mirrors `RAY_PARALLEL_RELATIVE_EPSILON` in
 * `src/measure.ts`'s independent linear-scan ray cast -- see that
 * constant's doc comment for the full rationale -- kept as a second copy
 * here (not exported/shared) because `src/measure.ts` depends on this
 * module, not the reverse, and the two ray casts are intentionally
 * independent implementations that happen to need the identical
 * relative-magnitude discipline.
 */
const RAY_TRIANGLE_PARALLEL_RELATIVE_EPSILON = 1e-20;

/**
 * Exact Moller-Trumbore ray/triangle intersection parameter `t` (Moller &
 * Trumbore, "Fast, Minimum Storage Ray-Triangle Intersection", Journal of
 * Graphics Tools, 1997) for the ray `origin + t * direction` against the
 * triangle `ia`/`ib`/`ic` in `positions`, or `undefined` when the ray does
 * not hit the triangle. Touching an edge or vertex counts as a hit (`u`,
 * `v`, `u + v` all tested inclusively, the same touching-counts convention
 * `trianglesIntersect` in `src/triangle-triangle.ts` and `src/measure.ts`'s
 * `castRay` use); only intersections at or ahead of the origin (`t >= 0`)
 * are returned.
 *
 * The single-triangle primitive behind `TriangleSpatialIndex.castRayNearest`'s
 * BVH-pruned traversal (`src/spatial-index.ts`) -- and structurally
 * identical to (though not shared code with) `src/measure.ts`'s `castRay`,
 * which performs the same per-triangle test as a full linear scan. Because
 * both ray casts apply this same math per candidate triangle, differing
 * only in which triangles they visit, a brute-force scan built from this
 * exported function (see `test/spatial-index-ray-property.test.ts`) is a
 * meaningful ground truth for the BVH traversal specifically -- the same
 * relationship `pointTriangleDistanceSquared` already has to
 * `TriangleSpatialIndex.distance`/`nearestTriangle`.
 */
export function rayTriangleIntersectionT(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  positions: Float64Array,
  ia: number,
  ib: number,
  ic: number,
): number | undefined {
  const ax = positions[ia * 3]!;
  const ay = positions[ia * 3 + 1]!;
  const az = positions[ia * 3 + 2]!;
  const bx = positions[ib * 3]!;
  const by = positions[ib * 3 + 1]!;
  const bz = positions[ib * 3 + 2]!;
  const cx = positions[ic * 3]!;
  const cy = positions[ic * 3 + 1]!;
  const cz = positions[ic * 3 + 2]!;

  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;

  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const normalLengthSquared = nx * nx + ny * ny + nz * nz;

  const pvx = dy * e2z - dz * e2y;
  const pvy = dz * e2x - dx * e2z;
  const pvz = dx * e2y - dy * e2x;
  const det = e1x * pvx + e1y * pvy + e1z * pvz;
  const dirLengthSquared = dx * dx + dy * dy + dz * dz;
  if (
    det * det <=
    RAY_TRIANGLE_PARALLEL_RELATIVE_EPSILON *
      dirLengthSquared *
      normalLengthSquared
  ) {
    return undefined;
  }
  const invDet = 1 / det;

  const tvx = ox - ax;
  const tvy = oy - ay;
  const tvz = oz - az;
  const u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
  if (u < 0 || u > 1) return undefined;

  const qvx = tvy * e1z - tvz * e1y;
  const qvy = tvz * e1x - tvx * e1z;
  const qvz = tvx * e1y - tvy * e1x;
  const v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
  if (v < 0 || u + v > 1) return undefined;

  const t = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
  if (t < 0) return undefined;
  return t;
}
