export function SamplePreview({ status }: { status?: string }) {
  return (
    <section
      className="workbench workbench-sample sample-preview"
      aria-labelledby="sample-preview-title"
    >
      <header className="workbench-header">
        <div>
          <span className="eyebrow">Instant - Local - Open Source</span>
          <h1 id="sample-preview-title">A 3D Toolkit, Free Forever.</h1>
        </div>
      </header>
      <div className="workbench-toolbar" role="status" aria-live="polite">
        <span>{status ?? "Preparing the interactive comparison…"}</span>
        <span>Baseline and candidate stay in this browser.</span>
      </div>
      <div className="viewport-grid sample-preview-grid" aria-hidden="true">
        {(["difference", "baseline", "candidate"] as const).map((kind) => (
          <section className={`viewport viewport-${kind}`} key={kind}>
            <header>
              <span>
                {kind === "difference"
                  ? "Analysis"
                  : kind === "baseline"
                    ? "Reference"
                    : "Revision"}
              </span>
              <h2>{kind[0]!.toLocaleUpperCase("en-US") + kind.slice(1)}</h2>
            </header>
            <div className="viewport-canvas sample-preview-canvas">
              <span />
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
