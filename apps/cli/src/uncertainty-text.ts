import type { CommandIO } from "./io.js";

interface WarningLike {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

interface UncertaintyLike {
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Prints the sample-spacing bound and undersampled state unconditionally --
 * on a passing policy result exactly as on a failing one. A `surface-distance`
 * or `clearance-fit-check` result is always approximate; a passing exit code
 * must never read as a stronger claim than the engine actually makes.
 */
export function printSampleSpacing(
  outcome: UncertaintyLike,
  io: Pick<CommandIO, "stdout">,
): void {
  const spacing = outcome.parameters["maxSampleSpacingMillimetres"];
  const undersampled = outcome.parameters["undersampled"];
  if (typeof spacing === "number") {
    io.stdout(
      `Sample spacing bound: ${spacing} mm (the farthest any surface point could be from its nearest sample; a result is approximate, not exact, even when it shows zero deviation).`,
    );
  }
  if (undersampled === true) {
    io.stdout(
      "UNDERSAMPLED: the sample spacing bound exceeds the requested tolerance/clearance -- a feature confined to a single coarse triangle's interior could have been missed entirely.",
    );
  }
}

export function printWarnings(
  warnings: readonly WarningLike[],
  io: Pick<CommandIO, "stdout">,
): void {
  if (warnings.length === 0) return;
  io.stdout("Warnings:");
  for (const warning of warnings) {
    io.stdout(`  [${warning.severity}] ${warning.code}: ${warning.message}`);
  }
}
