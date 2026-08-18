import { describe, expect, it } from "vitest";
import type { SessionArchiveLimits } from "@voxelspy/contracts";

import { SessionArchiveError } from "../src/index.js";
import {
  checkedAdd,
  createStoredZip,
  crc32,
  inspectStoredZip,
} from "../src/zip.js";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const encoder = new TextEncoder();
function text(value: string): Uint8Array {
  return encoder.encode(value);
}

// Deliberately generous limits: these tests exercise the byte-level ZIP
// profile directly (via inspectStoredZip), not the session-archive resource
// policy, so the caller limits themselves should never be the reason a case
// passes or fails here.
const permissiveLimits: SessionArchiveLimits = {
  maxArchiveBytes: 16 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalExpandedBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 1_000,
  maxManifestBytes: 16 * 1024 * 1024,
  maxReportBytes: 16 * 1024 * 1024,
};

function expectZipCode(bytes: Uint8Array, code: string): void {
  try {
    inspectStoredZip(bytes, permissiveLimits);
    throw new Error("Expected inspectStoredZip to reject the archive");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionArchiveError);
    expect((error as SessionArchiveError).code).toBe(code);
  }
}

function signatureOffsets(bytes: Uint8Array, signature: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1)
    if (view.getUint32(offset, true) === signature) offsets.push(offset);
  return offsets;
}
function setU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    offset,
    value,
    true,
  );
}
function setU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value,
    true,
  );
}
function getU32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

/** Two-entry stored ZIP built with createStoredZip, used as the base fixture
 * for byte-level field patches below. Payload text avoids the two ZIP
 * signature byte sequences so naive signature scanning stays unambiguous. */
function twoEntryArchive(): {
  bytes: Uint8Array;
  locals: number[];
  centrals: number[];
} {
  const bytes = createStoredZip(
    new Map([
      ["models/one", text("one-content")],
      ["models/two", text("two-content")],
    ]),
  );
  return {
    bytes,
    locals: signatureOffsets(bytes, LOCAL_SIGNATURE),
    centrals: signatureOffsets(bytes, CENTRAL_SIGNATURE),
  };
}

// ---------------------------------------------------------------------------
// Raw layout builder: writes local/central headers at explicit, independently
// chosen offsets so tests can construct byte ranges that overlap or leave
// unlisted gaps -- constructions createStoredZip cannot produce, since it
// always lays entries out contiguously.
// ---------------------------------------------------------------------------
interface RawEntry {
  path: string;
  data: Uint8Array;
  localOffset: number;
}

function nameOf(path: string): Uint8Array {
  return encoder.encode(path);
}

function writeLocalBlock(
  buffer: Uint8Array,
  view: DataView,
  offset: number,
  path: string,
  data: Uint8Array,
): void {
  const name = nameOf(path);
  const crc = crc32(data);
  view.setUint32(offset, LOCAL_SIGNATURE, true);
  view.setUint16(offset + 4, 20, true);
  view.setUint16(offset + 6, 0x0800, true);
  view.setUint16(offset + 8, 0, true);
  view.setUint16(offset + 10, 0, true);
  view.setUint16(offset + 12, 33, true);
  view.setUint32(offset + 14, crc, true);
  view.setUint32(offset + 18, data.byteLength, true);
  view.setUint32(offset + 22, data.byteLength, true);
  view.setUint16(offset + 26, name.byteLength, true);
  view.setUint16(offset + 28, 0, true);
  buffer.set(name, offset + 30);
  buffer.set(data, offset + 30 + name.byteLength);
}

