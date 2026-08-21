import type { AnalysisResult, ContractWarning } from "@voxelspy/contracts";

import type { EngineStatus } from "../status.js";

export interface ComparisonFindingsProps {
  readonly status: EngineStatus<AnalysisResult>;
  /** Prefixes every heading id this component generates, so more than one
   *  instance can render on the same page without colliding ids. */
  readonly idPrefix?: string;
}

function severityLabel(severity: ContractWarning["severity"]): string {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}

function WarningList({
  warnings,
}: {
  readonly warnings: readonly ContractWarning[];
}) {
  if (warnings.length === 0) return null;
  return (
    <ul className="voxelspy-warning-list">
      {warnings.map((warning, index) => (
        <li key={index} className={`voxelspy-severity-${warning.severity}`}>
          <strong>{severityLabel(warning.severity)}:</strong> {warning.message}
        </li>
      ))}
    </ul>
  );
}

function semanticsLabel(outcome: AnalysisResult["outcome"]): string {
  if (outcome.state === "indeterminate") return "Indeterminate";
  if (outcome.semantics === "exact-within-validated-preconditions")
    return "Exact";
  return "Approximate";
}

/**
 * Renders one `AnalysisResult` (`analyzeModelPair` from `@voxelspy/analysis`)
 * honestly. `outcome.state === "indeterminate"` is never presented as a
 * pass, a failure, or any variant of "done, no findings" -- it renders its
 * own heading, `code`, and `reasons` exactly as reported, with the same
 * `role="alert"` treatment `"failed"` gets below, because "no method could
 * produce a validated answer" is exactly as actionable as an error, not a
 * quiet non-event. A `"complete"` outcome always states its own semantics
 * label (`"Exact"` only for `exact-within-validated-preconditions`,
 * `"Approximate"` otherwise) in text, plus the uncertainty description an
 * approximate result carries -- never a bare "done" with the precision
 * implied.
 *
 * Renders the full `status` lifecycle exactly like `InspectionFindings`;
 * see that component's doc comment for the shared `idle`/`running`/`failed`
 * treatment.
 */
export function ComparisonFindings({
  status,
  idPrefix = "voxelspy-comparison",
}: ComparisonFindingsProps) {
  if (status.status === "idle") {
    return <p className="voxelspy-findings-idle">No comparison has run yet.</p>;
  }
  if (status.status === "running") {
    return (
      <p role="status" aria-live="polite" className="voxelspy-findings-running">
        Comparing models…
      </p>
    );
  }
  if (status.status === "failed") {
    const { reason } = status;
    return (
      <div role="alert" className="voxelspy-findings-failed">
        <strong>
          {reason.kind === "cancelled"
            ? "Comparison cancelled"
            : "Comparison failed"}
        </strong>
        {reason.kind === "error" && <p>{reason.error.message}</p>}
      </div>
    );
  }

  const { outcome, warnings } = status.result;

  if (outcome.state === "indeterminate") {
    return (
      <section
        role="alert"
        aria-labelledby={`${idPrefix}-heading`}
        className="voxelspy-findings voxelspy-findings-indeterminate"
      >
        <h3 id={`${idPrefix}-heading`}>Comparison indeterminate</h3>
        <p>
          No method could produce a validated answer for this comparison (
          <code>{outcome.code}</code>). This is not a pass, a failure, or a "no
          differences found" result — it means the requested method could not be
          applied to this input.
        </p>
        <ul>
          {outcome.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
        {warnings.length > 0 && <WarningList warnings={warnings} />}
      </section>
    );
  }

  return (
    <section
      aria-labelledby={`${idPrefix}-heading`}
      className="voxelspy-findings"
    >
      <h3 id={`${idPrefix}-heading`}>Comparison findings</h3>
      <dl>
        <div>
          <dt>Semantics</dt>
          <dd>
            <strong>{semanticsLabel(outcome)}</strong>
            {outcome.semantics === "approximate" && (
              <span> — {outcome.uncertainty.description}</span>
            )}
            {outcome.semantics === "exact-within-validated-preconditions" && (
              <span> — {outcome.validatedDomain.description}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>
            {outcome.effectiveMethod.id} {outcome.effectiveMethod.version}
          </dd>
        </div>
        <div>
          <dt>Metrics</dt>
          <dd>{outcome.metrics.length}</dd>
        </div>
        <div>
          <dt>Regions</dt>
          <dd>{outcome.regions.length}</dd>
        </div>
      </dl>
      {outcome.adjustments.length > 0 && (
        <>
          <h4 id={`${idPrefix}-adjustments-heading`}>Adjustments</h4>
          <ul aria-labelledby={`${idPrefix}-adjustments-heading`}>
            {outcome.adjustments.map((adjustment, index) => (
              <li key={index}>
                <strong>{adjustment.field}:</strong> {adjustment.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <h4 id={`${idPrefix}-warnings-heading`}>Warnings</h4>
          <WarningList warnings={warnings} />
        </>
      )}
    </section>
  );
}
