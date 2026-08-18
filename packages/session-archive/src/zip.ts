import {
  sessionArchivePreflightSchema,
  sessionPreflightExchangeSchema,
  type SessionArchiveLimits,
} from "@voxelspy/contracts/session";
import { portableResourcePathSchema } from "@voxelspy/contracts/report";

import { SessionArchiveError } from "./error.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;

interface DirectoryEntry {
  path: string;
  crc32: number;
  compressedBytes: number;
  expandedBytes: number;
  localOffset: number;
  dataOffset: number;
}

type SessionArchivePreflight = ReturnType<
  typeof sessionArchivePreflightSchema.parse
>;

export function createStoredZip(
  files: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const ordered = [...files.entries()].sort(([left], [right]) =>
    compareOrdinal(left, right),
  );
  if (ordered.length > 0xffff)
    fail("ARCHIVE_LIMIT", "ZIP entry count exceeds the format limit");
  const records = ordered.map(([path, bytes]) => {
    const name = encoder.encode(path);
    if (name.byteLength > 0xffff)
      fail("INVALID_PATH", "Archive path is too long");
    return { path, name, bytes, crc32: crc32(bytes), localOffset: 0 };
  });
  const localBytes = records.reduce(
    (sum, record) =>
      checkedAdd(sum, 30 + record.name.byteLength + record.bytes.byteLength),
    0,
  );
  const centralBytes = records.reduce(
    (sum, record) => checkedAdd(sum, 46 + record.name.byteLength),
    0,
  );
  const output = new Uint8Array(
    checkedAdd(checkedAdd(localBytes, centralBytes), 22),
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const record of records) {
    record.localOffset = offset;
    write32(view, offset, LOCAL_SIGNATURE);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, UTF8_FLAG);
    write16(view, offset + 8, 0);
    write16(view, offset + 10, 0);
    write16(view, offset + 12, 33);
    write32(view, offset + 14, record.crc32);
    write32(view, offset + 18, record.bytes.byteLength);
    write32(view, offset + 22, record.bytes.byteLength);
    write16(view, offset + 26, record.name.byteLength);
    write16(view, offset + 28, 0);
    output.set(record.name, offset + 30);
    output.set(record.bytes, offset + 30 + record.name.byteLength);
    offset += 30 + record.name.byteLength + record.bytes.byteLength;
  }
  const centralOffset = offset;
  for (const record of records) {
    write32(view, offset, CENTRAL_SIGNATURE);
    write16(view, offset + 4, 20);
    write16(view, offset + 6, 20);
    write16(view, offset + 8, UTF8_FLAG);
    write16(view, offset + 10, 0);
    write16(view, offset + 12, 0);
    write16(view, offset + 14, 33);
    write32(view, offset + 16, record.crc32);
    write32(view, offset + 20, record.bytes.byteLength);
    write32(view, offset + 24, record.bytes.byteLength);
    write16(view, offset + 28, record.name.byteLength);
    write16(view, offset + 30, 0);
    write16(view, offset + 32, 0);
    write16(view, offset + 34, 0);
    write16(view, offset + 36, 0);
    write32(view, offset + 38, 0);
    write32(view, offset + 42, record.localOffset);
    output.set(record.name, offset + 46);
    offset += 46 + record.name.byteLength;
  }
  const centralLength = offset - centralOffset;
  write32(view, offset, END_SIGNATURE);
  write16(view, offset + 4, 0);
  write16(view, offset + 6, 0);
  write16(view, offset + 8, records.length);
  write16(view, offset + 10, records.length);
  write32(view, offset + 12, centralLength);
  write32(view, offset + 16, centralOffset);
  write16(view, offset + 20, 0);
  return output;
}