function writeCentralRecord(
  buffer: Uint8Array,
  view: DataView,
  offset: number,
  path: string,
  data: Uint8Array,
  localOffset: number,
): void {
  const name = nameOf(path);
  const crc = crc32(data);
  view.setUint32(offset, CENTRAL_SIGNATURE, true);
  view.setUint16(offset + 4, 20, true);
  view.setUint16(offset + 6, 20, true);
  view.setUint16(offset + 8, 0x0800, true);
  view.setUint16(offset + 10, 0, true);
  view.setUint16(offset + 12, 0, true);
  view.setUint16(offset + 14, 33, true);
  view.setUint32(offset + 16, crc, true);
  view.setUint32(offset + 20, data.byteLength, true);
  view.setUint32(offset + 24, data.byteLength, true);
  view.setUint16(offset + 28, name.byteLength, true);
  view.setUint16(offset + 30, 0, true);
  view.setUint16(offset + 32, 0, true);
  view.setUint16(offset + 34, 0, true);
  view.setUint16(offset + 36, 0, true);
  view.setUint32(offset + 38, 0, true);
  view.setUint32(offset + 42, localOffset, true);
  buffer.set(name, offset + 46);
}

function buildLayoutZip(
  entries: RawEntry[],
  options: { centralOffset?: number } = {},
): Uint8Array {
  const blockEnd = (entry: RawEntry) =>
    entry.localOffset +
    30 +
    nameOf(entry.path).byteLength +
    entry.data.byteLength;
  const physicalEnd = Math.max(0, ...entries.map(blockEnd));
  const centralOffset = options.centralOffset ?? physicalEnd;
  const centralEntryLength = (path: string) => 46 + nameOf(path).byteLength;
  const centralLength = entries.reduce(
    (sum, entry) => sum + centralEntryLength(entry.path),
    0,
  );
  const endOffset = centralOffset + centralLength;
  const totalLength = Math.max(endOffset + 22, physicalEnd);
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer);
  for (const entry of entries)
    writeLocalBlock(buffer, view, entry.localOffset, entry.path, entry.data);
  let offset = centralOffset;
  for (const entry of entries) {
    writeCentralRecord(
      buffer,
      view,
      offset,
      entry.path,
      entry.data,
      entry.localOffset,
    );
    offset += centralEntryLength(entry.path);
  }
  view.setUint32(endOffset, 0x06054b50, true);
  view.setUint16(endOffset + 4, 0, true);
  view.setUint16(endOffset + 6, 0, true);
  view.setUint16(endOffset + 8, entries.length, true);
  view.setUint16(endOffset + 10, entries.length, true);
  view.setUint32(endOffset + 12, centralLength, true);
  view.setUint32(endOffset + 16, centralOffset, true);
  view.setUint16(endOffset + 20, 0, true);
  return buffer;
}

describe("stored ZIP writer output validates under the reader's strict profile", () => {
  it("accepts a freshly written archive without any patching", () => {
    // inspectStoredZip's final policy check requires exactly one
    // manifest.json entry, so this dedicated fixture includes one (unlike
    // twoEntryArchive(), which intentionally omits it since every other test
    // in this file expects to fail before that final check is reached).
    const bytes = createStoredZip(
      new Map([
        ["manifest.json", text("{}")],
        ["models/one", text("one-content")],
        ["models/two", text("two-content")],
      ]),
    );
    const { preflight } = inspectStoredZip(bytes, permissiveLimits);
    expect(preflight.entries.map(({ path }) => path)).toEqual([
      "manifest.json",
      "models/one",
      "models/two",
    ]);
  });
});

