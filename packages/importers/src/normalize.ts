import type { Mat4, SourceAxis, SourceUnit } from "@voxelspy/contracts";

export type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
export type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;

const UNIT_SCALE_MILLIMETRES: Readonly<Record<ResolvedSourceUnit, number>> = {
  micrometre: 0.001,
  millimetre: 1,
  centimetre: 10,
  metre: 1_000,
  inch: 25.4,
  foot: 304.8,
};

export function sourceToModelTransform(
  unit: ResolvedSourceUnit,
  axis: ResolvedSourceAxis,
): Mat4 {
  const scale = UNIT_SCALE_MILLIMETRES[unit];
  return axis === "right-handed-z-up"
    ? [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]
    : [scale, 0, 0, 0, 0, 0, scale, 0, 0, -scale, 0, 0, 0, 0, 0, 1];
}

/**
 * The exact inverse of `sourceToModelTransform(unit, axis)`: converts a
 * canonical-frame model position (millimetres, right-handed Z-up) to the
 * given output unit and axis convention, for `exportModel`
 * (`src/export.ts`). Composing `modelToTargetTransform(u, a)` with
 * `sourceToModelTransform(u, a)` (in either order) is the identity, for
 * every resolved `u`/`a` -- exercised directly in
 * `test/export.test.ts`. Like `sourceToModelTransform`, this is always a
 * uniform-scale, handedness-preserving, translation-free transform (it
 * satisfies `sourceNormalizationTransformSchema`), never a guess: the
 * caller (`ExportOptions.targetUnit`/`targetAxis`) always chooses the
 * output frame explicitly.
 */
export function modelToTargetTransform(
  unit: ResolvedSourceUnit,
  axis: ResolvedSourceAxis,
): Mat4 {
  const inverseScale = 1 / UNIT_SCALE_MILLIMETRES[unit];
  return axis === "right-handed-z-up"
    ? [
        inverseScale,
        0,
        0,
        0,
        0,
        inverseScale,
        0,
        0,
        0,
        0,
        inverseScale,
        0,
        0,
        0,
        0,
        1,
      ]
    : [
        inverseScale,
        0,
        0,
        0,
        0,
        0,
        -inverseScale,
        0,
        0,
        inverseScale,
        0,
        0,
        0,
        0,
        0,
        1,
      ];
}

/**
 * Column-major 4x4 matrix multiplication (`p' = (a . b) * p`, i.e. `b` is
 * applied first, then `a`), for composing an instance's placement transform
 * with `modelToTargetTransform`'s output-frame conversion in one pass over
 * `exportModel`'s geometry. Matches the column-major layout
 * `affineTransformSchema` (`@voxelspy/contracts`) documents: index `col*4 +
 * row`.
 */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row]! * b[col * 4 + k]!;
      }
      out[col * 4 + row] = sum;
    }
  }
  return out as unknown as Mat4;
}

/** Applies affine `matrix` (column-major, see `multiplyMat4`) to point `(x, y, z)`. */
export function applyMat4(
  matrix: Mat4,
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

export function normalizePositions(
  source: ArrayLike<number>,
  unit: ResolvedSourceUnit,
  axis: ResolvedSourceAxis,
): Float64Array {
  if (source.length % 3 !== 0) {
    throw new TypeError("Position data must contain complete xyz triples");
  }

  const scale = UNIT_SCALE_MILLIMETRES[unit];
  const positions = new Float64Array(source.length);
  for (let offset = 0; offset < source.length; offset += 3) {
    const x = source[offset];
    const y = source[offset + 1];
    const z = source[offset + 2];
    if (
      x === undefined ||
      y === undefined ||
      z === undefined ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z)
    ) {
      throw new TypeError("Geometry contains a non-finite coordinate");
    }
    positions[offset] = x * scale;
    if (axis === "right-handed-y-up") {
      positions[offset + 1] = -z * scale;
      positions[offset + 2] = y * scale;
    } else {
      positions[offset + 1] = y * scale;
      positions[offset + 2] = z * scale;
    }
  }
  return positions;
}

export function countDegenerateTriangles(
  positions: Float64Array,
  indices: Uint32Array,
): number {
  let count = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset];
    const b = indices[offset + 1];
    const c = indices[offset + 2];
    if (a === undefined || b === undefined || c === undefined) continue;
    const ax = positions[a * 3] ?? 0;
    const ay = positions[a * 3 + 1] ?? 0;
    const az = positions[a * 3 + 2] ?? 0;
    const ux = (positions[b * 3] ?? 0) - ax;
    const uy = (positions[b * 3 + 1] ?? 0) - ay;
    const uz = (positions[b * 3 + 2] ?? 0) - az;
    const vx = (positions[c * 3] ?? 0) - ax;
    const vy = (positions[c * 3 + 1] ?? 0) - ay;
    const vz = (positions[c * 3 + 2] ?? 0) - az;
    const crossX = uy * vz - uz * vy;
    const crossY = uz * vx - ux * vz;
    const crossZ = ux * vy - uy * vx;
    if (crossX === 0 && crossY === 0 && crossZ === 0) count += 1;
  }
  return count;
}
