import {
  SURFACE_DISTANCE_METHOD,
  analyzeModelPair,
  summarizeModelComparison,
} from "@voxelspy/analysis";
import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisRequestSchema,
  analysisResultSchema,
  entityIdSchema,
  importRequestSchema,
  instanceIdSchema,
  meshIdSchema,
  modelIdSchema,
  normalizedModelSchema,
  regionIdSchema,
  reportIdSchema,
  reportSchema,
  requestIdSchema,
  type AnalysisResult,
  type NormalizedModel,
  type Report,
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

  it("escapes hostile content across every user-visible report field a session archive can carry", async () => {
    const report = await buildRealReport();
    expect(report.findings.length).toBeGreaterThan(0);
    // Combines an unescaped <script> and an <img onerror=...> attribute
    // injection; either one executing would set a global flag no test
    // fixture ever sets on its own.
    const payload =
      "<script>window.__voxelspyXssProbe=1</script>" +
      '<img src=x onerror="window.__voxelspyXssProbe=1">';

    const hostile: Report = {
      ...report,
      title: payload,
      models: report.models.map((model) => ({
        ...model,
        displayName: payload,
        sourceName: payload,
        // The contract cross-checks `sourceName` against the normalization
        // provenance it was imported with; both must carry the hostile
        // value for the document to stay valid.
        normalizationProvenance: {
          ...model.normalizationProvenance,
          sourceName: payload,
        },
      })),
      findings: report.findings.map((finding) => ({
        ...finding,
        title: payload,
        summary: payload,
      })),
      review: { ...report.review, notes: payload },
      analysis: {
        ...report.analysis,
        result: {
          ...report.analysis.result,
          warnings: [
            ...report.analysis.result.warnings,
            {
              code: entityIdSchema.parse("hostile-content-warning"),
              severity: "warning" as const,
              message: payload,
            },
          ],
        },
      },
    };

    // The injected content must still satisfy the exact contract a real
    // session archive's report is validated against on both save and open
    // -- the renderer's escaping, not a narrower shape that never reaches
    // it, is what has to stop this from executing.
    expect(() => reportSchema.parse(hostile)).not.toThrow();

    const html = renderReportHtml(hostile);

    // No occurrence, anywhere in the document, is left unescaped.
    expect(html).not.toContain("<script");
    expect(html).not.toContain('onerror="window');
    expect(html).not.toContain("<img src=x onerror=");

    // Content is preserved as visible (escaped) text, not silently
    // stripped, once per field it was injected into -- the title (rendered
    // twice: once in <title>, once in the <h1>), both models' display name
    // and source name, every finding's title and summary, the review
    // notes, and the extra warning message. Each rendered instance of the
    // payload contains the marker string twice (once in the script body,
    // once in the img attribute), so the total marker count is double the
    // instance count.
    const instanceCount =
      2 /* title + h1 */ +
      report.models.length * 2 +
      report.findings.length * 2 +
      1 /* review notes */ +
      1; /* warning message */
    const markerOccurrences =
      html.split("window.__voxelspyXssProbe").length - 1;
    expect(markerOccurrences).toBe(instanceCount * 2);
  });
});

describe("renderReportHtml with a findings-capped report", () => {
  it("keeps the truncation note visible in the rendered HTML", async () => {
    const report = buildManyRegionsReport(10_001);
    expect(report.findings).toHaveLength(10_000);

    const html = renderReportHtml(report);

    expect(html).toContain("Additional changed regions were not included");
    expect(html).toContain("10001");
    expect(html).toContain("9999");
  });

  it("renders a report at the findings cap within a generous time bound", () => {
    const report = buildManyRegionsReport(10_001);

    const start = performance.now();
    const html = renderReportHtml(report);
    const elapsedMilliseconds = performance.now() - start;

    expect(html.length).toBeGreaterThan(0);
    // Generous on purpose: this exists to catch a future quadratic-time
    // regression, not to pin down current performance.
    expect(elapsedMilliseconds).toBeLessThan(5_000);
  });
});

