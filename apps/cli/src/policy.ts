/** One named pass/fail check contributed by a `--fail-on-*`/`--require-*`/`--max-*` policy option the caller actually specified. */
export interface PolicyCheck {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface PolicyEvaluation {
  readonly checks: readonly PolicyCheck[];
  /** Vacuously `true` when the caller specified no policy options -- an unconfigured run is informational, not a gate. */
  readonly passed: boolean;
}

export function evaluatePolicy(checks: readonly PolicyCheck[]): PolicyEvaluation {
  return { checks, passed: checks.every((check) => check.passed) };
}
