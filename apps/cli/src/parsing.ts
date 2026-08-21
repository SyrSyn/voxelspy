import {
  resolvedSourceAxisSchema,
  resolvedSourceUnitSchema,
  type SourceAxis,
  type SourceUnit,
} from "@voxelspy/contracts";
import { CliUsageError } from "./cli-error.js";

/**
 * `@voxelspy/contracts` exports `resolvedSourceUnitSchema`/`resolvedSourceAxisSchema`
 * (each `sourceUnitSchema`/`sourceAxisSchema` with `"unknown"` excluded) but no
 * corresponding named type, so it is derived here the same way
 * `@voxelspy/importers`'s own (package-internal) `ResolvedSourceUnit`/`ResolvedSourceAxis`
 * types are.
 */
export type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
export type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;

const UNIT_VALUES = resolvedSourceUnitSchema.options.join(", ");
const AXIS_VALUES = resolvedSourceAxisSchema.options.join(", ");

export function parseUnitOption(
  flagName: string,
  value: string | undefined,
): ResolvedSourceUnit | undefined {
  if (value === undefined) return undefined;
  const parsed = resolvedSourceUnitSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliUsageError(
      `${flagName} must be one of: ${UNIT_VALUES} (received "${value}").`,
    );
  }
  return parsed.data;
}

export function parseAxisOption(
  flagName: string,
  value: string | undefined,
): ResolvedSourceAxis | undefined {
  if (value === undefined) return undefined;
  const parsed = resolvedSourceAxisSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliUsageError(
      `${flagName} must be one of: ${AXIS_VALUES} (received "${value}").`,
    );
  }
  return parsed.data;
}

/** Parses a required, finite, non-negative millimetre-valued option. */
export function parseRequiredMillimetres(
  flagName: string,
  value: string | undefined,
): number {
  if (value === undefined) {
    throw new CliUsageError(`${flagName} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliUsageError(
      `${flagName} must be a finite, non-negative number of millimetres (received "${value}").`,
    );
  }
  return parsed;
}

/** Parses an optional finite, non-negative millimetre-valued option. */
export function parseOptionalMillimetres(
  flagName: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  return parseRequiredMillimetres(flagName, value);
}

/** Parses an optional positive-safe-integer-valued option. */
export function parseOptionalPositiveInteger(
  flagName: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(
      `${flagName} must be a positive integer (received "${value}").`,
    );
  }
  return parsed;
}

/** Parses an optional non-negative-safe-integer-valued option (zero allowed). */
export function parseOptionalNonNegativeInteger(
  flagName: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliUsageError(
      `${flagName} must be a non-negative integer (received "${value}").`,
    );
  }
  return parsed;
}
