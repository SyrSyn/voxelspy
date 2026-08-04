import { describe, expect, it } from "vitest";

import {
  SessionArchiveError,
  createSessionArchive,
  inspectSessionArchive,
  openSessionArchive,
} from "../src/index.js";
import { createStoredZip } from "../src/zip.js";
import { decodeStrictJson } from "../src/json.js";
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

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionArchiveError);
    expect((error as SessionArchiveError).code).toBe(code);
  }
}

async function expectAsyncCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await action();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionArchiveError);
    expect((error as SessionArchiveError).code).toBe(code);
  }
}

describe("portable session archive", () => {
  it("round-trips a report and both original source models exactly", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const opened = await openSessionArchive(request(created.bytes));

    expect(opened.exchange.bundle.report).toEqual(fixture.report);
    for (const [path, source] of fixture.sourceModels) {
      expect(opened.resources.get(path)).toEqual(source);
    }
    expect(opened.exchange.bundle).toEqual(created.bundle);
    expect(opened.exchange.preflight).toEqual(created.preflight);
  });

  it("produces identical bytes for identical accepted input", async () => {
    const fixture = await createSessionFixture();
    const first = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const second = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    expect(second.bytes).toEqual(first.bytes);
    expect(first.preflight.entries.map(({ path }) => path)).toEqual([
      "manifest.json",
      "models/baseline.stl",
      "models/candidate.stl",
      "report.json",
    ]);
  });

  it("rejects unsafe and duplicate paths during structural preflight", () => {
    const traversal = createStoredZip(
      new Map([["../escape", new Uint8Array([1])]]),
    );
    expectCode(() => inspectSessionArchive(request(traversal)), "INVALID_PATH");

    const first = "models/first.stl";
    const second = "models/other.stl";
    const archive = createStoredZip(
      new Map([
        [first, new Uint8Array([1])],
        [second, new Uint8Array([2])],
        ["manifest.json", new Uint8Array([3])],
      ]),
    );
    const duplicate = archive.slice();
    replaceAscii(duplicate, second, first);
    expectCode(
      () => inspectSessionArchive(request(duplicate)),
      "DUPLICATE_PATH",
    );
  });

  it("rejects unsupported compression, trailing bytes, and tampered payloads", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const compressed = created.bytes.slice();
    patchCompressionMethods(compressed, 8);
    expectCode(
      () => inspectSessionArchive(request(compressed)),
      "UNSUPPORTED_ZIP",
    );

    const trailing = new Uint8Array(created.bytes.byteLength + 1);
    trailing.set(created.bytes);
    expectCode(() => inspectSessionArchive(request(trailing)), "INVALID_ZIP");

    const tampered = created.bytes.slice();
    const sourceOffset = findAscii(tampered, "solid baseline");
    tampered[sourceOffset] = tampered[sourceOffset]! ^ 1;
    await expectAsyncCode(
      () => openSessionArchive(request(tampered)),
      "INTEGRITY_ERROR",
    );
  });

  it("rejects duplicate JSON keys and unsupported manifest versions", async () => {
    const duplicateJson = new TextEncoder().encode(
      '{"contractVersion":1,"contractVersion":1}\n',
    );
    const duplicateArchive = createStoredZip(
      new Map([["manifest.json", duplicateJson]]),
    );
    await expectAsyncCode(
      () => openSessionArchive(request(duplicateArchive)),
      "INVALID_JSON",
    );

    const futureJson = new TextEncoder().encode('{"contractVersion":2}\n');
    const futureArchive = createStoredZip(
      new Map([["manifest.json", futureJson]]),
    );
    await expectAsyncCode(
      () => openSessionArchive(request(futureArchive)),
      "UNSUPPORTED_VERSION",
    );
  });

  it("preserves prototype-named keys as inert own properties", () => {
    const parsed = decodeStrictJson(
      new TextEncoder().encode('{"__proto__":{"polluted":true},"x":1}'),
    ) as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.keys(parsed)).toEqual(["__proto__", "x"]);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects whitespace outside the JSON grammar", () => {
    const nonBreakingSpace = "\u00a0";
    expect(() =>
      decodeStrictJson(new TextEncoder().encode(`{"x":${nonBreakingSpace}1}`)),
    ).toThrow(/Invalid JSON/u);
  });

  it("enforces archive, count, entry, aggregate, and structured limits", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    expectCode(
      () =>
        inspectSessionArchive(
          request(created.bytes, { ...testLimits, maxArchiveBytes: 32 }),
        ),
      "INVALID_REQUEST",
    );
    expectCode(
      () =>
        inspectSessionArchive(
          request(created.bytes, { ...testLimits, maxEntries: 3 }),
        ),
      "ARCHIVE_LIMIT",
    );
    expectCode(
      () =>
        inspectSessionArchive(
          request(created.bytes, {
            ...testLimits,
            maxEntryBytes: 32,
            maxManifestBytes: 32,
            maxReportBytes: 32,
          }),
        ),
      "ARCHIVE_LIMIT",
    );
    expectCode(
      () =>
        inspectSessionArchive(
          request(created.bytes, { ...testLimits, maxTotalExpandedBytes: 32 }),
        ),
      "ARCHIVE_LIMIT",
    );
    expectCode(
      () =>
        inspectSessionArchive(
          request(created.bytes, { ...testLimits, maxReportBytes: 32 }),
        ),
      "ARCHIVE_LIMIT",
    );
    await expectAsyncCode(
      () =>
        createSessionArchive({
          ...fixture,
          limits: { ...testLimits, maxEntries: 3 },
        }),
      "ARCHIVE_LIMIT",
    );
    await expectAsyncCode(
      () =>
        createSessionArchive({
          ...fixture,
          limits: {
            ...testLimits,
            maxEntryBytes: 32,
            maxManifestBytes: 32,
            maxReportBytes: 32,
          },
        }),
      "ARCHIVE_LIMIT",
    );
  });

  it("rejects partial views at the transferable request boundary", async () => {
    const fixture = await createSessionFixture();
    const created = await createSessionArchive({
      ...fixture,
      limits: testLimits,
    });
    const backing = new Uint8Array(created.bytes.byteLength + 2);
    backing.set(created.bytes, 1);
    const partial = backing.subarray(1, backing.byteLength - 1);
    expectCode(
      () =>
        inspectSessionArchive({
          contractVersion: 1,
          bytes: partial,
          limits: testLimits,
        }),
      "INVALID_REQUEST",
    );
  });
});

function findAscii(bytes: Uint8Array, text: string): number {
  const needle = new TextEncoder().encode(text);
  outer: for (
    let offset = 0;
    offset <= bytes.byteLength - needle.byteLength;
    offset += 1
  ) {
    for (let index = 0; index < needle.byteLength; index += 1)
      if (bytes[offset + index] !== needle[index]) continue outer;
    return offset;
  }
  throw new Error("Test fixture text not found");
}

function replaceAscii(bytes: Uint8Array, from: string, to: string): void {
  expect(to.length).toBe(from.length);
  const replacement = new TextEncoder().encode(to);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const found = findAscii(bytes.subarray(offset), from);
    bytes.set(replacement, offset + found);
    offset += found + replacement.byteLength;
    if (!new TextDecoder().decode(bytes.subarray(offset)).includes(from)) break;
  }
}

function patchCompressionMethods(bytes: Uint8Array, method: number): void {
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.byteLength - 10; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint16(offset + 8, method, true);
    if (signature === 0x02014b50) view.setUint16(offset + 10, method, true);
  }
}