export function inspectStoredZip(
  bytes: Uint8Array,
  limits: SessionArchiveLimits,
): { preflight: SessionArchivePreflight; entries: readonly DirectoryEntry[] } {
  if (bytes.byteLength > limits.maxArchiveBytes)
    fail("ARCHIVE_LIMIT", "Session archive exceeds its compressed-byte limit");
  if (bytes.byteLength < 22)
    fail("INVALID_ZIP", "Session archive is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = bytes.byteLength - 22;
  if (read32(view, endOffset) !== END_SIGNATURE)
    fail("INVALID_ZIP", "ZIP end record must terminate the archive");
  if (read16(view, endOffset + 4) !== 0 || read16(view, endOffset + 6) !== 0)
    fail("UNSUPPORTED_ZIP", "Multi-disk ZIP archives are not supported");
  const diskEntries = read16(view, endOffset + 8);
  const totalEntries = read16(view, endOffset + 10);
  if (diskEntries !== totalEntries)
    fail("UNSUPPORTED_ZIP", "Multi-disk ZIP archives are not supported");
  if (read16(view, endOffset + 20) !== 0)
    fail("INVALID_ZIP", "ZIP comments and trailing data are not accepted");
  if (totalEntries > limits.maxEntries)
    fail("ARCHIVE_LIMIT", "Session archive exceeds its entry-count limit");
  const centralLength = read32(view, endOffset + 12);
  const centralOffset = read32(view, endOffset + 16);
  if (
    centralOffset + centralLength !== endOffset ||
    !Number.isSafeInteger(centralOffset + centralLength)
  )
    fail("INVALID_ZIP", "ZIP central directory is inconsistent");

  const entries: DirectoryEntry[] = [];
  const paths = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(bytes, offset, 46);
    if (read32(view, offset) !== CENTRAL_SIGNATURE)
      fail("INVALID_ZIP", "Invalid ZIP central-directory entry");
    const versionMadeBy = read16(view, offset + 4);
    const versionNeeded = read16(view, offset + 6);
    const flags = read16(view, offset + 8);
    const method = read16(view, offset + 10);
    const modTime = read16(view, offset + 12);
    const modDate = read16(view, offset + 14);
    if ((flags & 1) !== 0)
      fail("UNSUPPORTED_ZIP", "Encrypted ZIP entries are not supported");
    if ((flags & 8) !== 0)
      fail("UNSUPPORTED_ZIP", "ZIP data descriptors are not supported");
    if (flags !== UTF8_FLAG)
      fail(
        "UNSUPPORTED_ZIP",
        "ZIP entries must use the version 1 UTF-8 flag profile",
      );
    if (method !== 0)
      fail("UNSUPPORTED_ZIP", "Only stored ZIP entries are supported");
    if (versionMadeBy !== 20 || versionNeeded !== 20)
      fail(
        "UNSUPPORTED_ZIP",
        "ZIP entries must use the version 1 header-version profile",
      );
    if (modTime !== 0 || modDate !== 33)
      fail(
        "UNSUPPORTED_ZIP",
        "ZIP entries must use the version 1 fixed-timestamp profile",
      );
    const internalAttributes = read16(view, offset + 36);
    const externalAttributes = read32(view, offset + 38);
    if (internalAttributes !== 0 || externalAttributes !== 0)
      fail(
        "UNSUPPORTED_ZIP",
        "ZIP entries must use the version 1 fixed-attributes profile",
      );
    const compressedBytes = read32(view, offset + 20);
    const expandedBytes = read32(view, offset + 24);
    const nameLength = read16(view, offset + 28);
    const extraLength = read16(view, offset + 30);
    const commentLength = read16(view, offset + 32);
    const localOffset = read32(view, offset + 42);
    if (extraLength !== 0 || commentLength !== 0)
      fail(
        "UNSUPPORTED_ZIP",
        "ZIP extra fields and per-entry comments are not supported",
      );
    if (read16(view, offset + 34) !== 0)
      fail("UNSUPPORTED_ZIP", "Multi-disk ZIP entries are not supported");
    requireRange(bytes, offset + 46, nameLength + extraLength + commentLength);
    const path = decodePath(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (!portableResourcePathSchema.safeParse(path).success)
      fail("INVALID_PATH", "Archive path is not canonical and relative");
    if (paths.has(path))
      fail("DUPLICATE_PATH", "Archive contains a duplicate path");
    paths.add(path);
    if (compressedBytes !== expandedBytes)
      fail("INVALID_ZIP", "Stored ZIP entry sizes are inconsistent");
    requireRange(bytes, localOffset, 30);
    if (read32(view, localOffset) !== LOCAL_SIGNATURE)
      fail("INVALID_ZIP", "ZIP local header is missing");
    const localVersionNeeded = read16(view, localOffset + 4);
    const localFlags = read16(view, localOffset + 6);
    const localMethod = read16(view, localOffset + 8);
    const localModTime = read16(view, localOffset + 10);
    const localModDate = read16(view, localOffset + 12);
    const localNameLength = read16(view, localOffset + 26);
    const localExtraLength = read16(view, localOffset + 28);
    if (localExtraLength !== 0)
      fail("UNSUPPORTED_ZIP", "ZIP local extra fields are not supported");
    if (localVersionNeeded !== 20)
      fail(
        "UNSUPPORTED_ZIP",
        "ZIP entries must use the version 1 header-version profile",
      );
    if (localModTime !== 0 || localModDate !== 33)
      fail(
        "UNSUPPORTED_ZIP",
        "ZIP entries must use the version 1 fixed-timestamp profile",
      );
    if (
      localFlags !== flags ||
      localMethod !== method ||
      read32(view, localOffset + 14) !== read32(view, offset + 16) ||
      read32(view, localOffset + 18) !== compressedBytes ||
      read32(view, localOffset + 22) !== expandedBytes
    )
      fail("INVALID_ZIP", "ZIP local and central headers disagree");
    requireRange(bytes, localOffset + 30, localNameLength + localExtraLength);
    const localPath = decodePath(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (localPath !== path)
      fail("INVALID_ZIP", "ZIP local and central paths disagree");
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(bytes, dataOffset, compressedBytes);
    if (dataOffset + compressedBytes > centralOffset)
      fail("INVALID_ZIP", "ZIP payload overlaps its central directory");
    entries.push({
      path,
      crc32: read32(view, offset + 16),
      compressedBytes,
      expandedBytes,
      localOffset,
      dataOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== endOffset)
    fail(
      "INVALID_ZIP",
      "ZIP central-directory length does not match its entries",
    );
  const ranges = entries
    .map(
      (entry) =>
        [entry.localOffset, entry.dataOffset + entry.compressedBytes] as const,
    )
    .sort(([left], [right]) => left - right);
  if (ranges.length > 0 && ranges[0]![0] !== 0)
    fail("INVALID_ZIP", "ZIP contains unlisted leading data");
  for (let index = 1; index < ranges.length; index += 1)
    if (ranges[index]![0] < ranges[index - 1]![1])
      fail("INVALID_ZIP", "ZIP entries overlap");
  for (let index = 1; index < ranges.length; index += 1)
    if (ranges[index]![0] !== ranges[index - 1]![1])
      fail("INVALID_ZIP", "ZIP contains unlisted data between entries");
  if ((ranges.at(-1)?.[1] ?? 0) !== centralOffset)
    fail("INVALID_ZIP", "ZIP contains unlisted data before its directory");

  const preflight = sessionArchivePreflightSchema.parse({
    archiveBytes: bytes.byteLength,
    entries: entries.map((entry) => ({
      path: entry.path,
      compressedBytes: entry.compressedBytes,
      expandedBytes: entry.expandedBytes,
      compression: "stored" as const,
      encrypted: false as const,
    })),
  });
  const policy = sessionPreflightExchangeSchema.safeParse({
    limits,
    preflight,
  });
  if (!policy.success) {
    // A structurally valid ZIP that never had a manifest.json entry is not a
    // session archive at all — that is a different, non-limit failure from a
    // session archive that legitimately exceeds the caller's resource
    // limits, and callers should be able to tell the two apart.
    const hasSingleManifest =
      preflight.entries.filter((entry) => entry.path === "manifest.json")
        .length === 1;
    if (!hasSingleManifest)
      fail(
        "INVALID_MANIFEST",
        "Archive does not contain a single session manifest.json entry",
      );
    fail(
      "ARCHIVE_LIMIT",
      "Session archive does not satisfy the supplied resource limits",
    );
  }
  return { preflight, entries };
}

export function extractStoredZip(
  bytes: Uint8Array,
  entries: readonly DirectoryEntry[],
): ReadonlyMap<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const payload = bytes.slice(
      entry.dataOffset,
      entry.dataOffset + entry.expandedBytes,
    );
    if (crc32(payload) !== entry.crc32)
      fail("INTEGRITY_ERROR", "ZIP payload checksum verification failed");
    result.set(entry.path, payload);
  }
  return result;
}

// Standard reflected CRC-32 (IEEE 802.3 / zlib) lookup table, built once at
// module load. A table-driven pass is roughly an order of magnitude faster
// than the equivalent bit-at-a-time loop for the buffer sizes this package
// hashes (whole model files), while producing byte-for-byte identical
// results — see the crc32 tests that pin known vectors and property-compare
// this implementation against the previous bit-loop.
const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1)
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePath(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    fail("INVALID_PATH", "Archive path is not valid UTF-8");
  }
}
function requireRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset + length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  )
    fail("INVALID_ZIP", "ZIP structure is truncated");
}
export function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > 0xffffffff)
    fail("ARCHIVE_LIMIT", "ZIP size exceeds the version 1 format limit");
  return value;
}
function read16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function read32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}
function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}
function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function fail(
  code: ConstructorParameters<typeof SessionArchiveError>[0],
  message: string,
): never {
  throw new SessionArchiveError(code, message);
}
