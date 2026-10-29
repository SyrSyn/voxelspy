import { useState } from "react";
import {
  evidenceReportFileName,
  serializeEvidenceReport,
  type EvidenceReportInput,
} from "./evidence-report";

export function EvidenceReportDownload({
  report,
  disabledReason,
}: {
  report: () => EvidenceReportInput;
  disabledReason?: string | undefined;
}) {
  const [error, setError] = useState<string>();
  return (
    <section aria-label="Download local evidence report">
      <button
        className="button button-secondary"
        type="button"
        disabled={Boolean(disabledReason)}
        onClick={() => {
          setError(undefined);
          try {
            const input = report();
            const bytes = serializeEvidenceReport(input);
            const blob = new Blob([new Uint8Array(bytes)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = evidenceReportFileName(
              input.source.name,
              input.kind,
            );
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Report could not be downloaded.",
            );
          }
        }}
      >
        Download evidence JSON
      </button>
      <p>
        Downloads a version 1 report locally, without a network step. It
        includes source names, digests, interpretation, findings and measured
        positions, but no original model files or mesh buffers. Sharing this
        file shares that evidence.
      </p>
      {disabledReason && <p role="status">{disabledReason}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
