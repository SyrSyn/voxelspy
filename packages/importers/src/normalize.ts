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
