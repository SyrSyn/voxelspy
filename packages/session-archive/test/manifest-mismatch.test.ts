import { describe, expect, it } from "vitest";

import {
  SessionArchiveError,
  createSessionArchive,
  openSessionArchive,
} from "../src/index.js";
import { encodeCanonicalJson } from "../src/json.js";
import { createStoredZip } from "../src/zip.js";
import {
  createSessionFixture,
  testLimits,
} from "./fixtures/session.fixture.js";

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function request(bytes: Uint8Array, limits = testLimits) {
  return { contractVersion: 1 as const, bytes: owned(bytes), limits };
}

async function expectCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await action();
    throw new Error("Expected openSessionArchive to reject the archive");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionArchiveError);
    expect((error as SessionArchiveError).code).toBe(code);
  }
}

/** Flip one hex character of a SHA-256 hex digest while keeping it a valid
 * 64-character [a-f0-9] value, so schema validation still accepts it. */
function flipHexDigest(value: string): string {
  const index = 0;
  const table = "0123456789abcdef";
  const next = table[(table.indexOf(value[index]!) + 1) % table.length]!;
  return next + value.slice(1);
}

describe("openSessionArchive: MANIFEST_MISMATCH and INTEGRITY_ERROR branches", () => {
  it("rejects an archive where the manifest lists an entry absent from the ZIP", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const reportBytes = encodeCanonicalJson(fixture.report);
    const manifestBytes = encodeCanonicalJson(created.bundle.manifest);
    // Manifest still references both source models, but the ZIP we hand to
    // openSessionArchive is missing one of them.
    const missingOneModel = createStoredZip(
      new Map([
        ["manifest.json", manifestBytes],
        ["report.json", reportBytes],
        [
          "models/baseline.stl",
          fixture.sourceModels.get("models/baseline.stl")!,
        ],
      ]),
    );
    await expectCode(
      () => openSessionArchive(request(missingOneModel)),
      "MANIFEST_MISMATCH",
    );
  });

  it("rejects an archive containing an entry absent from the manifest", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const reportBytes = encodeCanonicalJson(fixture.report);
    const manifestBytes = encodeCanonicalJson(created.bundle.manifest);
    const withStrayFile = createStoredZip(
      new Map([
        ["manifest.json", manifestBytes],
        ["report.json", reportBytes],
        [
          "models/baseline.stl",
          fixture.sourceModels.get("models/baseline.stl")!,
        ],
        [
          "models/candidate.stl",
          fixture.sourceModels.get("models/candidate.stl")!,
        ],
        ["models/extra.stl", new Uint8Array([1, 2, 3, 4])],
      ]),
    );
    await expectCode(
      () =>
        openSessionArchive(
          request(withStrayFile, { ...testLimits, maxEntries: 5 }),
        ),
      "MANIFEST_MISMATCH",
    );
  });

  it("rejects an archive whose payload digest does not match its manifest entry", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const reportBytes = encodeCanonicalJson(fixture.report);
    const tamperedManifest = structuredClone(created.bundle.manifest);
    const modelEntry = tamperedManifest.entries.find(
      (entry) => entry.path === "models/baseline.stl",
    );
    if (!modelEntry) throw new Error("Fixture manifest entry not found");
    modelEntry.digest = {
      ...modelEntry.digest,
      value: flipHexDigest(modelEntry.digest.value),
    };
    const tamperedManifestBytes = encodeCanonicalJson(tamperedManifest);
    const archive = createStoredZip(
      new Map([
        ["manifest.json", tamperedManifestBytes],
        ["report.json", reportBytes],
        [
          "models/baseline.stl",
          fixture.sourceModels.get("models/baseline.stl")!,
        ],
        [
          "models/candidate.stl",
          fixture.sourceModels.get("models/candidate.stl")!,
        ],
      ]),
    );
    await expectCode(
      () => openSessionArchive(request(archive)),
      "INTEGRITY_ERROR",
    );
  });

  it("rejects an archive whose payload byte count does not match its manifest entry", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const reportBytes = encodeCanonicalJson(fixture.report);
    const tamperedManifest = structuredClone(created.bundle.manifest);
    const modelEntry = tamperedManifest.entries.find(
      (entry) => entry.path === "models/candidate.stl",
    );
    if (!modelEntry) throw new Error("Fixture manifest entry not found");
    modelEntry.bytes += 1;
    const tamperedManifestBytes = encodeCanonicalJson(tamperedManifest);
    const archive = createStoredZip(
      new Map([
        ["manifest.json", tamperedManifestBytes],
        ["report.json", reportBytes],
        [
          "models/baseline.stl",
          fixture.sourceModels.get("models/baseline.stl")!,
        ],
        [
          "models/candidate.stl",
          fixture.sourceModels.get("models/candidate.stl")!,
        ],
      ]),
    );
    await expectCode(
      () => openSessionArchive(request(archive)),
      "INTEGRITY_ERROR",
    );
  });
});
