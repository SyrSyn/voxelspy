import type {
  AffineTransform,
  Mat4,
  NormalizedModel,
  RigidTransform,
  Vec3,
} from "@voxelspy/contracts";

export interface Triangle {
  readonly index: number;
  readonly vertices: readonly [number, number, number];
  readonly points: readonly [Vec3, Vec3, Vec3];
  readonly area: number;
}

export interface FlatGeometry {
  readonly points: readonly Vec3[];
  readonly triangles: readonly Triangle[];
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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

export function flattenModel(
  model: NormalizedModel,
  modelToComparison: RigidTransform,
): FlatGeometry {
  const meshes = new Map<string, NormalizedModel["meshes"][number]>(
    model.meshes.map((mesh) => [mesh.id, mesh]),
  );
  const points: Vec3[] = [];
  const triangleIndices: Array<[number, number, number]> = [];

  const appendInstance = (meshId: string, instanceToModel: AffineTransform) => {
    const mesh = meshes.get(meshId);
    if (mesh === undefined) return;
    const transform = multiply(modelToComparison, instanceToModel);
    const offset = points.length;
    for (
      let positionIndex = 0;
      positionIndex < mesh.geometry.positions.length;
      positionIndex += 3
    ) {
      const transformed = transformPoint(transform, [
        mesh.geometry.positions[positionIndex] ?? 0,
        mesh.geometry.positions[positionIndex + 1] ?? 0,
        mesh.geometry.positions[positionIndex + 2] ?? 0,
      ]);
      if (!transformed.every(Number.isFinite)) {
        throw new Error(
          "A comparison transform produced non-finite coordinates",
        );
      }
      points.push(transformed);
    }
    for (let index = 0; index < mesh.geometry.indices.length; index += 3) {
      triangleIndices.push([
        offset + (mesh.geometry.indices[index] ?? 0),
        offset + (mesh.geometry.indices[index + 1] ?? 0),
        offset + (mesh.geometry.indices[index + 2] ?? 0),
      ]);
    }
  };

  if (model.placement.kind === "flat") {
    for (const instance of model.placement.instances) {
      appendInstance(instance.meshId, instance.meshToModel);
    }
  } else {
    const nodes = new Map(model.placement.nodes.map((node) => [node.id, node]));
    const instances = new Map(
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
        const instance = instances.get(instanceId);
        if (instance !== undefined) {
          appendInstance(
            instance.meshId,
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

  const triangles = triangleIndices.map((vertices, index): Triangle => {
    const first = points[vertices[0]]!;
    const second = points[vertices[1]]!;
    const third = points[vertices[2]]!;
    return {
      index,
      vertices,
      points: [first, second, third],
      area: triangleArea(first, second, third),
    };
  });
  return { points, triangles };
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

export function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  return [
    (matrix[0] ?? 0) * point[0] +
      (matrix[4] ?? 0) * point[1] +
      (matrix[8] ?? 0) * point[2] +
      (matrix[12] ?? 0),
    (matrix[1] ?? 0) * point[0] +
      (matrix[5] ?? 0) * point[1] +
      (matrix[9] ?? 0) * point[2] +
      (matrix[13] ?? 0),
    (matrix[2] ?? 0) * point[0] +
      (matrix[6] ?? 0) * point[1] +
      (matrix[10] ?? 0) * point[2] +
      (matrix[14] ?? 0),
  ];
}

export function triangleArea(first: Vec3, second: Vec3, third: Vec3): number {
  const ab = subtract(second, first);
  const ac = subtract(third, first);
  return Math.hypot(...cross(ab, ac)) / 2;
}

export function triangleCentroid(triangle: Triangle): Vec3 {
  const [a, b, c] = triangle.points;
  return [
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  ];
}

export function pointTriangleDistanceSquared(
  point: Vec3,
  first: Vec3,
  second: Vec3,
  third: Vec3,
): number {
  const ab = subtract(second, first);
  const ac = subtract(third, first);
  const ap = subtract(point, first);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return squaredLength(ap);

  const bp = subtract(point, second);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return squaredLength(bp);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return squaredLength(
      subtract(point, add(first, scale(ab, d1 / (d1 - d3)))),
    );
  }

  const cp = subtract(point, third);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return squaredLength(cp);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return squaredLength(
      subtract(point, add(first, scale(ac, d2 / (d2 - d6)))),
    );
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = subtract(third, second);
    return squaredLength(
      subtract(
        point,
        add(second, scale(edge, (d4 - d3) / (d4 - d3 + d5 - d6))),
      ),
    );
  }

  const denominator = 1 / (va + vb + vc);
  return squaredLength(
    subtract(
      point,
      add(first, add(scale(ab, vb * denominator), scale(ac, vc * denominator))),
    ),
  );
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function scale(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function squaredLength(value: Vec3): number {
  return dot(value, value);
}
