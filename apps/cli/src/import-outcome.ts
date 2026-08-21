import {
  EXIT_INDETERMINATE,
  EXIT_USAGE_ERROR,
  type ExitCode,
} from "./exit-codes.js";
import type { LoadModelResult } from "./load-model.js";

/**
 * Maps an import failure code to its exit-code bucket.
 *
 * `resource-limit` is a fail-closed safety-ceiling refusal -- the same
 * bucket as an indeterminate analysis outcome, since nothing about the
 * geometry itself was proven one way or the other. Every other import
 * failure (`invalid-input`, `unsupported-input`, `unsafe-archive`,
 * `needs-input`) reflects a problem with the command's input before any
 * geometry engine ran, so it is a usage error.
 */
export function importFailureExitCode(code: string): ExitCode {
  return code === "resource-limit" ? EXIT_INDETERMINATE : EXIT_USAGE_ERROR;
}

export function printImportFailure(
  failure: Extract<LoadModelResult, { ok: false }>,
  label: string,
  stderr: (line: string) => void,
): void {
  stderr(
    `${label} import failed: [${failure.result.code}] ${failure.result.message}`,
  );
  for (const warning of failure.result.warnings) {
    stderr(
      `  warning [${warning.severity}] ${warning.code}: ${warning.message}`,
    );
  }
}
