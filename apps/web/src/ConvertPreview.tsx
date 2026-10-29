import type { NormalizedModel } from "@voxelspy/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
  ConvertSession,
  ConvertSimplifyOutcome,
} from "./convert-worker-client";
import { MAX_CONVERT_PREVIEW_TRIANGLES } from "./convert-preview";

const ModelGeometryPreview = lazy(async () => {
  const module = await import("./MeshHealthViewer");
  return { default: module.ModelGeometryPreview };
});

/** Optional geometry is held in refs; UI state contains only request status. */
export function ConvertPreview({
  session,
  outcome,
  busy,
  onCancel,
}: {
  session: ConvertSession;
  outcome: ConvertSimplifyOutcome | undefined;
  busy: boolean;
  onCancel: () => void;
}) {
  const original = useRef<NormalizedModel | undefined>(undefined);
  const simplified = useRef<NormalizedModel | undefined>(undefined);
  const generation = useRef(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [error, setError] = useState<string>();
  useEffect(() => {
    generation.current += 1;
    original.current = undefined;
    simplified.current = undefined;
    setStatus("idle");
    setError(undefined);
    return () => {
      generation.current += 1;
    };
  }, [session, outcome]);
  const preview = async () => {
    const active = ++generation.current;
    setStatus("loading");
    setError(undefined);
    try {
      const source = await session.preview("original");
      const reduced = outcome ? await session.preview("simplified") : undefined;
      if (active !== generation.current) return;
      original.current = source;
      simplified.current = reduced;
      setStatus("ready");
    } catch (reason) {
      if (active !== generation.current) return;
      setStatus("idle");
      setError(
        reason instanceof Error ? reason.message : "Preview unavailable.",
      );
    }
  };
  return (
    <section
      className="comparison-card"
      aria-labelledby="conversion-preview-heading"
    >
      <div className="section-heading">
        <h2 id="conversion-preview-heading">Geometry preview</h2>
      </div>
      <p>
        View the original{outcome ? " and simplified result" : ""} in the same
        source frame. The visual preview does not establish geometric accuracy;
        use the measured deviation and sampling limits in the report. Rendering
        rebases the display only; source and exported coordinates are unchanged.
      </p>
      <p>
        Optional preview: up to{" "}
        {MAX_CONVERT_PREVIEW_TRIANGLES.toLocaleString("en-US")} placed
        triangles. Models and exports stay local. Drag to orbit and scroll or
        pinch to zoom; all numerical evidence remains available without WebGL.
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={busy || status === "loading"}
          onClick={() => void preview()}
        >
          Show geometry preview
        </button>
        {status === "loading" && (
          <button
            type="button"
            className="button button-secondary"
            onClick={onCancel}
          >
            Cancel preview and close model
          </button>
        )}
      </div>
      {status === "loading" && (
        <p role="status">Preparing local geometry preview</p>
      )}
      {error && <p role="alert">{error}</p>}
      {status === "ready" && original.current && (
        <Suspense fallback={<p role="status">Loading preview renderer</p>}>
          <h3>Original geometry</h3>
          <ModelGeometryPreview
            model={original.current}
            accessibleLabel="Original conversion geometry"
          />
          {simplified.current && (
            <>
              <h3>Simplified geometry</h3>
              <ModelGeometryPreview
                model={simplified.current}
                frameModel={original.current}
                accessibleLabel="Simplified conversion geometry"
              />
            </>
          )}
        </Suspense>
      )}
    </section>
  );
}
