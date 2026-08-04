import { describe, expect, it } from "vitest";
import { reportSchema } from "../src/report.js";
import {
  sessionArchiveExchangeSchema,
  sessionBundleSchema,
  sessionLoadRequestSchema,
  sessionManifestSchema,
  sessionPreflightExchangeSchema,
  sessionResourceVerificationSchema,
} from "../src/session.js";
import { IDENTITY_MAT4 } from "../src/primitives.js";

const instant = "2026-01-02T03:04:05.000Z";
const digest = (value: string) => ({
  algorithm: "sha256" as const,
  value: value.repeat(64),
});
const baselineDigest = digest("a");
const candidateDigest = digest("b");
const reportDigest = digest("c");
const manifestDigest = digest("d");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const binding = (modelId: string) => ({
  modelId,
  modelToComparison: IDENTITY_MAT4,
});
const method = {
  id: "surface-distance",
  version: "1.0.0",
  parameters: {},
};
const tolerance = { distanceMillimetres: 0.01 };
const assessment = (modelId: string) => ({
  modelId,
  closed: true,
  consistentlyOriented: true,
  boundaryEdgeCount: 0,
  nonManifoldEdgeCount: 0,
  degenerateTriangleCount: 0,
  reasons: [],
  preconditions: [],
});

function analysisExchange() {
  const request = {
    contractVersion: 1,
    requestId: "analysis.report",
    baseline: binding("model.baseline"),
    candidate: binding("model.candidate"),
    method,
    tolerance,
  };
  return {
    request,
    result: {
      contractVersion: 1,
      requestId: request.requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings: [],
      outcome: {
        state: "complete",
        semantics: "approximate",
        requestedMethod: method,
        effectiveMethod: method,
        requestedTolerance: tolerance,
        effectiveTolerance: tolerance,
        validation: [
          assessment("model.baseline"),
          assessment("model.candidate"),
        ],
        metrics: [{ id: "metric.distance", value: 2, unit: "millimetre" }],
        regions: [
          {
            id: "region.width",
            frame: "comparison",
            category: "deviation",
            bounds: { min: [0, 0, 0], max: [2, 1, 1] },
            anchor: [1, 0.5, 0.5],
            metricIds: ["metric.distance"],
            warningCodes: [],
          },
        ],
        orderedRegionIds: ["region.width"],
        adjustments: [],
        uncertainty: {
          description: "Finite surface samples",
          parameters: { sampleCount: 100 },
        },
      },
    },
  };
}

function provenance(
  sourceName: string,
  sourceDigest: ReturnType<typeof digest>,
) {
  return {
    formatId: "stl",
    importerId: "stl.reference",
    importerVersion: "1.0.0",
    sourceName,
    sourceDigest,
    detectedSourceUnit: "unknown",
    detectedSourceAxis: "unknown",
    sourceUnit: "millimetre",
    sourceAxis: "right-handed-z-up",
    sourceResolution: { unit: "declared", axis: "declared" },
    appliedSourceToModel: IDENTITY_MAT4,
    notes: [],
  };
}