function structuredCloneReport<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function minimalTriangleModel(id: string): NormalizedModel {
  const meshId = meshIdSchema.parse(`${id}.mesh`);
  const instanceId = instanceIdSchema.parse(`${id}.instance`);
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id: modelIdSchema.parse(id),
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: meshId,
        geometry: {
          positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [{ id: instanceId, meshId, meshToModel: IDENTITY_MAT4 }],
    },
    warnings: [],
    provenance: {
      formatId: "stl",
      importerId: "voxelspy.test-fixture",
      importerVersion: "0.0.0",
      sourceName: `${id}.stl`,
      sourceDigest: { algorithm: "sha256", value: "a".repeat(64) },
      detectedSourceUnit: "unknown",
      detectedSourceAxis: "unknown",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "declared", axis: "declared" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [],
    },
  });
}

/**
 * Builds an `AnalysisResult` with `regionCount` regions, none carrying
 * metrics -- `outcome.metrics` has its own 10,000-item contract ceiling
 * independent of the findings ceiling this exercises; this fixture only
 * needs to push region *count* past `MAX_FINDINGS` (mirrors the equivalent
 * fixture in `build-report.test.ts`, which asserts the build side of this
 * same truncation).
 */
function manyRegionsAnalysis(
  baselineId: NormalizedModel["id"],
  candidateId: NormalizedModel["id"],
  regionCount: number,
): AnalysisResult {
  const regions = Array.from({ length: regionCount }, (_, index) => ({
    id: regionIdSchema.parse(`region.synthetic.${index}`),
    frame: "comparison" as const,
    category: "deviation" as const,
    bounds: { min: [0, 0, 0] as const, max: [1, 1, 1] as const },
    anchor: [0.5, 0.5, 0.5] as const,
    metricIds: [],
    warningCodes: [],
  }));
  return analysisResultSchema.parse({
    contractVersion: 1,
    requestId: requestIdSchema.parse("analysis.many-regions-fixture"),
    baseline: { modelId: baselineId, modelToComparison: IDENTITY_MAT4 },
    candidate: { modelId: candidateId, modelToComparison: IDENTITY_MAT4 },
    warnings: [],
    outcome: {
      state: "complete",
      semantics: "approximate",
      requestedMethod: SURFACE_DISTANCE_METHOD,
      effectiveMethod: SURFACE_DISTANCE_METHOD,
      requestedTolerance: { distanceMillimetres: 0.1 },
      effectiveTolerance: { distanceMillimetres: 0.1 },
      validation: [
        {
          modelId: baselineId,
          closed: false,
          consistentlyOriented: true,
          boundaryEdgeCount: 0,
          nonManifoldEdgeCount: 0,
          degenerateTriangleCount: 0,
          reasons: [],
          preconditions: [],
        },
        {
          modelId: candidateId,
          closed: false,
          consistentlyOriented: true,
          boundaryEdgeCount: 0,
          nonManifoldEdgeCount: 0,
          degenerateTriangleCount: 0,
          reasons: [],
          preconditions: [],
        },
      ],
      metrics: [],
      regions,
      orderedRegionIds: regions.map((region) => region.id),
      adjustments: [],
      uncertainty: {
        description: "Synthetic fixture uncertainty.",
        parameters: {},
      },
    },
  });
}

function buildManyRegionsReport(regionCount: number): Report {
  const baseline = minimalTriangleModel("model.baseline");
  const candidate = minimalTriangleModel("model.candidate");
  const analysis = manyRegionsAnalysis(baseline.id, candidate.id, regionCount);
  const summary = summarizeModelComparison(baseline, candidate, analysis);
  return buildComparisonReport({
    id: REPORT_ID,
    createdAt: CREATED_AT,
    baseline,
    candidate,
    analysis,
    summary,
  });
}
