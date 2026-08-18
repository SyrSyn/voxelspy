import {
  analyzeModelPair,
  summarizeModelComparison,
  SURFACE_DISTANCE_METHOD,
} from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  analysisRequestSchema,
  reportIdSchema,
  type AnalysisResult,
  type NormalizedModel,
  type Report,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";
import {
  createSessionArchive,
  digestSessionResource,
  SessionArchiveError,
} from "@voxelspy/session-archive";
import { describe, expect, it } from "vitest";
import { buildComparisonReport, renderReportHtml } from "./report";
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
import type { SessionImportSpec } from "./worker-client";

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
  summary: ReturnType<typeof summarizeModelComparison>;
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
  const summary = summarizeModelComparison(baseline, candidate, analysis);
  return {
    baseline,
    candidate,
    analysis,
    summary,
    sourceModels: { baseline: baselineBytes, candidate: candidateBytes },
  };
}

/**
 * Reimports a model from a `SessionImportSpec` the same way reopening a
 * session does in the real app (`reimportSessionModels` in
 * `worker-client.ts`), minus the worker transport: same `importRequestSchema`
 * shape, same derived `limits`. Used to verify that what a reopened session
 * feeds back into the report engine is exactly what the original comparison
 * fed into it.
 */
async function reimportModelFromSpec(
  spec: SessionImportSpec,
): Promise<NormalizedModel> {
  const result = await importModel({
    contractVersion: 1,
    targetModelId: spec.targetModelId,
    format: spec.format,
    sourceName: spec.sourceName,
    bytes: spec.bytes,
    options: {
      ...spec.options,
      limits: {
        inputBytes: Math.min(
          32 * 1024 * 1024,
          Math.max(spec.bytes.byteLength, 1),
        ),
        triangleCount: 500_000,
      },
    },
  });
  if (!result.ok) throw new Error(`Reimport failed: ${result.message}`);
  return result.model;
}

/**
 * Rebuilds the exported `Report` a reopened session would produce: reopens
 * `bytes`, reimports both models exactly as `ComparisonFlow.tsx` does, and
 * feeds the stored analysis result (never re-run) plus a freshly computed
 * presentation summary back into the same `buildComparisonReport` engine an
 * interactive export uses. `id`/`createdAt` are fixed so the result is
 * directly comparable to another export of the same comparison.
 */
async function exportReportFromReopenedSession(
  bytes: Uint8Array,
): Promise<Report> {
  const opened = await openSession(bytes);
  const { report } = opened.exchange.bundle;
  const baselineModel = report.models.find(
    (model) => model.role === "baseline",
  )!;
  const candidateModel = report.models.find(
    (model) => model.role === "candidate",
  )!;
  const baselineBytes = opened.resources.get(baselineModel.sourcePath)!;
  const candidateBytes = opened.resources.get(candidateModel.sourcePath)!;
  const baseline = await reimportModelFromSpec(
    sessionImportSpecFor(baselineModel, baselineBytes),
  );
  const candidate = await reimportModelFromSpec(
    sessionImportSpecFor(candidateModel, candidateBytes),
  );
  const analysis = report.analysis.result;
  const summary = summarizeModelComparison(baseline, candidate, analysis);
  return buildComparisonReport({
    id: reportIdSchema.parse("report.roundtrip-fixture"),
    createdAt: "2026-01-01T00:00:00.000Z",
    baseline,
    candidate,
    analysis,
    summary,
  });
}

