import type {
  AnalysisOutcome,
  ContractWarning,
  Finding,
  Report,
  SavedView,
} from "@voxelspy/contracts";

import { formatNumber } from "./text.js";

type CompleteOutcome = Extract<AnalysisOutcome, { state: "complete" }>;
type ChangeRegion = CompleteOutcome["regions"][number];
type AnalysisMetricEntry = CompleteOutcome["metrics"][number];

/**
 * Renders a validated `Report` document to one self-contained HTML string:
 * inline CSS only, no external assets/fonts/scripts, legible in both light
 * and dark via `prefers-color-scheme`, semantic headings and tables, and
 * every value HTML-escaped (models and filenames are user-controlled
 * text). This function transcribes exactly what `report` contains -- it
 * never recomputes geometry or reads back into models -- and is
 * deterministic: equal documents render to byte-identical strings.
 */
export function renderReportHtml(report: Report): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(report.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    renderBody(report),
    "</body>",
    "</html>",
  ].join("\n");
}

function renderBody(report: Report): string {
  return [
    renderHeader(report),
    renderModels(report),
    renderPlacement(report),
    renderAnalysis(report.analysis.result.outcome),
    renderResultWarnings(report.analysis.result.warnings),
    renderFindings(report.findings),
    renderSavedViews(report.savedViews),
    renderFigures(report),
    renderReview(report),
  ].join("\n");
}

function renderHeader(report: Report): string {
  return `<header>
  <h1>${escapeHtml(report.title)}</h1>
  <dl class="meta">
    <div><dt>Report ID</dt><dd><code>${escapeHtml(report.id)}</code></dd></div>
    <div><dt>Created</dt><dd><time datetime="${escapeAttr(report.createdAt)}">${escapeHtml(report.createdAt)}</time></dd></div>
    <div><dt>Generator</dt><dd>${escapeHtml(report.generator.id)} v${escapeHtml(report.generator.version)}</dd></div>
  </dl>
</header>`;
}

function renderModels(report: Report): string {
  const rows = report.models
    .map(
      (model) => `<tr>
        <td>${escapeHtml(model.role)}</td>
        <td>${escapeHtml(model.displayName)}</td>
        <td>${escapeHtml(model.sourceName)}</td>
        <td><code>${escapeHtml(model.sourceMediaType)}</code></td>
        <td><code>${escapeHtml(model.sourcePath)}</code></td>
        <td><code class="digest">${escapeHtml(model.sourceDigest.value)}</code></td>
        <td>${escapeHtml(model.normalizationProvenance.sourceUnit)}, ${escapeHtml(model.normalizationProvenance.sourceAxis)}</td>
      </tr>`,
    )
    .join("\n");
  return `<section aria-labelledby="models-heading">
  <h2 id="models-heading">Models</h2>
  <table>
    <thead><tr><th scope="col">Role</th><th scope="col">Name</th><th scope="col">Source</th><th scope="col">Media type</th><th scope="col">Path</th><th scope="col">SHA-256</th><th scope="col">Source frame</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

const IDENTITY_PLACEMENT = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
] as const;

function isIdentityPlacement(transform: readonly number[]): boolean {
  return IDENTITY_PLACEMENT.every((value, index) => transform[index] === value);
}

function renderTransformRows(transform: readonly number[]): string {
  const rows = [0, 1, 2, 3]
    .map((row) => {
      const cells = [0, 1, 2, 3]
        .map((column) => {
          const value = transform[column * 4 + row] ?? 0;
          return `<td>${escapeHtml(String(Object.is(value, -0) ? 0 : value))}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  return `<table class="transform"><tbody>${rows}</tbody></table>`;
}

/**
 * A comparison whose models were placed by anything other than the identity
 * describes aligned geometry, and a reader of the report must be able to see
 * that without inspecting the underlying data.
 */
function renderPlacement(report: Report): string {
  const bindings = [
    { role: "baseline", binding: report.analysis.result.baseline },
    { role: "candidate", binding: report.analysis.result.candidate },
  ] as const;
  const placed = bindings.filter(
    ({ binding }) => !isIdentityPlacement(binding.modelToComparison),
  );
  const note =
    placed.length === 0
      ? "<p>Both models were compared where their imported geometry already sat, with no placement applied.</p>"
      : `<p class="placement-applied">This comparison describes <strong>placed geometry</strong>: ${placed
          .map(({ role }) => escapeHtml(role))
          .join(
            " and ",
          )} was positioned into the comparison frame by the transform below. Measurements describe the models as placed.</p>`;
  const tables = bindings
    .map(
      ({ role, binding }) => `<div>
      <h3>${escapeHtml(role)}${isIdentityPlacement(binding.modelToComparison) ? " (unplaced)" : ""}</h3>
      ${renderTransformRows(binding.modelToComparison)}
    </div>`,
    )
    .join("\n");
  return `<section aria-labelledby="placement-heading">
  <h2 id="placement-heading">Placement</h2>
  ${note}
  <div class="placement-grid">${tables}</div>
</section>`;
}

