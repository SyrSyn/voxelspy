import {
  IDENTITY_MAT4,
  reportSchema,
  type SessionArchiveLimits,
} from "@voxelspy/contracts";

import { digestSessionResource } from "../../src/index.js";

const createdAt = "2026-01-02T03:04:05.000Z";
const encoder = new TextEncoder();

export async function createSessionFixture() {
  const baseline = encoder.encode("solid baseline\nendsolid baseline\n");
  const candidate = encoder.encode("solid candidate\nendsolid candidate\n");
  const baselineDigest = await digestSessionResource(baseline);
  const candidateDigest = await digestSessionResource(candidate);
  const method = { id: "surface-distance", version: "1.0.0", parameters: {} };
  const tolerance = { distanceMillimetres: 0.01 };
  const baselineBinding = {
    modelId: "model.baseline",
    modelToComparison: IDENTITY_MAT4,
  };
  const candidateBinding = {
    modelId: "model.candidate",
    modelToComparison: IDENTITY_MAT4,
  };
  const analysisRequest = {
    contractVersion: 1,
    requestId: "analysis.session-fixture",
    baseline: baselineBinding,
    candidate: candidateBinding,
    method,
    tolerance,
  };
  const provenance = (
    sourceName: string,
    sourceDigest: typeof baselineDigest,
  ) => ({
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
  });
  const report = reportSchema.parse({
    contractVersion: 1,
    id: "report.session-fixture",
    title: "Portable session fixture",
    createdAt,
    generator: { id: "voxelspy", version: "0.1.0" },
    analysis: {
      request: analysisRequest,
      result: {
        contractVersion: 1,
        requestId: analysisRequest.requestId,
        baseline: baselineBinding,
        candidate: candidateBinding,
        warnings: [],
        outcome: {
          state: "indeterminate",
          code: "unsupported-domain",
          reasons: ["Fixture records a valid non-completed analysis"],
          requestedMethod: method,
          requestedTolerance: tolerance,
          validation: [],
        },
      },
    },
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
    markups: [],
    findings: [],
    savedViews: [
      {
        contractVersion: 1,
        id: "view.session-fixture",
        name: "Session fixture view",
        createdAt,
        frame: "comparison",
        camera: {
          position: [4, 3, 2],
          target: [0, 0, 0],
          up: [0, 0, 1],
          projection: { kind: "perspective", verticalFieldOfViewDegrees: 35 },
        },
        visibility: [
          { modelId: "model.baseline", visible: true },
          { modelId: "model.candidate", visible: true },
        ],
        selectedFindingIds: [],
        selectedMarkupIds: [],
        sectionPlanes: [],
        selectedRegionIds: [],
        displayMode: "overlay",
      },
    ],
    figures: [],
    review: {
      activeSavedViewId: "view.session-fixture",
      notes: "",
      status: "draft",
    },
  });
  return {
    report,
    sourceModels: new Map([
      ["models/baseline.stl", baseline],
      ["models/candidate.stl", candidate],
    ]),
  };
}

export const testLimits: SessionArchiveLimits = {
  maxArchiveBytes: 1024 * 1024,
  maxEntries: 4,
  maxEntryBytes: 512 * 1024,
  maxTotalExpandedBytes: 1024 * 1024,
  maxCompressionRatio: 4,
  maxManifestBytes: 64 * 1024,
  maxReportBytes: 256 * 1024,
};
