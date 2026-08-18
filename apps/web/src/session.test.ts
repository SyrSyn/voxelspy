import { analyzeModelPair, SURFACE_DISTANCE_METHOD } from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  analysisRequestSchema,
  type AnalysisResult,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";
import { SessionArchiveError } from "@voxelspy/session-archive";
import { describe, expect, it } from "vitest";
import {
  buildSessionReport,
  describeSessionError,
  openSession,
  saveSession,
  sessionFileName,
  sessionImportSpecFor,
  SESSION_ARCHIVE_LIMITS,
  SESSION_FILE_EXTENSION,
} from "./session";

const encoder = new TextEncoder();

function stlBytes(name: string, tipZ: number): Uint8Array {
  const text = `solid ${name}
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 ${tipZ}
endloop
endfacet
endsolid ${name}
`;
  return encoder.encode(text);
}

interface Fixture {
  baseline: NormalizedModel;
  candidate: NormalizedModel;
  analysis: AnalysisResult;
  sourceModels: { baseline: Uint8Array; candidate: Uint8Array };
}

async function importFixtureModel(
  role: "baseline" | "candidate",
  bytes: Uint8Array,
): Promise<NormalizedModel> {
  const result = await importModel({
    contractVersion: 1,
    targetModelId: `model.${role}`,
    format: "stl",
    sourceName: `${role}.stl`,
    bytes,
    options: {
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
      limits: { inputBytes: 1024, triangleCount: 100 },
    },
  });
  if (!result.ok) throw new Error(`Fixture import failed: ${result.message}`);
  return result.model;
}

async function buildFixture(): Promise<Fixture> {
  const baselineBytes = stlBytes("baseline", 0);
  const candidateBytes = stlBytes("candidate", 1);
  const baseline = await importFixtureModel("baseline", baselineBytes);
  const candidate = await importFixtureModel("candidate", candidateBytes);
  const request = analysisRequestSchema.parse({
    contractVersion: 1,
    requestId: "analysis.session-fixture",
    baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
    candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
    method: { ...SURFACE_DISTANCE_METHOD, parameters: { maxRegions: 4 } },
    tolerance: { distanceMillimetres: 0.1 },
  });
  const analysis = analyzeModelPair({ request, baseline, candidate });
  return {
    baseline,
    candidate,
    analysis,
    sourceModels: { baseline: baselineBytes, candidate: candidateBytes },
  };
}

describe("buildSessionReport", () => {
  it("builds a contract-valid report with exactly one required saved view", async () => {
    const fixture = await buildFixture();
    const report = buildSessionReport(fixture);
    expect(report.models.map((model) => model.role)).toEqual([
      "baseline",
      "candidate",
    ]);
    expect(report.savedViews).toHaveLength(1);
    expect(report.review.activeSavedViewId).toBe(report.savedViews[0]!.id);
    expect(report.markups).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.figures).toEqual([]);
  });

  it("is a pure, deterministic function of its inputs", async () => {
    const fixture = await buildFixture();
    const first = buildSessionReport(fixture);
    const second = buildSessionReport(fixture);
    expect(second).toEqual(first);
  });

  it("refuses to save a model that was imported without a source digest", async () => {
    const fixture = await buildFixture();
    const withoutDigest = {
      ...fixture,
      baseline: {
        ...fixture.baseline,
        provenance: {
          ...fixture.baseline.provenance,
          sourceDigest: undefined,
        },
      },
    };
    expect(() => buildSessionReport(withoutDigest)).toThrow(/source digest/u);
  });
});