describe("byte-range overlap and unlisted-gap detection", () => {
  it("rejects entries whose declared byte ranges overlap", () => {
    // Entry "a"'s header+name occupy [0, 31); entry "b" is placed at 31, so
    // it stomps only entry "a"'s (unvalidated-at-this-stage) payload bytes,
    // while both entries independently parse as fully self-consistent
    // local/central header pairs. Their declared ranges are [0,35) and
    // [31,66) -- a genuine overlap the structural check must catch.
    const dataA = text("AAAA");
    const dataB = text("BBBB");
    const bytes = buildLayoutZip([
      { path: "a", data: dataA, localOffset: 0 },
      { path: "b", data: dataB, localOffset: 31 },
    ]);
    expectZipCode(bytes, "INVALID_ZIP");
  });

  it("rejects archives with unlisted data between entries", () => {
    const dataA = text("AAAA");
    const dataB = text("BBBB");
    // Entry "a" occupies [0,35); entry "b" is placed at 39, leaving 4
    // unaccounted bytes that belong to no listed entry.
    const bytes = buildLayoutZip([
      { path: "a", data: dataA, localOffset: 0 },
      { path: "b", data: dataB, localOffset: 39 },
    ]);
    expectZipCode(bytes, "INVALID_ZIP");
  });

  it("rejects archives with unlisted leading data before the first entry", () => {
    const dataA = text("AAAA");
    const bytes = buildLayoutZip([{ path: "a", data: dataA, localOffset: 4 }]);
    expectZipCode(bytes, "INVALID_ZIP");
  });

  it("rejects archives with unlisted data before the central directory", () => {
    const dataA = text("AAAA");
    // Entry "a" ends physically at 35, but the central directory is placed
    // at 39, leaving a 4-byte gap the entry ranges never account for.
    const bytes = buildLayoutZip([{ path: "a", data: dataA, localOffset: 0 }], {
      centralOffset: 39,
    });
    expectZipCode(bytes, "INVALID_ZIP");
  });
});

describe("rejected ZIP features", () => {
  it("rejects an encrypted-flag entry", () => {
    const { bytes, centrals } = twoEntryArchive();
    setU16(bytes, centrals[0]! + 8, 0x0800 | 1);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });

  it("rejects a data-descriptor-flag entry", () => {
    const { bytes, centrals } = twoEntryArchive();
    setU16(bytes, centrals[0]! + 8, 0x0800 | 8);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });

  it("rejects a multi-disk end record (nonzero disk number)", () => {
    const { bytes } = twoEntryArchive();
    const endOffset = bytes.byteLength - 22;
    setU16(bytes, endOffset + 4, 1);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });

  it("rejects a multi-disk end record (entries-on-disk mismatch)", () => {
    const { bytes } = twoEntryArchive();
    const endOffset = bytes.byteLength - 22;
    setU16(bytes, endOffset + 8, 1);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });

  it("rejects a nonzero end-of-central-directory comment length", () => {
    const { bytes } = twoEntryArchive();
    const endOffset = bytes.byteLength - 22;
    setU16(bytes, endOffset + 20, 1);
    expectZipCode(bytes, "INVALID_ZIP");
  });

  it("rejects a nonzero central per-entry extra-field length", () => {
    const { bytes, centrals } = twoEntryArchive();
    setU16(bytes, centrals[0]! + 30, 4);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });

  it("rejects a nonzero central per-entry comment length", () => {
    const { bytes, centrals } = twoEntryArchive();
    setU16(bytes, centrals[0]! + 32, 4);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });

  it("rejects a nonzero local extra-field length", () => {
    const { bytes, locals } = twoEntryArchive();
    setU16(bytes, locals[0]! + 28, 4);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });
});

describe("strict version, timestamp, and attribute profile", () => {
  it.each([
    {
      label: "central version-made-by",
      offset: 4,
      size: 2 as const,
      value: 45,
    },
    { label: "central version-needed", offset: 6, size: 2 as const, value: 45 },
    { label: "central mod-time", offset: 12, size: 2 as const, value: 1 },
    { label: "central mod-date", offset: 14, size: 2 as const, value: 1 },
    {
      label: "central internal attributes",
      offset: 36,
      size: 2 as const,
      value: 1,
    },
    {
      label: "central external attributes",
      offset: 38,
      size: 4 as const,
      value: 1,
    },
  ])("rejects a deviating $label field", ({ offset, size, value }) => {
    const { bytes, centrals } = twoEntryArchive();
    if (size === 2) setU16(bytes, centrals[0]! + offset, value);
    else setU32(bytes, centrals[0]! + offset, value);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });

  it.each([
    { label: "local version-needed", offset: 4, value: 45 },
    { label: "local mod-time", offset: 10, value: 1 },
    { label: "local mod-date", offset: 12, value: 1 },
  ])("rejects a deviating $label field", ({ offset, value }) => {
    const { bytes, locals } = twoEntryArchive();
    setU16(bytes, locals[0]! + offset, value);
    expectZipCode(bytes, "UNSUPPORTED_ZIP");
  });
});