// --- Forward-compatibility fixture: a report body this build never wrote ---
//
// `createSessionArchive` (this application's only real save path) always
// validates its report against this build's own `reportSchema` before
// writing anything, so it can never produce an archive whose report has a
// bumped `contractVersion` or an unrecognized field -- exactly the archive a
// *newer or different* VoxelSpy build could legitimately write. Simulating
// one to test `openSession`'s fail-closed behavior therefore means building
// the ZIP container by hand, mirroring the stored-ZIP format
// `@voxelspy/session-archive` requires (see its `zip.ts`). That writer is
// deliberately not part of the package's public API (only `index.ts` is),
// so it is duplicated here, test-only, rather than imported.
const zipTextEncoder = new TextEncoder();

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a minimal version-1 stored (uncompressed) ZIP from raw payloads. */
function buildTestStoredZip(
  files: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const records = [...files.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, bytes]) => ({
      name: zipTextEncoder.encode(path),
      bytes,
      crc: testCrc32(bytes),
      localOffset: 0,
    }));
  const localBytes = records.reduce(
    (sum, r) => sum + 30 + r.name.byteLength + r.bytes.byteLength,
    0,
  );
  const centralBytes = records.reduce(
    (sum, r) => sum + 46 + r.name.byteLength,
    0,
  );
  const output = new Uint8Array(localBytes + centralBytes + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const record of records) {
    record.localOffset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 33, true);
    view.setUint32(offset + 14, record.crc, true);
    view.setUint32(offset + 18, record.bytes.byteLength, true);
    view.setUint32(offset + 22, record.bytes.byteLength, true);
    view.setUint16(offset + 26, record.name.byteLength, true);
    view.setUint16(offset + 28, 0, true);
    output.set(record.name, offset + 30);
    output.set(record.bytes, offset + 30 + record.name.byteLength);
    offset += 30 + record.name.byteLength + record.bytes.byteLength;
  }
  const centralOffset = offset;
  for (const record of records) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 33, true);
    view.setUint32(offset + 16, record.crc, true);
    view.setUint32(offset + 20, record.bytes.byteLength, true);
    view.setUint32(offset + 24, record.bytes.byteLength, true);
    view.setUint16(offset + 28, record.name.byteLength, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, record.localOffset, true);
    output.set(record.name, offset + 46);
    offset += 46 + record.name.byteLength;
  }
  const centralLength = offset - centralOffset;
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, records.length, true);
  view.setUint16(offset + 10, records.length, true);
  view.setUint32(offset + 12, centralLength, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);
  return output;
}

/**
 * Builds a structurally valid session archive whose `report.json` is
 * `rawReportValue` verbatim, instead of the real, contract-valid report
 * `createSessionArchive` would otherwise have embedded for the same
 * `fixture`. The manifest's report entry is recomputed to match
 * `rawReportValue`'s actual bytes and digest, so every check
 * `openSessionArchive` performs before it inspects the report body itself
 * (manifest shape, entry-set agreement, per-entry integrity) still passes --
 * isolating the assertion to exactly the report-content check under test.
 */
async function buildArchiveWithRawReport(
  fixture: Fixture,
  rawReportValue: unknown,
): Promise<Uint8Array> {
  const validReport = buildSessionReport(fixture);
  const sourceModels = new Map<string, Uint8Array>();
  for (const model of validReport.models) {
    sourceModels.set(
      model.sourcePath,
      model.role === "baseline"
        ? fixture.sourceModels.baseline
        : fixture.sourceModels.candidate,
    );
  }
  const { bundle } = await createSessionArchive({
    report: validReport,
    sourceModels,
    limits: SESSION_ARCHIVE_LIMITS,
  });
  const reportBytes = zipTextEncoder.encode(JSON.stringify(rawReportValue));
  const reportDigest = await digestSessionResource(reportBytes);
  const manifest = {
    ...bundle.manifest,
    entries: bundle.manifest.entries.map((entry) =>
      entry.role === "report"
        ? { ...entry, bytes: reportBytes.byteLength, digest: reportDigest }
        : entry,
    ),
  };
  const manifestBytes = zipTextEncoder.encode(JSON.stringify(manifest));
  const files = new Map<string, Uint8Array>();
  files.set("manifest.json", manifestBytes);
  files.set("report.json", reportBytes);
  for (const entry of manifest.entries) {
    if (entry.role !== "source-model") continue;
    const bytes = sourceModels.get(entry.path);
    if (!bytes)
      throw new Error(`Fixture is missing source bytes for ${entry.path}`);
    files.set(entry.path, bytes);
  }
  return buildTestStoredZip(files);
}