function report() {
  return {
    contractVersion: 1,
    id: "report.review",
    title: "Comparison review",
    createdAt: instant,
    generator: { id: "voxelspy", version: "0.1.0" },
    analysis: analysisExchange(),
    models: [
      {
        modelId: "model.baseline",
        role: "baseline",
        displayName: "Baseline",
        sourceName: "baseline.stl",
        sourceMediaType: "model/stl",
        sourcePath: "models/baseline.stl",
        sourceDigest: baselineDigest,
        normalizationProvenance: provenance("baseline.stl", baselineDigest),
      },
      {
        modelId: "model.candidate",
        role: "candidate",
        displayName: "Candidate",
        sourceName: "candidate.stl",
        sourceMediaType: "model/stl",
        sourcePath: "models/candidate.stl",
        sourceDigest: candidateDigest,
        normalizationProvenance: provenance("candidate.stl", candidateDigest),
      },
    ],
    markups: [
      {
        contractVersion: 1,
        id: "markup.width",
        kind: "callout",
        label: "Width",
        visible: true,
        createdAt: instant,
        attribution: { kind: "anonymous" },
        anchor: {
          frame: { kind: "model", modelId: "model.candidate" },
          pointMillimetres: [2, 0.5, 0.5],
          normal: [1, 0, 0],
          surface: {
            instanceId: "instance.body",
            meshId: "mesh.body",
            triangleIndex: 0,
            barycentric: [0.25, 0.25, 0.5],
          },
        },
        text: "Candidate extends beyond the baseline.",
      },
      {
        contractVersion: 1,
        id: "markup.distance",
        kind: "distance",
        label: "Width delta",
        visible: true,
        createdAt: instant,
        attribution: { kind: "anonymous" },
        start: {
          frame: { kind: "comparison" },
          pointMillimetres: [0, 0, 0],
        },
        end: {
          frame: { kind: "comparison" },
          pointMillimetres: [2, 0, 0],
        },
        valueMillimetres: 2,
      },
    ],
    findings: [
      {
        contractVersion: 1,
        id: "finding.width",
        source: {
          kind: "automatic",
          detector: method,
          analysisRequestId: "analysis.report",
        },
        severity: "warning",
        status: "open",
        title: "Width changed",
        summary: "Candidate width differs from baseline.",
        markupIds: ["markup.width", "markup.distance"],
        metricIds: ["metric.distance"],
        regionIds: ["region.width"],
        savedViewIds: ["view.width"],
        createdAt: instant,
        updatedAt: instant,
        attribution: { kind: "anonymous" },
      },
    ],
    savedViews: [
      {
        contractVersion: 1,
        id: "view.width",
        name: "Width review",
        createdAt: instant,
        frame: "comparison",
        camera: {
          position: [8, 6, 5],
          target: [1, 0.5, 0.5],
          up: [0, 0, 1],
          projection: {
            kind: "perspective",
            verticalFieldOfViewDegrees: 35,
          },
        },
        visibility: [
          { modelId: "model.baseline", visible: true },
          { modelId: "model.candidate", visible: true },
        ],
        selectedFindingIds: ["finding.width"],
        selectedMarkupIds: ["markup.width", "markup.distance"],
        selectedRegionIds: ["region.width"],
        sectionPlanes: [],
        displayMode: "overlay",
      },
    ],
    figures: [
      {
        contractVersion: 1,
        id: "figure.width",
        title: "Width overlay",
        savedViewId: "view.width",
        widthPixels: 640,
        heightPixels: 360,
        alternativeText: "Baseline and candidate width comparison.",
        primitives: [
          {
            kind: "line",
            from: [10, 10],
            to: [200, 10],
            color: "#1967d2",
            widthPixels: 2,
          },
          {
            kind: "label",
            at: [10, 30],
            text: "2 mm difference",
            color: "#202124",
          },
        ],
      },
    ],
    review: {
      activeSavedViewId: "view.width",
      notes: "Review note",
      status: "draft",
    },
  };
}

function manifest() {
  return {
    contractVersion: 1,
    kind: "voxelspy-session",
    contentPolicy: "self-contained-source-models",
    reportId: "report.review",
    createdAt: instant,
    reportPath: "report.json",
    entries: [
      {
        role: "source-model",
        modelId: "model.baseline",
        modelRole: "baseline",
        path: "models/baseline.stl",
        mediaType: "model/stl",
        bytes: 10,
        digest: baselineDigest,
      },
      {
        role: "source-model",
        modelId: "model.candidate",
        modelRole: "candidate",
        path: "models/candidate.stl",
        mediaType: "model/stl",
        bytes: 12,
        digest: candidateDigest,
      },
      {
        role: "report",
        path: "report.json",
        mediaType: "application/json",
        bytes: 100,
        digest: reportDigest,
      },
    ],
  };
}

const limits = {
  maxArchiveBytes: 2_000,
  maxEntries: 4,
  maxEntryBytes: 1_000,
  maxTotalExpandedBytes: 2_000,
  maxCompressionRatio: 20,
  maxManifestBytes: 500,
  maxReportBytes: 500,
};

