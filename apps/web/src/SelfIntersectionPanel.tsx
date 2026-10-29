import type { SelfIntersectionResult } from "@voxelspy/analysis";
import type { GeometryProvenance } from "@voxelspy/contracts";
import { useEffect, useRef, useState } from "react";
import {
  selfIntersectionsSourceAsync,
  InspectionCancelledError,
  type InspectSource,
} from "./inspect-worker-client";

/** Opt-in exact-predicate evidence, independent of the mesh's topology verdict. */
export function SelfIntersectionPanel({
  source,
  provenance,
}: {
  source: InspectSource;
  provenance: GeometryProvenance;
}) {
  const [result, setResult] = useState<SelfIntersectionResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const run = async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const evidence = await selfIntersectionsSourceAsync(
        source,
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(evidence);
    } catch (reason) {
      if (!(reason instanceof InspectionCancelledError))
        setError(
          reason instanceof Error ? reason.message : "Mesh check unavailable.",
        );
    } finally {
      if (active.current === controller) {
        setBusy(false);
        active.current = undefined;
      }
    }
  };
  const download = () => {
    if (!result) return;
    const report = {
      schemaVersion: 1,
      kind: "mesh-health",
      provenance,
      evidence: result,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2) + "\n"], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "voxelspy.mesh-health.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <section
      className="comparison-card"
      aria-labelledby="self-intersection-heading"
    >
      <h2 id="self-intersection-heading">Self-intersection evidence</h2>
      <p>
        This deliberate check uses exact predicates on the transformed Float64
        triangles within the reported numeric domain. It distinguishes overlaps
        and non-adjacent contacts from contact confined to a shared vertex or
        edge. It never repairs or welds the model and does not certify a valid
        solid.
      </p>
      <p>
        Up to 50,000 placed triangles and 100,000 candidate pairs by default; at
        most 100 pair examples are shown. Degenerate triangles, unsupported
        coordinates and exhausted limits return an indeterminate result.
      </p>
      <div className="actions">
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => void run()}
        >
          Check self-intersections
        </button>
        {busy && (
          <button
            className="button button-secondary"
            type="button"
            onClick={() => active.current?.abort()}
          >
            Cancel mesh check
          </button>
        )}
        {result && (
          <button
            className="button button-secondary"
            type="button"
            onClick={download}
          >
            Download mesh health evidence
          </button>
        )}
      </div>
      {busy && <p role="status">Checking triangle pairs locally</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <div aria-live="polite">
          <p>
            <strong>
              {result.state === "complete"
                ? `${result.pairCount} intersecting or contacting triangle pairs observed`
                : `Indeterminate: ${result.reason}; at least ${result.observedPairCount} pairs observed`}
            </strong>
          </p>
          <p>
            {result.testedPairCount} candidate pairs tested.{" "}
            {result.truncated
              ? "Pair examples are truncated; see the total or observed lower bound above."
              : "All observed pair examples are included."}
          </p>
          <p>
            Downloading includes source provenance and triangle coordinates of
            reported pairs, but not the original model file.
          </p>
          <ol>
            {result.pairs.map((pair, index) => (
              <li key={index}>
                <strong>{pair.kind}</strong>: {pair.first.instanceId} /{" "}
                {pair.first.meshId} triangle {pair.first.meshLocalTriangleIndex}{" "}
                and {pair.second.instanceId} / {pair.second.meshId} triangle{" "}
                {pair.second.meshLocalTriangleIndex}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