describe("openSession forward-compatibility with a report from a newer or unknown build", () => {
  it("fails closed with a clear message when the report declares a newer contractVersion", async () => {
    const fixture = await buildFixture();
    const validReport = buildSessionReport(fixture);
    const futureReport = {
      ...(JSON.parse(JSON.stringify(validReport)) as Record<string, unknown>),
      contractVersion: 2,
    };
    const bytes = await buildArchiveWithRawReport(fixture, futureReport);

    await expect(openSession(bytes)).rejects.toBeInstanceOf(
      SessionArchiveError,
    );
    try {
      await openSession(bytes);
      expect.unreachable(
        "a report from a newer contract version must not open",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(SessionArchiveError);
      expect((error as SessionArchiveError).code).toBe("UNSUPPORTED_VERSION");
      const message = describeSessionError(error);
      // Vague messages like "session could not be opened" leave a user with
      // a newer-build file no way to tell what to do next; the message must
      // name the actual cause.
      expect(message).toMatch(/version/iu);
      expect(message).toMatch(/newer|unsupported|unrecognized/iu);
    }
  });

  it("fails closed with a clear message when the report contains a field this build does not know", async () => {
    const fixture = await buildFixture();
    const validReport = buildSessionReport(fixture);
    const foreignReport = {
      ...(JSON.parse(JSON.stringify(validReport)) as Record<string, unknown>),
      // A field a hypothetical future build might add and this build's
      // strict report schema has never heard of.
      experimentalAnnotations: [{ note: "future feature" }],
    };
    const bytes = await buildArchiveWithRawReport(fixture, foreignReport);

    await expect(openSession(bytes)).rejects.toBeInstanceOf(
      SessionArchiveError,
    );
    try {
      await openSession(bytes);
      expect.unreachable("a report with an unrecognized field must not open");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionArchiveError);
      expect((error as SessionArchiveError).code).toBe("INVALID_REPORT");
      const message = describeSessionError(error);
      expect(message).toMatch(/format/iu);
      expect(message).toMatch(/newer|different|unrecognized/iu);
    }
  });
});

describe("report round-trip fidelity through a reopened session", () => {
  it("exports the same report from a reopened session as from the original comparison", async () => {
    const fixture = await buildFixture();
    const originalExport = buildComparisonReport({
      id: reportIdSchema.parse("report.roundtrip-fixture"),
      createdAt: "2026-01-01T00:00:00.000Z",
      baseline: fixture.baseline,
      candidate: fixture.candidate,
      analysis: fixture.analysis,
      summary: fixture.summary,
    });

    const saved = await saveSession(fixture);
    const reopenedExport = await exportReportFromReopenedSession(saved.bytes);

    // `toEqual` on failure reports exactly which field differs, rather than
    // a bare boolean -- if reopening ever loses fidelity, the failure names
    // the field and value that changed.
    expect(reopenedExport).toEqual(originalExport);
  });
});

describe("determinism of a report exported from a reopened session", () => {
  it("renders byte-identical HTML across two separate reopenings of the same archive", async () => {
    const fixture = await buildFixture();
    const saved = await saveSession(fixture);

    const firstExport = await exportReportFromReopenedSession(saved.bytes);
    const secondExport = await exportReportFromReopenedSession(saved.bytes);
    expect(secondExport).toEqual(firstExport);

    const firstHtml = renderReportHtml(firstExport);
    const secondHtml = renderReportHtml(secondExport);
    expect(secondHtml).toBe(firstHtml);
  });
});

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
    expect(report.figures).toEqual([]);
    // The session report is now built by the same engine as an interactive
    // export, so it carries real findings derived from the analysis result
    // (previously always empty) and a non-empty geometry-summary narrative.
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.review.notes.length).toBeGreaterThan(0);
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
