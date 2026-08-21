import type { InspectionResult } from "@voxelspy/analysis";

import type { EngineStatus } from "../status.js";

export interface InspectionFindingsProps {
  readonly status: EngineStatus<InspectionResult>;
  /** Prefixes every heading id this component generates, so more than one
   *  instance can render on the same page without colliding ids. */
  readonly idPrefix?: string;
}

/**
 * Renders one `InspectionResult` (`inspectModel` from `@voxelspy/analysis`)
 * honestly: the watertightness verdict states its own name in text
 * (`"Closed"`/`"Not closed"`/`"Indeterminate"`), never colour alone, and
 * every topology finding shows its true count and whether its example list
 * was truncated. `InspectionResult` itself carries no import warnings (see
 * `@voxelspy/analysis`'s reference: it echoes only `frame`/`provenance`
 * from the source model) -- a consumer who also wants the source model's
 * own `warnings` should read them from the same `NormalizedModel` passed
 * into `useModelInspection`'s `run()` and render them alongside this
 * component, e.g. with `ComparisonFindings`'s `WarningList` pattern for
 * inspiration. Nothing here recomputes, repairs, or hides a result -- this
 * component is a thin, direct presentation of the `InspectionResult` a hook
 * such as `useModelInspection` produces.
 *
 * Renders the full `status` lifecycle, not just the `"complete"` case: a
 * `"running"` inspection is announced through a `role="status"` live
 * region, and a `"failed"` one (cancelled or genuinely failed) through
 * `role="alert"`, so an assistive-technology user is told about a status
 * change without needing to poll the page. See the package README's
 * "Accessibility: what is verified and what is not" section for exactly
 * what is (and is not) checked about this.
 */
export function InspectionFindings({
  status,
  idPrefix = "voxelspy-inspection",
}: InspectionFindingsProps) {
  if (status.status === "idle") {
    return <p className="voxelspy-findings-idle">No inspection has run yet.</p>;
  }
  if (status.status === "running") {
    return (
      <p role="status" aria-live="polite" className="voxelspy-findings-running">
        Inspecting model…
      </p>
    );
  }
  if (status.status === "failed") {
    const { reason } = status;
    return (
      <div role="alert" className="voxelspy-findings-failed">
        <strong>
          {reason.kind === "cancelled"
            ? "Inspection cancelled"
            : "Inspection failed"}
        </strong>
        {reason.kind === "error" && <p>{reason.error.message}</p>}
      </div>
    );
  }

  const { watertightness, topologyFindings, meshBreakdown } = status.result;
  const watertightLabel =
    watertightness.state === "closed"
      ? "Closed"
      : watertightness.state === "not-closed"
        ? "Not closed"
        : "Indeterminate";

  return (
    <section
      aria-labelledby={`${idPrefix}-heading`}
      className="voxelspy-findings"
    >
      <h3 id={`${idPrefix}-heading`}>Inspection findings</h3>
      <dl>
        <div>
          <dt>Watertightness</dt>
          <dd>
            <strong>{watertightLabel}</strong>
            {watertightness.state === "not-closed" && (
              <span> — {watertightness.reasons.join(", ")}</span>
            )}
          </dd>
        </div>
      </dl>
      <h4 id={`${idPrefix}-topology-heading`}>Topology findings</h4>
      {topologyFindings.length === 0 ? (
        <p>No topology issues found.</p>
      ) : (
        <ul aria-labelledby={`${idPrefix}-topology-heading`}>
          {topologyFindings.map((finding) => (
            <li key={finding.id}>
              <strong>{finding.kind}</strong> ({finding.severity}):{" "}
              {finding.summary}
              {finding.examplesTruncated && (
                <span>
                  {" "}
                  — showing {finding.examples.length} of {finding.count}.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <h4 id={`${idPrefix}-mesh-heading`}>Mesh breakdown</h4>
      <p>
        {meshBreakdown.meshes.length} of {meshBreakdown.totalMeshCount} mesh
        {meshBreakdown.totalMeshCount === 1 ? "" : "es"} shown
        {meshBreakdown.truncated ? " (truncated)" : ""}.
      </p>
    </section>
  );
}
