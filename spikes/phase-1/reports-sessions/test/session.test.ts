import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { createCanonicalEvidence, sha256 } from "../src/canonical.js";
import { stableJson } from "../src/export.js";
import {
  createSession,
  defaultSessionLimits,
  importSession,
  inspectZip,
} from "../src/session.js";

function rewriteArchive(
  bytes: Uint8Array,
  mutate: (files: Record<string, Uint8Array>) => void,
): Uint8Array {
  const files = unzipSync(bytes);
  mutate(files);
  return zipSync(files, { level: 6 });
}

describe("portable session", () => {
  it("round-trips the canonical report and both source models", () => {
    const evidence = createCanonicalEvidence();
    const bytes = createSession(evidence);
    const imported = importSession(bytes);
    expect(imported.report).toEqual(evidence.report);
    expect(imported.files.get("models/baseline.stl")).toEqual(
      evidence.models.get("models/baseline.stl"),
    );
    expect(imported.files.get("models/candidate.stl")).toEqual(
      evidence.models.get("models/candidate.stl"),
    );
    expect(imported.manifest.entries).toHaveLength(4);
    expect(inspectZip(bytes).map(({ path }) => path)).toEqual([
      "manifest.json",
      "figures/overview.svg",
      "models/baseline.stl",
      "models/candidate.stl",
      "report.json",
    ]);
  });

  it("is byte deterministic and records hashes and sizes for every payload", () => {
    const first = createSession(createCanonicalEvidence());
    const second = createSession(createCanonicalEvidence());
    expect(first).toEqual(second);
    const imported = importSession(first);
    for (const entry of imported.manifest.entries) {
      const bytes = imported.files.get(entry.path)!;
      expect(entry.bytes).toBe(bytes.byteLength);
      expect(entry.sha256).toBe(sha256(bytes));
    }
  });

  it("rejects path traversal before inflation", () => {
    const hostile = zipSync({ "../outside.txt": strToU8("no") });
    expect(() => inspectZip(hostile)).toThrow(/Unsafe archive path/);
  });

  it("rejects unknown manifest versions", () => {
    const hostile = rewriteArchive(
      createSession(createCanonicalEvidence()),
      (files) => {
        const manifest = JSON.parse(
          new TextDecoder().decode(files["manifest.json"]),
        ) as { schemaVersion: number };
        manifest.schemaVersion = 99;
        files["manifest.json"] = strToU8(stableJson(manifest));
      },
    );
    expect(() => importSession(hostile)).toThrow(
      /Unsupported session schema version: 99/,
    );
  });

  it("rejects hash changes, unlisted files, and invalid report schemas", () => {
    const changed = rewriteArchive(
      createSession(createCanonicalEvidence()),
      (files) => {
        files["report.json"] = strToU8("{}");
      },
    );
    expect(() => importSession(changed)).toThrow(
      /failed size or hash verification/,
    );

    const unlisted = rewriteArchive(
      createSession(createCanonicalEvidence()),
      (files) => {
        files["extra.txt"] = strToU8("extra");
      },
    );
    expect(() => importSession(unlisted)).toThrow(/do not exactly match/);

    const wrongReportVersion = rewriteArchive(
      createSession(createCanonicalEvidence()),
      (files) => {
        const report = JSON.parse(
          new TextDecoder().decode(files["report.json"]),
        ) as { schemaVersion: number };
        report.schemaVersion = 2;
        const reportBytes = strToU8(stableJson(report));
        files["report.json"] = reportBytes;
        const manifest = JSON.parse(
          new TextDecoder().decode(files["manifest.json"]),
        ) as { entries: { path: string; bytes: number; sha256: string }[] };
        const entry = manifest.entries.find(
          ({ path }) => path === "report.json",
        )!;
        entry.bytes = reportBytes.byteLength;
        entry.sha256 = sha256(reportBytes);
        files["manifest.json"] = strToU8(stableJson(manifest));
      },
    );
    expect(() => importSession(wrongReportVersion)).toThrow(
      /Unsupported report schema version: 2/,
    );
  });

  it("enforces compressed, per-entry, total, count, and ratio limits before inflation", () => {
    const session = createSession(createCanonicalEvidence());
    expect(() =>
      inspectZip(session, { ...defaultSessionLimits, maxArchiveBytes: 1 }),
    ).toThrow(/compressed size limit/);
    expect(() =>
      inspectZip(session, { ...defaultSessionLimits, maxEntries: 1 }),
    ).toThrow(/entry count/);
    expect(() =>
      inspectZip(session, { ...defaultSessionLimits, maxEntryBytes: 10 }),
    ).toThrow(/entry exceeds size limit/);
    expect(() =>
      inspectZip(session, {
        ...defaultSessionLimits,
        maxTotalUncompressedBytes: 10,
      }),
    ).toThrow(/total uncompressed/);

    const bomb = zipSync(
      { "high-ratio.txt": strToU8("a".repeat(10_000)) },
      { level: 9 },
    );
    expect(() =>
      inspectZip(bomb, { ...defaultSessionLimits, maxCompressionRatio: 10 }),
    ).toThrow(/compression ratio/);
  });

  it("rejects trailing archive data", () => {
    const session = createSession(createCanonicalEvidence());
    const hostile = new Uint8Array(session.byteLength + 1);
    hostile.set(session);
    expect(() => inspectZip(hostile)).toThrow(/Trailing or truncated/);
  });
});
