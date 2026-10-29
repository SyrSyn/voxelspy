import {
  IDENTITY_MAT4,
  rigidTransformSchema,
  type RigidTransform,
  type Vec3,
} from "@voxelspy/contracts";
import { CliUsageError } from "./cli-error.js";
export function parseFiniteNumber(flag: string, value: string): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number))
    throw new CliUsageError(`${flag} requires finite numbers.`);
  return number;
}
export function parseVector(flag: string, value: string | undefined): Vec3 {
  const numbers = value
    ?.split(",")
    .map((part) => parseFiniteNumber(flag, part));
  if (numbers?.length !== 3)
    throw new CliUsageError(
      `${flag} requires three comma-separated numbers x,y,z.`,
    );
  return numbers as Vec3;
}
export function parsePlacement(
  flag: string,
  value: string | undefined,
): RigidTransform {
  const parsed = rigidTransformSchema.safeParse(
    value === undefined
      ? IDENTITY_MAT4
      : value.split(",").map((part) => parseFiniteNumber(flag, part)),
  );
  if (!parsed.success)
    throw new CliUsageError(
      `${flag} requires 16 comma-separated column-major entries forming a proper rigid transform (no scale, shear or reflection); translation is in canonical millimetres.`,
    );
  return parsed.data;
}