function renderAnalysis(
  outcome: Report["analysis"]["result"]["outcome"],
): string {
  if (outcome.state === "indeterminate") {
    return `<section aria-labelledby="analysis-heading">
  <h2 id="analysis-heading">Analysis</h2>
  <p class="badge badge-indeterminate">Indeterminate: <code>${escapeHtml(outcome.code)}</code></p>
  <ul>${outcome.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
  <p>Requested method: ${escapeHtml(outcome.requestedMethod.id)} v${escapeHtml(outcome.requestedMethod.version)}</p>
</section>`;
  }
  return `<section aria-labelledby="analysis-heading">
  <h2 id="analysis-heading">Analysis</h2>
  <dl class="meta">
    <div><dt>Semantics</dt><dd>${escapeHtml(outcome.semantics)}</dd></div>
    <div><dt>Requested method</dt><dd>${escapeHtml(outcome.requestedMethod.id)} v${escapeHtml(outcome.requestedMethod.version)}</dd></div>
    <div><dt>Effective method</dt><dd>${escapeHtml(outcome.effectiveMethod.id)} v${escapeHtml(outcome.effectiveMethod.version)}</dd></div>
    <div><dt>Requested tolerance</dt><dd><pre>${escapeHtml(JSON.stringify(outcome.requestedTolerance))}</pre></dd></div>
    <div><dt>Effective tolerance</dt><dd><pre>${escapeHtml(JSON.stringify(outcome.effectiveTolerance))}</pre></dd></div>
  </dl>
  ${renderAdjustments(outcome.adjustments)}
  ${renderSemanticsDetail(outcome)}
  ${renderValidation(outcome.validation)}
  ${renderWarningsList("Region warnings", flattenRegionWarnings(outcome.regions))}
  ${renderMetrics(outcome.metrics)}
  ${renderRegions(outcome.regions)}
</section>`;
}

function renderSemanticsDetail(outcome: CompleteOutcome): string {
  if (outcome.semantics === "approximate") {
    return `<div class="callout">
    <h3>Uncertainty</h3>
    <p>${escapeHtml(outcome.uncertainty.description)}</p>
    <pre>${escapeHtml(JSON.stringify(outcome.uncertainty.parameters, null, 2))}</pre>
  </div>`;
  }
  return `<div class="callout">
    <h3>Validated domain</h3>
    <p><code>${escapeHtml(outcome.validatedDomain.id)}</code>: ${escapeHtml(outcome.validatedDomain.description)}</p>
    <p>Preconditions: ${outcome.validatedDomain.preconditionIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</p>
  </div>`;
}

function renderAdjustments(
  adjustments: CompleteOutcome["adjustments"],
): string {
  if (adjustments.length === 0) return "";
  const items = adjustments
    .map(
      (adjustment) =>
        `<li><strong>${escapeHtml(adjustment.field)}</strong>: ${escapeHtml(adjustment.reason)}</li>`,
    )
    .join("");
  return `<div class="callout callout-warning"><h3>Adjustments</h3><ul>${items}</ul></div>`;
}

