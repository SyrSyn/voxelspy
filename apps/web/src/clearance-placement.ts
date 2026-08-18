import type { Mat4, Vec3 } from "@voxelspy/contracts";

/**
 * One part's deliberate placement into the shared comparison frame:
 * millimetre translation plus degree rotation about each axis. Never
 * inferred, auto-aligned, or auto-positioned -- `/tools/clearance-fit/`
 * always starts both parts at `IDENTITY_PLACEMENT` and only ever changes a
 * part's placement in response to an explicit numeric input, matching
 * `checkClearance`'s own contract that each part's `modelToComparison` is
 * honoured exactly, never adjusted by the engine.
 */
export interface PartPlacement {
  readonly translationMillimetres: Vec3;
  readonly rotationDegrees: Vec3;
}

export const IDENTITY_PLACEMENT: PartPlacement = {
  translationMillimetres: [0, 0, 0],
  rotationDegrees: [0, 0, 0],
};

export function isIdentityPlacement(placement: PartPlacement): boolean {
  return (
    placement.translationMillimetres.every((value) => value === 0) &&
    placement.rotationDegrees.every((value) => value === 0)
  );
}

/**
 * Builds the column-major 4x4 rigid transform (`@voxelspy/contracts`'
 * `affineTransformSchema` layout: columns 0-2 are the rotated X/Y/Z axes,
 * column 3 is the translation) for one part's placement, from an explicit
 * translation (millimetres) and Euler rotation (degrees).
 *
 * Rotation is applied intrinsically about the part's own X axis, then Y,
 * then Z -- composed as `R = Rz * Ry * Rx`, so a point `p` in the part's own
 * local frame maps to `R * p + t` in the shared comparison frame. This is
 * the only geometric operation this function performs: no scale, shear, or
 * reflection is ever introduced, so a zero rotation and zero translation
 * compose to the exact identity matrix, and any other input composes to a
 * proper rigid transform (orthonormal rotation, determinant 1) well within
 * `rigidTransformSchema`'s validation tolerance.
 */
export function buildPlacementMatrix(placement: PartPlacement): Mat4 {
  const [tx, ty, tz] = placement.translationMillimetres;
  const [rxDeg, ryDeg, rzDeg] = placement.rotationDegrees;
  const rx = (rxDeg * Math.PI) / 180;
  const ry = (ryDeg * Math.PI) / 180;
  const rz = (rzDeg * Math.PI) / 180;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  // R = Rz * Ry * Rx, expanded (row, column). `+ 0` normalizes any negative
  // zero a trig identity can produce (e.g. `-Math.sin(0) === -0`) back to
  // ordinary zero, so the identity placement produces the exact, plainly
  // displayed identity matrix rather than one sprinkled with "-0" entries.
  const r00 = cz * cy + 0;
  const r01 = cz * sy * sx - sz * cx + 0;
  const r02 = cz * sy * cx + sz * sx + 0;
  const r10 = sz * cy + 0;
  const r11 = sz * sy * sx + cz * cx + 0;
  const r12 = sz * sy * cx - cz * sx + 0;
  const r20 = -sy + 0;
  const r21 = cy * sx + 0;
  const r22 = cy * cx + 0;

  const matrix: Mat4 = [
    r00,
    r10,
    r20,
    0,
    r01,
    r11,
    r21,
    0,
    r02,
    r12,
    r22,
    0,
    tx + 0,
    ty + 0,
    tz + 0,
    1,
  ];
  return matrix;
}
