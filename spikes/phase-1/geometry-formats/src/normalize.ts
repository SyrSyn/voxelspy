import type {
  ImportWarning,
  MeshGeometry,
  SourceAxis,
  SourceUnit,
} from "./contracts.ts";

const UNIT_SCALE_MM: Readonly<Record<SourceUnit, number>> = {
  micrometre: 0.001,
  millimetre: 1,
  centimetre: 10,
  metre: 1000,
  inch: 25.4,
  foot: 304.8,
};

export const IDENTITY_4X4 = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

// A +90 degree rotation around X maps right-handed Y-up to right-handed Z-up.
export const Y_UP_TO_Z_UP = Object.freeze([
  1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1,
]);

export function unitScaleToMillimetres(unit: SourceUnit): number {
  return UNIT_SCALE_MM[unit];
}

export function axisTransform(axis: SourceAxis): readonly number[] {
  return axis === "right-handed-y-up" ? Y_UP_TO_Z_UP : IDENTITY_4X4;
}

export function normalizeMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  sourceUnit: SourceUnit,
  sourceAxis: SourceAxis,
): { mesh: MeshGeometry; warnings: ImportWarning[] } {
  if (positions.length % 3 !== 0) {
    throw new Error("Position data must contain complete XYZ triples");
  }
  if (indices.length % 3 !== 0) {
    throw new Error("Index data must contain complete triangles");
  }

  const scale = unitScaleToMillimetres(sourceUnit);
  const normalized = new Float64Array(positions.length);
  const warnings: ImportWarning[] = [];

  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (
      x === undefined ||
      y === undefined ||
      z === undefined ||
      !Number.isFinite(x + y + z)
    ) {
      warnings.push({
        code: "non-finite-coordinate",
        message: `Vertex ${index / 3} was not finite`,
      });
      throw new Error("Geometry contains a non-finite coordinate");
    }
    normalized[index] = x * scale;
    if (sourceAxis === "right-handed-y-up") {
      normalized[index + 1] = -z * scale;
      normalized[index + 2] = y * scale;
    } else {
      normalized[index + 1] = y * scale;
      normalized[index + 2] = z * scale;
    }
  }

  const normalizedIndices = Uint32Array.from(indices);
  const vertexCount = normalized.length / 3;
  for (const index of normalizedIndices) {
    if (index >= vertexCount) {
      throw new Error(
        `Triangle index ${index} exceeds vertex count ${vertexCount}`,
      );
    }
  }

  for (let index = 0; index < normalizedIndices.length; index += 3) {
    const a = normalizedIndices[index];
    const b = normalizedIndices[index + 1];
    const c = normalizedIndices[index + 2];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (triangleAreaSquared(normalized, a, b, c) === 0) {
      warnings.push({
        code: "degenerate-triangle",
        message: `Triangle ${index / 3} has zero area`,
      });
    }
  }

  return {
    mesh: { positions: normalized, indices: normalizedIndices },
    warnings,
  };
}

export function multiplyMatrices(
  a: readonly number[],
  b: readonly number[],
): number[] {
  if (a.length !== 16 || b.length !== 16)
    throw new Error("Transforms must be 4x4 matrices");
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        value += (a[inner * 4 + row] ?? 0) * (b[column * 4 + inner] ?? 0);
      }
      out[column * 4 + row] = value;
    }
  }
  return out;
}

export function transformPoint(
  matrix: readonly number[],
  point: readonly number[],
): [number, number, number] {
  const [x = 0, y = 0, z = 0] = point;
  return [
    (matrix[0] ?? 0) * x +
      (matrix[4] ?? 0) * y +
      (matrix[8] ?? 0) * z +
      (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x +
      (matrix[5] ?? 0) * y +
      (matrix[9] ?? 0) * z +
      (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x +
      (matrix[6] ?? 0) * y +
      (matrix[10] ?? 0) * z +
      (matrix[14] ?? 0),
  ];
}

function triangleAreaSquared(
  positions: Float64Array,
  a: number,
  b: number,
  c: number,
): number {
  const ax = positions[a * 3] ?? 0;
  const ay = positions[a * 3 + 1] ?? 0;
  const az = positions[a * 3 + 2] ?? 0;
  const ux = (positions[b * 3] ?? 0) - ax;
  const uy = (positions[b * 3 + 1] ?? 0) - ay;
  const uz = (positions[b * 3 + 2] ?? 0) - az;
  const vx = (positions[c * 3] ?? 0) - ax;
  const vy = (positions[c * 3 + 1] ?? 0) - ay;
  const vz = (positions[c * 3 + 2] ?? 0) - az;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return cx * cx + cy * cy + cz * cz;
}