function renderValidation(validation: CompleteOutcome["validation"]): string {
  const rows = validation
    .map(
      (assessment) => `<tr>
        <td><code>${escapeHtml(assessment.modelId)}</code></td>
        <td>${assessment.closed ? "yes" : "no"}</td>
        <td>${assessment.consistentlyOriented ? "yes" : "no"}</td>
        <td>${assessment.boundaryEdgeCount}</td>
        <td>${assessment.nonManifoldEdgeCount}</td>
        <td>${assessment.degenerateTriangleCount}</td>
      </tr>`,
    )
    .join("\n");
  return `<h3>Mesh validation</h3>
  <table>
    <thead><tr><th scope="col">Model</th><th scope="col">Closed</th><th scope="col">Consistently oriented</th><th scope="col">Boundary edges</th><th scope="col">Non-manifold edges</th><th scope="col">Degenerate triangles</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderMetrics(metrics: readonly AnalysisMetricEntry[]): string {
  if (metrics.length === 0) return "";
  const rows = metrics
    .map(
      (metric) =>
        `<tr><td><code>${escapeHtml(metric.id)}</code></td><td>${formatNumber(metric.value, 6)}</td><td>${escapeHtml(metric.unit)}</td></tr>`,
    )
    .join("\n");
  return `<h3>Metrics</h3>
  <table>
    <thead><tr><th scope="col">ID</th><th scope="col">Value</th><th scope="col">Unit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderRegions(regions: readonly ChangeRegion[]): string {
  if (regions.length === 0)
    return "<h3>Regions</h3><p>No changed regions were reported.</p>";
  const rows = regions
    .map(
      (region) => `<tr>
        <td><code>${escapeHtml(region.id)}</code></td>
        <td>${escapeHtml(region.category)}</td>
        <td>${formatBounds(region.bounds)}</td>
        <td>${formatPoint(region.anchor)}</td>
        <td>${region.metricIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</td>
      </tr>`,
    )
    .join("\n");
  return `<h3>Regions</h3>
  <table>
    <thead><tr><th scope="col">ID</th><th scope="col">Category</th><th scope="col">Bounds (mm)</th><th scope="col">Anchor (mm)</th><th scope="col">Metrics</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function flattenRegionWarnings(
  regions: readonly ChangeRegion[],
): readonly string[] {
  const codes = new Set<string>();
  for (const region of regions) {
    for (const code of region.warningCodes) codes.add(String(code));
  }
  return [...codes];
}

function renderWarningsList(title: string, codes: readonly string[]): string {
  if (codes.length === 0) return "";
  return `<h3>${escapeHtml(title)}</h3><ul>${codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join("")}</ul>`;
}

function renderResultWarnings(warnings: readonly ContractWarning[]): string {
  if (warnings.length === 0) return "";
  const items = warnings
    .map(
      (warning) =>
        `<li class="badge-${escapeAttr(warning.severity)}"><code>${escapeHtml(warning.code)}</code>: ${escapeHtml(warning.message)}</li>`,
    )
    .join("");
  return `<section aria-labelledby="warnings-heading">
  <h2 id="warnings-heading">Warnings</h2>
  <ul>${items}</ul>
</section>`;
}

function renderFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return `<section aria-labelledby="findings-heading">
  <h2 id="findings-heading">Findings</h2>
  <p>No findings are recorded.</p>
</section>`;
  }
  const items = findings
    .map(
      (
        finding,
      ) => `<article class="finding" aria-labelledby="${escapeAttr(finding.id)}-title">
    <h3 id="${escapeAttr(finding.id)}-title">${escapeHtml(finding.title)}</h3>
    <p class="badges"><span class="badge badge-${escapeAttr(finding.severity)}">${escapeHtml(finding.severity)}</span> <span class="badge">${escapeHtml(finding.status)}</span></p>
    <p>${escapeHtml(finding.summary)}</p>
    <dl class="meta">
      <div><dt>Source</dt><dd>${renderFindingSource(finding.source)}</dd></div>
      <div><dt>Regions</dt><dd>${finding.regionIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "&mdash;"}</dd></div>
      <div><dt>Metrics</dt><dd>${finding.metricIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "&mdash;"}</dd></div>
      <div><dt>Saved views</dt><dd>${finding.savedViewIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ") || "&mdash;"}</dd></div>
    </dl>
  </article>`,
    )
    .join("\n");
  return `<section aria-labelledby="findings-heading">
  <h2 id="findings-heading">Findings</h2>
  ${items}
</section>`;
}

function renderFindingSource(source: Finding["source"]): string {
  if (source.kind === "manual") return "Manual";
  return `Automatic &mdash; ${escapeHtml(source.detector.id)} v${escapeHtml(source.detector.version)} <pre>${escapeHtml(JSON.stringify(source.detector.parameters, null, 2))}</pre>`;
}

function renderSavedViews(views: readonly SavedView[]): string {
  const rows = views
    .map(
      (view) => `<tr>
        <td><code>${escapeHtml(view.id)}</code></td>
        <td>${escapeHtml(view.name)}</td>
        <td>${escapeHtml(view.displayMode)}</td>
        <td>${escapeHtml(view.camera.projection.kind)}</td>
        <td>${view.visibility.map((entry) => `<code>${escapeHtml(entry.modelId)}</code>:${entry.visible ? "on" : "off"}`).join(", ")}</td>
      </tr>`,
    )
    .join("\n");
  return `<section aria-labelledby="views-heading">
  <h2 id="views-heading">Saved views</h2>
  <table>
    <thead><tr><th scope="col">ID</th><th scope="col">Name</th><th scope="col">Display mode</th><th scope="col">Projection</th><th scope="col">Visibility</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderFigures(report: Report): string {
  if (report.figures.length === 0) return "";
  const items = report.figures
    .map(
      (figure) => `<figure aria-labelledby="${escapeAttr(figure.id)}-caption">
    <p>${figure.widthPixels}&times;${figure.heightPixels}px, ${figure.primitives.length} primitive(s), saved view <code>${escapeHtml(figure.savedViewId)}</code></p>
    <figcaption id="${escapeAttr(figure.id)}-caption">${escapeHtml(figure.title)}</figcaption>
  </figure>`,
    )
    .join("\n");
  return `<section aria-labelledby="figures-heading">
  <h2 id="figures-heading">Figures</h2>
  ${items}
</section>`;
}

function renderReview(report: Report): string {
  return `<section aria-labelledby="review-heading">
  <h2 id="review-heading">Review</h2>
  <p>Status: <span class="badge">${escapeHtml(report.review.status)}</span></p>
  <p>Active saved view: <code>${escapeHtml(report.review.activeSavedViewId)}</code></p>
  <h3>Notes</h3>
  <pre class="notes">${escapeHtml(report.review.notes)}</pre>
</section>`;
}

function formatPoint(point: readonly [number, number, number]): string {
  return `(${formatNumber(point[0])}, ${formatNumber(point[1])}, ${formatNumber(point[2])})`;
}

function formatBounds(bounds: {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}): string {
  return `${formatPoint(bounds.min)} &ndash; ${formatPoint(bounds.max)}`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for both HTML text-node and double-quoted-attribute contexts. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #14181f;
    --muted: #5b6472;
    --border: #d7dce3;
    --surface: #f4f6f8;
    --accent: #1f5fbf;
    --warning-bg: #fff3cd;
    --warning-fg: #6b4e00;
    --error-bg: #fde2e1;
    --error-fg: #7a1f1a;
    --info-bg: #e3f0ff;
    --info-fg: #1c3f66;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14181f;
      --fg: #eef1f5;
      --muted: #9aa4b2;
      --border: #333d4b;
      --surface: #1c222c;
      --accent: #7fb0ff;
      --warning-bg: #4a3a00;
      --warning-fg: #ffdf80;
      --error-bg: #4a1512;
      --error-fg: #ffb3ae;
      --info-bg: #10304d;
      --info-fg: #bfe0ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
    max-width: 960px;
    margin-inline: auto;
  }
  h1, h2, h3 { line-height: 1.25; }
  h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; margin-top: 2.5rem; }
  section { margin-top: 1.5rem; }
  code, pre {
    font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    background: var(--surface);
    border-radius: 0.25rem;
  }
  code { padding: 0.1rem 0.3rem; }
  pre { padding: 0.75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  dl.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.5rem 1.5rem; margin: 0.5rem 0; }
  dl.meta div { display: flex; flex-direction: column; }
  dt { color: var(--muted); font-size: 0.85em; }
  dd { margin: 0; }
  .callout { border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.75rem 1rem; margin: 1rem 0; background: var(--surface); }
  .callout-warning { border-color: var(--warning-fg); }
  .finding { border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; margin: 1rem 0; }
  .badges { margin: 0.25rem 0; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); font-size: 0.85em; }
  .badge-warning { background: var(--warning-bg); color: var(--warning-fg); border-color: transparent; }
  .badge-error { background: var(--error-bg); color: var(--error-fg); border-color: transparent; }
  .badge-info { background: var(--info-bg); color: var(--info-fg); border-color: transparent; }
  .badge-indeterminate { background: var(--error-bg); color: var(--error-fg); display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; }
  .notes { white-space: pre-wrap; }
  .digest { word-break: break-all; }
  .placement-grid { display: flex; flex-wrap: wrap; gap: 1rem; }
  .placement-grid > div { flex: 1 1 16rem; min-width: 0; }
  .placement-grid h3 { margin: 0.75rem 0 0; font-size: 0.95rem; text-transform: capitalize; }
  table.transform { width: auto; font-variant-numeric: tabular-nums; }
  table.transform td { text-align: right; padding: 0.15rem 0.5rem; }
  .placement-applied { border-left: 3px solid var(--accent); padding-left: 0.75rem; }
`;