describe("saveSession", () => {
  it("produces byte-identical archives for the same comparison saved twice", async () => {
    const fixture = await buildFixture();
    const first = await saveSession(fixture);
    const second = await saveSession(fixture);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.bytes.byteLength).toBe(first.bytes.byteLength);
  });

  it("names the file with the .voxelspy extension and both model names", async () => {
    const fixture = await buildFixture();
    const saved = await saveSession(fixture);
    expect(saved.fileName.endsWith(SESSION_FILE_EXTENSION)).toBe(true);
    expect(saved.fileName).toContain("baseline");
    expect(saved.fileName).toContain("candidate");
    expect(sessionFileName(saved.report)).toBe(saved.fileName);
  });

  it("round-trips through openSession with the original models and analysis result", async () => {
    const fixture = await buildFixture();
    const saved = await saveSession(fixture);
    const opened = await openSession(saved.bytes);
    const { report } = opened.exchange.bundle;
    expect(report.analysis.result).toEqual(fixture.analysis);

    const baselineModel = report.models.find(
      (model) => model.role === "baseline",
    )!;
    const candidateModel = report.models.find(
      (model) => model.role === "candidate",
    )!;
    const baselineBytes = opened.resources.get(baselineModel.sourcePath)!;
    const candidateBytes = opened.resources.get(candidateModel.sourcePath)!;
    expect(baselineBytes).toEqual(fixture.sourceModels.baseline);
    expect(candidateBytes).toEqual(fixture.sourceModels.candidate);

    const baselineSpec = sessionImportSpecFor(baselineModel, baselineBytes);
    expect(baselineSpec.options).toEqual({
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
    });
    const reimported = await importFixtureModel("baseline", baselineBytes);
    expect(reimported).toEqual(fixture.baseline);
  });

  it("rejects an archive larger than the caller's limits", async () => {
    const fixture = await buildFixture();
    await expect(
      saveSession({
        ...fixture,
        sourceModels: {
          baseline: fixture.sourceModels.baseline,
          candidate: new Uint8Array(SESSION_ARCHIVE_LIMITS.maxEntryBytes + 1),
        },
      }),
    ).rejects.toBeInstanceOf(SessionArchiveError);
  });
});

describe("openSession error handling", () => {
  it("fails closed on a corrupted archive with a clear, mapped message", async () => {
    const fixture = await buildFixture();
    const saved = await saveSession(fixture);
    const corrupted = saved.bytes.slice();
    const flipIndex = corrupted.byteLength - 10;
    corrupted[flipIndex] = corrupted[flipIndex]! ^ 0xff;
    await expect(openSession(corrupted)).rejects.toThrow();
    try {
      await openSession(corrupted);
      expect.unreachable("corrupted archive must not open");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionArchiveError);
      expect(describeSessionError(error)).toMatch(/[a-z]/u);
      expect(describeSessionError(error)).not.toMatch(/undefined/u);
    }
  });

  it("rejects an oversized input before touching its content", async () => {
    const oversized = new Uint8Array(
      SESSION_ARCHIVE_LIMITS.maxArchiveBytes + 1,
    );
    await expect(openSession(oversized)).rejects.toBeInstanceOf(
      SessionArchiveError,
    );
  });
});

describe("describeSessionError", () => {
  it("maps every session-archive error code to a distinct, non-empty message", () => {
    const codes = [
      "INVALID_REQUEST",
      "ARCHIVE_LIMIT",
      "INVALID_ZIP",
      "UNSUPPORTED_ZIP",
      "INVALID_PATH",
      "DUPLICATE_PATH",
      "INVALID_JSON",
      "UNSUPPORTED_VERSION",
      "INVALID_MANIFEST",
      "INVALID_REPORT",
      "MANIFEST_MISMATCH",
      "INTEGRITY_ERROR",
    ] as const;
    const messages = codes.map((code) =>
      describeSessionError(new SessionArchiveError(code, "internal detail")),
    );
    expect(new Set(messages).size).toBe(codes.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
  });

  it("falls back to a safe generic message for a non-archive failure", () => {
    expect(describeSessionError("not an error")).toMatch(/session/iu);
    expect(describeSessionError(new Error("boom"))).toMatch(/session/iu);
  });
});
