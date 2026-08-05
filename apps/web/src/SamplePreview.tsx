export function SamplePreview({ status }: { status?: string }) {
  return (
    <section
      className="workbench workbench-sample sample-preview"
      aria-labelledby="sample-preview-title"
    >
      <header className="workbench-header">
        <div>
          <span className="eyebrow">
            Built-in sample · approximate surface analysis
          </span>
          <h1 id="sample-preview-title">A 3D Toolkit, Free Forever.</h1>
        </div>
        <div className="workbench-actions">
          <button className="button button-secondary" type="button" disabled>
            Reset camera
          </button>
          <a className="button button-primary" href="/compare/">
            Import Models
          </a>
        </div>
      </header>
      <div className="workbench-toolbar" role="status" aria-live="polite">
        <div className="toolbar-controls">
          <span>{status ?? "Preparing the interactive comparison…"}</span>
        </div>
        <span>Baseline and candidate stay in this browser.</span>
      </div>
      <div className="workbench-stage sample-preview-grid" aria-hidden="true">
        <section className="viewport viewport-difference">
          <header>
            <span>Analysis</span>
            <h2>Difference</h2>
          </header>
          <div className="viewport-canvas sample-preview-canvas">
            <span />
          </div>
        </section>
        <aside className="evidence-rail sample-preview-rail">
          <span className="eyebrow">Comparison summary</span>
          <h2>Analyzing sample</h2>
          <p>Finding added and removed regions…</p>
        </aside>
        <div className="source-views">
          {(["baseline", "candidate"] as const).map((kind) => (
            <section className={`viewport viewport-${kind}`} key={kind}>
              <header>
                <span>{kind === "baseline" ? "Reference" : "Revision"}</span>
                <h2>{kind[0]!.toLocaleUpperCase("en-US") + kind.slice(1)}</h2>
              </header>
              <div className="viewport-canvas sample-preview-canvas">
                <span />
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
