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
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";
import { describe, expect, it } from "vitest";

import { createBuiltInSamplePair } from "../sample-models.js";
import type { ComparisonSource } from "../worker-client.js";
import { ReportBuildError, buildComparisonReport } from "./build-report.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const REPORT_ID = reportIdSchema.parse("report.fixture");

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

async function buildRealComparison() {
  const sample = createBuiltInSamplePair();
  const baseline = await importSample("baseline", sample.baseline);
  const candidate = await importSample("candidate", sample.candidate);
  const request = analysisRequestSchema.parse({
    contractVersion: 1,
    requestId: requestIdSchema.parse("analysis.report-fixture"),
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
  return { baseline, candidate, analysis, summary };
}

describe("buildComparisonReport", () => {
  it("builds a report that satisfies the contract from a real comparison", async () => {
    const { baseline, candidate, analysis, summary } =
      await buildRealComparison();
    expect(analysis.outcome.state).toBe("complete");
    if (analysis.outcome.state !== "complete") return;
    const outcome = analysis.outcome;
    expect(outcome.regions.length).toBeGreaterThan(0);

    const report = buildComparisonReport({
      id: REPORT_ID,
      createdAt: CREATED_AT,
      baseline,
      candidate,
      analysis,
      summary,
    });

    expect(() => reportSchema.parse(report)).not.toThrow();
    expect(report.models.map((model) => model.role)).toEqual([
      "baseline",
      "candidate",
    ]);
    expect(report.models[0]?.modelId).toBe(baseline.id);
    expect(report.models[1]?.modelId).toBe(candidate.id);
    expect(report.models[0]?.sourcePath).toBe("models/baseline.stl");
    expect(report.models[1]?.sourceDigest).toEqual(
      candidate.provenance.sourceDigest,
    );
    expect(report.findings).toHaveLength(outcome.regions.length);
    expect(
      report.findings.every(
        (finding) =>
          finding.source.kind === "automatic" &&
          finding.source.detector.id === outcome.effectiveMethod.id &&
          finding.source.detector.version === outcome.effectiveMethod.version &&
          finding.source.analysisRequestId === analysis.requestId,
      ),
    ).toBe(true);
    expect(report.savedViews).toHaveLength(1);
    expect(report.review.activeSavedViewId).toBe(report.savedViews[0]?.id);
    expect(report.review.notes).toContain("Automated geometry summary");
    expect(report.analysis.result).toEqual(analysis);
  });

  it("is deterministic: identical inputs produce a deep-equal document", async () => {
    const { baseline, candidate, analysis, summary } =
      await buildRealComparison();
    const input = {
      id: REPORT_ID,
      createdAt: CREATED_AT,
      baseline,
      candidate,
      analysis,
      summary,
    };

    const first = buildComparisonReport(input);
    const second = buildComparisonReport(input);

    expect(second).toEqual(first);
  });

  it("preserves hostile source-name text as data without executing or stripping it", async () => {
    const sample = createBuiltInSamplePair();
    const hostileName =
      '<img src=x onerror=alert(1)>"><script>alert(2)</script>.stl';
    const baselineBytes = await sample.baseline.file.arrayBuffer();
    const hostileFile = new File([baselineBytes], hostileName, {
      lastModified: 0,
    });
    const baseline = await importSample(
      "baseline",
      sample.baseline,
      hostileFile,
    );
    const candidate = await importSample("candidate", sample.candidate);
    const request = analysisRequestSchema.parse({
      contractVersion: 1,
      requestId: requestIdSchema.parse("analysis.hostile-fixture"),
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

    const report = buildComparisonReport({
      id: REPORT_ID,
      createdAt: CREATED_AT,
      title: hostileName,
      baseline,
      candidate,
      analysis,
      summary,
    });

    expect(() => reportSchema.parse(report)).not.toThrow();
    expect(report.models[0]?.sourceName).toBe(hostileName);
    expect(report.title).toBe(hostileName);
  });

  it("fails closed when a model's provenance has no source digest", async () => {
    const baseline = minimalTriangleModel("model.baseline", {
      withDigest: false,
    });
    const candidate = minimalTriangleModel("model.candidate", {
      withDigest: true,
    });
    const analysis = minimalIndeterminateAnalysis(baseline.id, candidate.id);
    const summary = summarizeModelComparison(baseline, candidate, analysis);

    expect(() =>
      buildComparisonReport({
        id: REPORT_ID,
        createdAt: CREATED_AT,
        baseline,
        candidate,
        analysis,
        summary,
      }),
    ).toThrow(ReportBuildError);
    try {
      buildComparisonReport({
        id: REPORT_ID,
        createdAt: CREATED_AT,
        baseline,
        candidate,
        analysis,
        summary,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReportBuildError);
      expect((error as InstanceType<typeof ReportBuildError>).code).toBe(
        "missing-source-digest",
      );
    }
  });

  it("truncates automatic findings and records a note when regions exceed the findings limit", async () => {
    const baseline = minimalTriangleModel("model.baseline", {
      withDigest: true,
    });
    const candidate = minimalTriangleModel("model.candidate", {
      withDigest: true,
    });
    const totalRegions = 10_001;
    const analysis = manyRegionsAnalysis(
      baseline.id,
      candidate.id,
      totalRegions,
    );
    const summary = summarizeModelComparison(baseline, candidate, analysis);

    const report = buildComparisonReport({
      id: REPORT_ID,
      createdAt: CREATED_AT,
      baseline,
      candidate,
      analysis,
      summary,
    });

    expect(() => reportSchema.parse(report)).not.toThrow();
    expect(report.findings).toHaveLength(10_000);
    const automatic = report.findings.filter(
      (finding) => finding.source.kind === "automatic",
    );
    const manual = report.findings.filter(
      (finding) => finding.source.kind === "manual",
    );
    expect(automatic).toHaveLength(9_999);
    expect(manual).toHaveLength(1);
    expect(manual[0]?.summary).toContain(String(totalRegions));
    expect(manual[0]?.summary).toContain("9999");
  });
});

function minimalTriangleModel(
  id: string,
  options: { readonly withDigest: boolean },
): NormalizedModel {
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
      ...(options.withDigest
        ? { sourceDigest: { algorithm: "sha256", value: "a".repeat(64) } }
        : {}),
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

function minimalIndeterminateAnalysis(
  baselineId: NormalizedModel["id"],
  candidateId: NormalizedModel["id"],
): AnalysisResult {
  return analysisResultSchema.parse({
    contractVersion: 1,
    requestId: requestIdSchema.parse("analysis.missing-digest-fixture"),
    baseline: { modelId: baselineId, modelToComparison: IDENTITY_MAT4 },
    candidate: { modelId: candidateId, modelToComparison: IDENTITY_MAT4 },
    warnings: [],
    outcome: {
      state: "indeterminate",
      code: "test-indeterminate",
      reasons: ["Synthetic fixture does not run real analysis."],
      requestedMethod: SURFACE_DISTANCE_METHOD,
      requestedTolerance: { distanceMillimetres: 0.1 },
      validation: [],
    },
  });
}

function manyRegionsAnalysis(
  baselineId: NormalizedModel["id"],
  candidateId: NormalizedModel["id"],
  regionCount: number,
): AnalysisResult {
  // Regions intentionally carry no metrics: `outcome.metrics` has its own
  // 10,000-item contract ceiling independent of the findings ceiling this
  // fixture exercises, and this test only needs to push region *count*
  // past `MAX_FINDINGS`.
  const regions = Array.from({ length: regionCount }, (_, index) => {
    const id = regionIdSchema.parse(`region.synthetic.${index}`);
    return {
      id,
      frame: "comparison" as const,
      category: "deviation" as const,
      bounds: { min: [0, 0, 0] as const, max: [1, 1, 1] as const },
      anchor: [0.5, 0.5, 0.5] as const,
      metricIds: [],
      warningCodes: [],
    };
  });
  const metrics: never[] = [];
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
      metrics,
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
