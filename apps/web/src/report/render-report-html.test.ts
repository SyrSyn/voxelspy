import {
  SURFACE_DISTANCE_METHOD,
  analyzeModelPair,
  summarizeModelComparison,
} from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  analysisRequestSchema,
  importRequestSchema,
  modelIdSchema,
  reportIdSchema,
  requestIdSchema,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";
import { describe, expect, it } from "vitest";

import { createBuiltInSamplePair } from "../sample-models.js";
import type { ComparisonSource } from "../worker-client.js";
import { buildComparisonReport } from "./build-report.js";
import { renderReportHtml } from "./render-report-html.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const REPORT_ID = reportIdSchema.parse("report.render-fixture");

async function importSample(
  role: "baseline" | "candidate",
  source: ComparisonSource,
  fileOverride?: File,
): Promise<NormalizedModel> {
  const file = fileOverride ?? source.file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await importModel(
    importRequestSchema.parse({
      contractVersion: 1,
      targetModelId: modelIdSchema.parse(`model.${role}`),
      format: "stl",
      sourceName: file.name,
      bytes,
      options: {
        declaredUnit: source.unit,
        declaredAxis: source.axis,
        limits: { inputBytes: bytes.byteLength, triangleCount: 500 },
      },
    }),
  );
  if (!result.ok) throw new Error(result.message);
  return result.model;
}

async function buildRealReport(options?: {
  readonly baselineFile?: File;
  readonly title?: string;
}) {
  const sample = createBuiltInSamplePair();
  const baseline = await importSample(
    "baseline",
    sample.baseline,
    options?.baselineFile,
  );
  const candidate = await importSample("candidate", sample.candidate);
  const request = analysisRequestSchema.parse({
    contractVersion: 1,
    requestId: requestIdSchema.parse("analysis.render-fixture"),
    baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
    candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
    method: SURFACE_DISTANCE_METHOD,
    tolerance: { distanceMillimetres: 0.1 },
    executionBudget: {
      maxWorkUnits: 2_000_000,
      maxMemoryBytes: 16 * 1024 * 1024,
    },
  });
  const analysis = analyzeModelPair({ request, baseline, candidate });
  const summary = summarizeModelComparison(baseline, candidate, analysis);
  return buildComparisonReport({
    id: REPORT_ID,
    createdAt: CREATED_AT,
    ...(options?.title !== undefined ? { title: options.title } : {}),
    baseline,
    candidate,
    analysis,
    summary,
  });
}

describe("renderReportHtml", () => {
  it("renders one self-contained HTML document with the report's content", async () => {
    const report = await buildRealReport();
    const html = renderReportHtml(report);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<title>${report.title}</title>`);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).not.toContain('rel="stylesheet"');

    expect(html).toContain(">Models<");
    expect(html).toContain(">Analysis<");
    expect(html).toContain(">Findings<");
    expect(html).toContain(">Saved views<");
    expect(html).toContain(">Review<");

    expect(html).toContain(report.models[0]!.sourceDigest.value);
    expect(html).toContain(report.models[0]!.sourcePath);
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(html).toContain(finding.title);
    }
    expect(html).toContain(report.savedViews[0]!.name);
  });

  it("is deterministic: rendering an equal document twice yields identical bytes", async () => {
    const report = await buildRealReport();

    const first = renderReportHtml(report);
    const second = renderReportHtml(structuredCloneReport(report));

    expect(second).toBe(first);
  });

  it("HTML-escapes hostile user-controlled text instead of interpreting it", async () => {
    const sample = createBuiltInSamplePair();
    const hostileName =
      '<img src=x onerror=alert(1)>"><script>alert(2)</script>.stl';
    const bytes = await sample.baseline.file.arrayBuffer();
    const hostileFile = new File([bytes], hostileName, { lastModified: 0 });
    const hostileTitle = `Report for <b>${hostileName}</b>`;

    const report = await buildRealReport({
      baselineFile: hostileFile,
      title: hostileTitle,
    });
    const html = renderReportHtml(report);

    // The raw hostile markup must never appear unescaped in the output.
    expect(html).not.toContain(hostileName);
    expect(html).not.toContain(hostileTitle);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).not.toContain("<b>");

    // The escaped form must be present so the content is still visible as text.
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&quot;&gt;");
  });

  it("renders exactly what the document contains, without recomputing geometry", async () => {
    const report = await buildRealReport();
    const tampered = structuredCloneReport(report);
    // Mutate a stored value the renderer must transcribe verbatim rather than
    // recompute from geometry; if rendering recomputed it, this would be lost.
    const metric = tampered.analysis.result.outcome;
    if (metric.state === "complete" && metric.metrics[0]) {
      metric.metrics[0].value = 123456.789;
    }

    const html = renderReportHtml(tampered);
    expect(html).toContain("123456.789000");
  });
});

function structuredCloneReport<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