describe("local vs. central header disagreement", () => {
  it("rejects a CRC-32 disagreement", () => {
    const { bytes, centrals } = twoEntryArchive();
    setU32(bytes, centrals[0]! + 16, getU32(bytes, centrals[0]! + 16) ^ 1);
    expectZipCode(bytes, "INVALID_ZIP");
  });

  it("rejects a compressed-size disagreement", () => {
    const { bytes, locals } = twoEntryArchive();
    setU32(bytes, locals[0]! + 18, getU32(bytes, locals[0]! + 18) + 1);
    expectZipCode(bytes, "INVALID_ZIP");
  });

  it("rejects an expanded-size disagreement", () => {
    const { bytes, locals } = twoEntryArchive();
    setU32(bytes, locals[0]! + 22, getU32(bytes, locals[0]! + 22) + 1);
    expectZipCode(bytes, "INVALID_ZIP");
  });

  it("rejects a name disagreement between the local and central headers", () => {
    const { bytes, locals } = twoEntryArchive();
    // "models/one" -> "models/ona": same byte length, different content, so
    // only the localPath !== path branch can be responsible.
    const nameLength = new DataView(bytes.buffer).getUint16(
      locals[0]! + 26,
      true,
    );
    bytes.set(text("models/ona"), locals[0]! + 30);
    expect(nameLength).toBe(text("models/one").byteLength);
    expectZipCode(bytes, "INVALID_ZIP");
  });
});

describe("crc32", () => {
  it("matches the standard CRC-32 (IEEE 802.3 / zlib) check vector", () => {
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
  });

  it("returns zero for an empty buffer", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("matches a reference bit-at-a-time implementation across varied buffers", () => {
    // Reference implementation kept local to this test (deliberately not the
    // production implementation) so the table-driven crc32 in src/zip.ts can
    // be property-compared against it before anyone deletes the historical
    // bit-loop from memory. The two must agree byte-for-byte for every input.
    function referenceCrc32(bytes: Uint8Array): number {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1)
          crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
      return (crc ^ 0xffffffff) >>> 0;
    }
    let seed = 42;
    function nextByte(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    }
    for (const length of [0, 1, 2, 3, 4, 15, 16, 17, 255, 256, 257, 1_000]) {
      const buffer = new Uint8Array(length);
      for (let index = 0; index < length; index += 1)
        buffer[index] = nextByte();
      expect(crc32(buffer)).toBe(referenceCrc32(buffer));
    }
  });
});

describe("checkedAdd overflow guard", () => {
  it("returns the sum for in-range values", () => {
    expect(checkedAdd(10, 20)).toBe(30);
    expect(checkedAdd(0, 0xffffffff)).toBe(0xffffffff);
  });

  it("rejects sums beyond the version 1 ZIP format's 4 GiB - 1 ceiling", () => {
    expect(() => checkedAdd(0xffffffff, 1)).toThrow(SessionArchiveError);
    try {
      checkedAdd(0xffffffff, 1);
    } catch (error) {
      expect((error as SessionArchiveError).code).toBe("ARCHIVE_LIMIT");
    }
  });

  it("rejects sums beyond Number.MAX_SAFE_INTEGER", () => {
    expect(() => checkedAdd(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      SessionArchiveError,
    );
  });
});

describe("writer entry-count ceiling", () => {
  it("rejects more than 65,535 entries", () => {
    // Cheap to construct: 65,536 entries with empty payloads, well under any
    // memory concern, but one past the 16-bit ZIP entry-count field's limit.
    const files = new Map<string, Uint8Array>();
    for (let index = 0; index <= 0xffff; index += 1)
      files.set(`f${index}`, new Uint8Array(0));
    expect(files.size).toBe(0x10000);
    try {
      createStoredZip(files);
      throw new Error("Expected createStoredZip to reject the entry count");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionArchiveError);
      expect((error as SessionArchiveError).code).toBe("ARCHIVE_LIMIT");
    }
  });
});