function preflight() {
  return {
    archiveBytes: 1_000,
    entries: [
      {
        path: "manifest.json",
        compressedBytes: 40,
        expandedBytes: 50,
        compression: "deflate",
        encrypted: false,
      },
      {
        path: "models/baseline.stl",
        compressedBytes: 10,
        expandedBytes: 10,
        compression: "stored",
        encrypted: false,
      },
      {
        path: "models/candidate.stl",
        compressedBytes: 12,
        expandedBytes: 12,
        compression: "stored",
        encrypted: false,
      },
      {
        path: "report.json",
        compressedBytes: 80,
        expandedBytes: 100,
        compression: "deflate",
        encrypted: false,
      },
    ],
  };
}

function verifiedResources() {
  return [
    { path: "manifest.json", bytes: 50, digest: manifestDigest },
    { path: "models/baseline.stl", bytes: 10, digest: baselineDigest },
    { path: "models/candidate.stl", bytes: 12, digest: candidateDigest },
    { path: "report.json", bytes: 100, digest: reportDigest },
  ];
}

describe("report contracts", () => {
  it("accepts a correlated report graph with deterministic figure primitives", () => {
    const parsed = reportSchema.parse(report());
    expect(parsed.analysis.result.outcome.state).toBe("complete");
    expect(parsed.figures[0]?.primitives).toHaveLength(2);
  });

  it("rejects unknown versions, keys, noncanonical time, and unsafe text", () => {
    expect(() =>
      reportSchema.parse({ ...report(), contractVersion: 2 }),
    ).toThrow();
    expect(() => reportSchema.parse({ ...report(), extra: true })).toThrow();
    expect(() =>
      reportSchema.parse({ ...report(), createdAt: "2026-01-02T03:04:05Z" }),
    ).toThrow();
    expect(() =>
      reportSchema.parse({ ...report(), title: "bad\u0000text" }),
    ).toThrow();

    const markupVersion = clone(report());
    markupVersion.markups[0]!.contractVersion = 2;
    expect(() => reportSchema.parse(markupVersion)).toThrow();
    const findingKey = clone(report());
    Object.assign(findingKey.findings[0]!, { extra: true });
    expect(() => reportSchema.parse(findingKey)).toThrow();
    const viewVersion = clone(report());
    viewVersion.savedViews[0]!.contractVersion = 2;
    expect(() => reportSchema.parse(viewVersion)).toThrow();
    const figureKey = clone(report());
    Object.assign(figureKey.figures[0]!, { extra: true });
    expect(() => reportSchema.parse(figureKey)).toThrow();
  });

  it("rejects inconsistent measurements, cameras, figure bounds, and references", () => {
    const badDistance = clone(report());
    badDistance.markups[1]!.valueMillimetres = 3;
    expect(() => reportSchema.parse(badDistance)).toThrow();

    const badCamera = clone(report());
    badCamera.savedViews[0]!.camera.target = [8, 6, 5];
    expect(() => reportSchema.parse(badCamera)).toThrow();

    const badFigure = clone(report());
    badFigure.figures[0]!.primitives[0]!.to = [700, 10];
    expect(() => reportSchema.parse(badFigure)).toThrow();

    const badReference = clone(report());
    badReference.findings[0]!.source.analysisRequestId = "analysis.other";
    expect(() => reportSchema.parse(badReference)).toThrow();

    const badSurface = clone(report());
    (badSurface.markups[0]! as { anchor: { frame: unknown } }).anchor.frame = {
      kind: "comparison",
    };
    expect(() => reportSchema.parse(badSurface)).toThrow();

    const badBarycentric = clone(report());
    (
      badBarycentric.markups[0]! as {
        anchor: { surface: { barycentric: number[] } };
      }
    ).anchor.surface.barycentric = [0.5, 0.5, 0.5];
    expect(() => reportSchema.parse(badBarycentric)).toThrow();

    const mixedFrames = clone(report());
    (mixedFrames.markups[1]! as { end: { frame: unknown } }).end.frame = {
      kind: "model",
      modelId: "model.candidate",
    };
    expect(() => reportSchema.parse(mixedFrames)).toThrow();
  });

  it("rejects cross-category identity and source-provenance collisions", () => {
    const duplicate = clone(report());
    duplicate.findings[0]!.id = "metric.distance";
    expect(() => reportSchema.parse(duplicate)).toThrow();

    const changedSource = clone(report());
    changedSource.models[0]!.normalizationProvenance.sourceDigest = digest("e");
    expect(() => reportSchema.parse(changedSource)).toThrow();
  });

  it("does not allow automatic region findings over indeterminate analysis", () => {
    const candidate = clone(report());
    (candidate.analysis.result as { outcome: unknown }).outcome = {
      state: "indeterminate",
      code: "open-geometry",
      reasons: ["Method requires a supported domain"],
      requestedMethod: method,
      requestedTolerance: tolerance,
      validation: [],
    };
    expect(() => reportSchema.parse(candidate)).toThrow();
  });

  it("accepts a manual-only report when analysis is indeterminate", () => {
    const candidate = clone(report());
    (candidate.analysis.result as { outcome: unknown }).outcome = {
      state: "indeterminate",
      code: "open-geometry",
      reasons: ["Method requires a supported domain"],
      requestedMethod: method,
      requestedTolerance: tolerance,
      validation: [],
    };
    (candidate.findings[0]! as { source: unknown }).source = { kind: "manual" };
    candidate.findings[0]!.metricIds = [];
    candidate.findings[0]!.regionIds = [];
    candidate.savedViews[0]!.selectedRegionIds = [];
    expect(reportSchema.parse(candidate)).toBeTruthy();
  });
});

