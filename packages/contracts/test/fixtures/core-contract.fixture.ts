import { CANONICAL_FRAME, IDENTITY_MAT4 } from "../../src/primitives.js";

const instant = "2026-01-02T03:04:05.000Z";
const digest = (character: string) => ({
  algorithm: "sha256" as const,
  value: character.repeat(64),
});

const baselineDigest = digest("a");
const candidateDigest = digest("b");
const reportDigest = digest("c");
const manifestDigest = digest("d");
const adapter = { id: "stl.reference", version: "1.0.0" };
const method = {
  id: "surface-distance",
  version: "1.0.0",
  parameters: {},
};
const tolerance = { distanceMillimetres: 0.01 };

function provenance(sourceName: string, sourceDigest: typeof baselineDigest) {
  return {
    formatId: "stl",
    importerId: adapter.id,
    importerVersion: adapter.version,
    sourceName,
    sourceDigest,
    detectedSourceUnit: "unknown" as const,
    detectedSourceAxis: "unknown" as const,
    sourceUnit: "millimetre" as const,
    sourceAxis: "right-handed-z-up" as const,
    sourceResolution: { unit: "declared" as const, axis: "declared" as const },
    appliedSourceToModel: IDENTITY_MAT4,
    notes: [],
  };
}

function model(
  id: "model.baseline" | "model.candidate",
  sourceName: string,
  sourceDigest: typeof baselineDigest,
) {
  const suffix = id === "model.baseline" ? "baseline" : "candidate";
  return {
    contractVersion: 1 as const,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `mesh.${suffix}`,
        geometry: {
          positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      },
    ],
    placement: {
      kind: "flat" as const,
      instances: [
        {
          id: `instance.${suffix}`,
          meshId: `mesh.${suffix}`,
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: provenance(sourceName, sourceDigest),
  };
}

export function createCoreContractFixture() {
  const baselineModel = model("model.baseline", "baseline.stl", baselineDigest);
  const candidateModel = model(
    "model.candidate",
    "candidate.stl",
    candidateDigest,
  );
  const importRequest = {
    contractVersion: 1 as const,
    targetModelId: baselineModel.id,
    format: "stl",
    sourceName: baselineModel.provenance.sourceName,
    bytes: new Uint8Array([1, 2, 3]),
    options: {
      declaredUnit: "millimetre" as const,
      declaredAxis: "right-handed-z-up" as const,
      limits: { inputBytes: 3, triangleCount: 1 },
    },
  };
  const importResult = {
    contractVersion: 1 as const,
    ok: true as const,
    model: baselineModel,
  };
  const baselineBinding = {
    modelId: baselineModel.id,
    modelToComparison: IDENTITY_MAT4,
  };
  const candidateBinding = {
    modelId: candidateModel.id,
    modelToComparison: IDENTITY_MAT4,
  };
  const analysisRequest = {
    contractVersion: 1 as const,
    requestId: "analysis.integration",
    baseline: baselineBinding,
    candidate: candidateBinding,
    method,
    tolerance,
  };
  const analysisResult = {
    contractVersion: 1 as const,
    requestId: analysisRequest.requestId,
    baseline: baselineBinding,
    candidate: candidateBinding,
    warnings: [],
    outcome: {
      state: "indeterminate" as const,
      code: "unsupported-domain",
      reasons: ["Fixture intentionally exercises indeterminate semantics"],
      requestedMethod: method,
      requestedTolerance: tolerance,
      validation: [],
    },
  };
  const registry = {
    contractVersion: 1,
    registryVersion: "1.0.0",
    adapters: [
      {
        contractVersion: 1,
        ...adapter,
        inputContractVersion: 1,
        inputTransport: "owned-byte-buffer",
        runtimeKinds: ["browser-worker", "node-worker"],
        formats: [
          {
            formatId: importRequest.format,
            mediaTypes: ["model/stl"],
            extensions: ["stl"],
          },
        ],
        capabilities: {
          sourceUnits: "declaration-required",
          sourceAxes: "declaration-required",
          assemblies: "reject",
          tessellationProvenance: "not-applicable",
          externalResources: "reject",
          archiveCompression: "not-applicable",
          nativeStep: "unavailable",
        },
        dependencyInventory: {
          path: "evidence/dependencies.json",
          digest: digest("e"),
        },
      },
    ],
  };
  const fixtures = {
    contractVersion: 1,
    id: "integration-fixtures",
    version: "1.0.0",
    assets: [
      {
        id: "baseline-source",
        path: "fixtures/generated/baseline.stl",
        formatId: importRequest.format,
        mediaType: "model/stl",
        bytes: importRequest.bytes.byteLength,
        digest: baselineDigest,
        provenance: {
          kind: "project-generated",
          generator: {
            id: "integration-generator",
            version: "1.0.0",
            parametersDigest: digest("f"),
          },
          licensePath: "LICENSE",
        },
      },
    ],
    cases: [
      {
        id: "baseline-import",
        assetId: "baseline-source",
        adapter,
        targetModelId: importRequest.targetModelId,
        formatId: importRequest.format,
        sourceName: importRequest.sourceName,
        options: importRequest.options,
        expectation: {
          kind: "success",
          outputDigest: digest("0"),
          detectedSourceUnit: baselineModel.provenance.detectedSourceUnit,
          detectedSourceAxis: baselineModel.provenance.detectedSourceAxis,
          sourceUnit: baselineModel.provenance.sourceUnit,
          sourceAxis: baselineModel.provenance.sourceAxis,
          warningCodes: [],
          meshes: 1,
          vertices: 3,
          triangles: 1,
          assemblyNodes: 0,
        },
      },
    ],
  };
  const releasePolicy = {
    contractVersion: 1,
    id: "integration-release",
    version: "1.0.0",
    subject: { adapter, artifactDigest: digest("1") },
    registry: { path: "evidence/registry.json", digest: digest("2") },
    fixtures: { path: "evidence/fixtures.json", digest: digest("3") },
    benchmarks: { path: "evidence/benchmarks.json", digest: digest("4") },
    dependencies: { path: "evidence/dependencies.json", digest: digest("e") },
    gates: [
      {
        id: "local-only",
        required: true,
        kind: "network-isolation",
        maximumRequests: 0,
      },
    ],
  };
  const report = {
    contractVersion: 1,
    id: "report.integration",
    title: "Integrated contract fixture",
    createdAt: instant,
    generator: { id: "voxelspy", version: "0.1.0" },
    analysis: { request: analysisRequest, result: analysisResult },
    models: [
      {
        modelId: baselineModel.id,
        role: "baseline",
        displayName: "Baseline",
        sourceName: baselineModel.provenance.sourceName,
        sourceMediaType: "model/stl",
        sourcePath: "models/baseline.stl",
        sourceDigest: baselineDigest,
        normalizationProvenance: baselineModel.provenance,
      },
      {
        modelId: candidateModel.id,
        role: "candidate",
        displayName: "Candidate",
        sourceName: candidateModel.provenance.sourceName,
        sourceMediaType: "model/stl",
        sourcePath: "models/candidate.stl",
        sourceDigest: candidateDigest,
        normalizationProvenance: candidateModel.provenance,
      },
    ],
    markups: [],
    findings: [],
    savedViews: [
      {
        contractVersion: 1,
        id: "view.integration",
        name: "Integrated view",
        createdAt: instant,
        frame: "comparison",
        camera: {
          position: [4, 3, 2],
          target: [0, 0, 0],
          up: [0, 0, 1],
          projection: {
            kind: "perspective",
            verticalFieldOfViewDegrees: 35,
          },
        },
        visibility: [
          { modelId: baselineModel.id, visible: true },
          { modelId: candidateModel.id, visible: true },
        ],
        selectedFindingIds: [],
        selectedMarkupIds: [],
        selectedRegionIds: [],
        sectionPlanes: [],
        displayMode: "overlay",
      },
    ],
    figures: [],
    review: {
      activeSavedViewId: "view.integration",
      notes: "",
      status: "draft",
    },
  };
  const sessionManifest = {
    contractVersion: 1,
    kind: "voxelspy-session",
    contentPolicy: "self-contained-source-models",
    reportId: report.id,
    createdAt: instant,
    reportPath: "report.json",
    entries: [
      {
        role: "source-model",
        modelId: baselineModel.id,
        modelRole: "baseline",
        path: "models/baseline.stl",
        mediaType: "model/stl",
        bytes: 3,
        digest: baselineDigest,
      },
      {
        role: "source-model",
        modelId: candidateModel.id,
        modelRole: "candidate",
        path: "models/candidate.stl",
        mediaType: "model/stl",
        bytes: 3,
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
  const workerTrace = [
    {
      protocolVersion: 1,
      type: "ready",
      transport: "array-buffer-transfer",
      operations: ["import", "analysis"],
      maxActiveOperations: 1,
    },
    {
      protocolVersion: 1,
      type: "initialize",
      requestId: "initialize.integration",
    },
    {
      protocolVersion: 1,
      type: "initialized",
      requestId: "initialize.integration",
    },
    {
      protocolVersion: 1,
      type: "execute",
      operation: "import",
      requestId: "import.integration",
      request: importRequest,
    },
    {
      protocolVersion: 1,
      type: "result",
      operation: "import",
      requestId: "import.integration",
      result: importResult,
    },
    {
      protocolVersion: 1,
      type: "execute",
      operation: "analysis",
      requestId: analysisRequest.requestId,
      request: analysisRequest,
    },
    {
      protocolVersion: 1,
      type: "result",
      operation: "analysis",
      requestId: analysisResult.requestId,
      result: analysisResult,
    },
  ];

  return {
    adapter,
    analysisExchange: { request: analysisRequest, result: analysisResult },
    baselineModel,
    candidateModel,
    fixtures,
    importExchange: { request: importRequest, result: importResult },
    manifestDigest,
    registry,
    releasePolicy,
    report,
    reportDigest,
    sessionBundle: {
      manifest: sessionManifest,
      manifestDigest,
      reportDigest,
      report,
    },
    workerTrace,
  };
}
