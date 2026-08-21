/**
 * Stable process exit codes for every `voxelspy` command.
 *
 * These four codes are the entire contract a CI pipeline should depend on.
 * They are deliberately coarse and deliberately never overloaded: a given
 * run exits with exactly one of them, chosen in this fixed priority order
 * (usage errors are caught before any engine runs; indeterminate beats
 * policy evaluation because a policy cannot be honestly evaluated against a
 * result the engine could not produce).
 *
 * - `EXIT_OK` (0): the requested comparison/inspection/check completed and
 *   every policy option the caller specified was satisfied. If the caller
 *   specified no policy options at all, a completed run always exits here
 *   -- there was nothing to gate on, so the run is informational only.
 * - `EXIT_POLICY_FAILED` (1): the engine produced a real, complete result,
 *   and at least one caller-specified policy option was violated (for
 *   example `--max-deviation` was exceeded). This also covers an
 *   indeterminate result when `--fail-on-indeterminate` was passed: that
 *   flag deliberately promotes "could not tell" to a hard gate failure for
 *   pipelines that want no exceptions.
 * - `EXIT_INDETERMINATE` (2): the engine could not produce a decidable
 *   result and no policy was overridden to treat that as failure --
 *   `state: "indeterminate"` from `analyzeModelPair`/`checkClearance`, an
 *   engine resource-limit ceiling (`InspectionResourceLimitError`,
 *   `WorkBudgetExceeded`), or an import rejected under `code: "resource-limit"`.
 *   This is fail-closed, not a pass: nothing was proven, so nothing should
 *   read as a proof either way. Never conflated with `EXIT_OK`.
 * - `EXIT_USAGE_ERROR` (3): the command line, an option value, or an input
 *   file was invalid before any geometry engine could meaningfully run --
 *   missing/unreadable files, unsupported formats, bad option values, or an
 *   import rejected under `code: "invalid-input" | "unsupported-input" |
 *   "unsafe-archive" | "needs-input"`.
 */
export const EXIT_OK = 0;
export const EXIT_POLICY_FAILED = 1;
export const EXIT_INDETERMINATE = 2;
export const EXIT_USAGE_ERROR = 3;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_POLICY_FAILED
  | typeof EXIT_INDETERMINATE
  | typeof EXIT_USAGE_ERROR;