describe("portable session contracts", () => {
  it("accepts an exact report plus two-source manifest and archive evidence", () => {
    const bundle = sessionBundleSchema.parse({
      manifest: manifest(),
      manifestDigest,
      reportDigest,
      report: report(),
    });
    expect(bundle.manifest.entries).toHaveLength(3);
    expect(
      sessionArchiveExchangeSchema.parse({
        request: {
          contractVersion: 1,
          bytes: new Uint8Array(1_000),
          limits,
        },
        preflight: preflight(),
        bundle,
        verifiedResources: verifiedResources(),
      }),
    ).toBeTruthy();
  });

  it("rejects unsafe, duplicate, unsorted, extra, and mismatched resources", () => {
    expect(() =>
      sessionManifestSchema.parse({ ...manifest(), contractVersion: 2 }),
    ).toThrow();
    expect(() =>
      sessionManifestSchema.parse({ ...manifest(), extra: true }),
    ).toThrow();
    expect(() =>
      sessionManifestSchema.parse({
        ...manifest(),
        entries: manifest().entries.map((entry, index) =>
          index === 0 ? { ...entry, path: "../baseline.stl" } : entry,
        ),
      }),
    ).toThrow();
    expect(() =>
      sessionManifestSchema.parse({
        ...manifest(),
        entries: manifest().entries.map((entry, index) =>
          index === 1 ? { ...entry, path: "models/baseline.stl" } : entry,
        ),
      }),
    ).toThrow();
    expect(() =>
      sessionManifestSchema.parse({
        ...manifest(),
        entries: [...manifest().entries].reverse(),
      }),
    ).toThrow();

    const wrongDigest = clone(manifest());
    wrongDigest.entries[0]!.digest = digest("e");
    expect(() =>
      sessionBundleSchema.parse({
        manifest: wrongDigest,
        manifestDigest,
        reportDigest,
        report: report(),
      }),
    ).toThrow();
  });

  it("enforces caller archive limits before accepting a bundle", () => {
    expect(
      sessionPreflightExchangeSchema.parse({ limits, preflight: preflight() }),
    ).toBeTruthy();
    expect(() =>
      sessionPreflightExchangeSchema.parse({
        limits: { ...limits, maxCompressionRatio: 1 },
        preflight: preflight(),
      }),
    ).toThrow();
    expect(() =>
      sessionPreflightExchangeSchema.parse({
        limits: { ...limits, maxTotalExpandedBytes: 100 },
        preflight: preflight(),
      }),
    ).toThrow();

    const storedMismatch = preflight();
    storedMismatch.entries[3]!.compression = "stored";
    expect(() =>
      sessionPreflightExchangeSchema.parse({
        limits,
        preflight: storedMismatch,
      }),
    ).toThrow();

    const zeroCompressed = preflight();
    zeroCompressed.entries[0]!.compressedBytes = 0;
    expect(() =>
      sessionPreflightExchangeSchema.parse({
        limits,
        preflight: zeroCompressed,
      }),
    ).toThrow();

    expect(() =>
      sessionPreflightExchangeSchema.parse({
        limits,
        preflight: { ...preflight(), archiveBytes: 1 },
      }),
    ).toThrow();

    const namedModel = preflight();
    namedModel.entries[2]!.path = "models/report.json";
    namedModel.entries[3]!.compressedBytes = 10;
    namedModel.entries[3]!.expandedBytes = 10;
    expect(
      sessionPreflightExchangeSchema.parse({
        limits: { ...limits, maxReportBytes: 11 },
        preflight: namedModel,
      }),
    ).toBeTruthy();
  });

  it("rejects partial transfer views and forged post-inflate verification", () => {
    const bytes = new Uint8Array(new ArrayBuffer(1_001), 1, 1_000);
    expect(() =>
      sessionArchiveExchangeSchema.parse({
        request: { contractVersion: 1, bytes, limits },
        preflight: preflight(),
        bundle: {
          manifest: manifest(),
          manifestDigest,
          reportDigest,
          report: report(),
        },
        verifiedResources: verifiedResources(),
      }),
    ).toThrow();

    const forged = verifiedResources();
    forged[1] = { ...forged[1]!, digest: digest("f") };
    expect(() =>
      sessionArchiveExchangeSchema.parse({
        request: {
          contractVersion: 1,
          bytes: new Uint8Array(1_000),
          limits,
        },
        preflight: preflight(),
        bundle: {
          manifest: manifest(),
          manifestDigest,
          reportDigest,
          report: report(),
        },
        verifiedResources: forged,
      }),
    ).toThrow();

    expect(() =>
      sessionArchiveExchangeSchema.parse({
        request: {
          contractVersion: 1,
          bytes: new Uint8Array(1_000),
          limits,
        },
        preflight: preflight(),
        bundle: {
          manifest: manifest(),
          manifestDigest: digest("e"),
          reportDigest,
          report: report(),
        },
        verifiedResources: verifiedResources(),
      }),
    ).toThrow();

    const extraPreflight = preflight();
    extraPreflight.entries.push({
      path: "extra.bin",
      compressedBytes: 1,
      expandedBytes: 1,
      compression: "stored",
      encrypted: false,
    });
    expect(() =>
      sessionArchiveExchangeSchema.parse({
        request: {
          contractVersion: 1,
          bytes: new Uint8Array(1_000),
          limits: { ...limits, maxEntries: 5 },
        },
        preflight: extraPreflight,
        bundle: {
          manifest: manifest(),
          manifestDigest,
          reportDigest,
          report: report(),
        },
        verifiedResources: [
          ...verifiedResources(),
          { path: "extra.bin", bytes: 1, digest: digest("e") },
        ],
      }),
    ).toThrow();
  });

  it("rejects unknown keys and versions at session protocol boundaries", () => {
    expect(() =>
      sessionLoadRequestSchema.parse({
        contractVersion: 2,
        bytes: new Uint8Array(1),
        limits,
      }),
    ).toThrow();
    expect(() =>
      sessionLoadRequestSchema.parse({
        contractVersion: 1,
        bytes: new Uint8Array(1),
        limits,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      sessionLoadRequestSchema.parse({
        contractVersion: 1,
        bytes: new Uint8Array(101),
        limits: { ...limits, maxArchiveBytes: 100 },
      }),
    ).toThrow();
    expect(() =>
      sessionPreflightExchangeSchema.parse({
        limits,
        preflight: {
          ...preflight(),
          entries: preflight().entries.map((entry, index) =>
            index === 0 ? { ...entry, extra: true } : entry,
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      sessionResourceVerificationSchema.parse({
        ...verifiedResources()[0],
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      sessionResourceVerificationSchema.parse({
        ...verifiedResources()[0],
        bytes: 0,
      }),
    ).toThrow();
  });
});
