import { strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";

import { sha256, type CanonicalEvidence } from "./canonical.js";
import { renderFigureSvg, stableJson } from "./export.js";
import { parseVersionedReport, type Report } from "./schema.js";

const fixedZipDate = new Date("1980-01-01T00:00:00.000Z");
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SessionLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const defaultSessionLimits: Readonly<SessionLimits> = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 32,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalUncompressedBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
};

const archivePath = z
  .string()
  .min(1)
  .max(240)
  .refine(isSafeArchivePath, "Archive path must be normalized and relative");

export const sessionManifestSchema = z.object({
  schema: z.literal("https://voxelspy.dev/schemas/session-manifest/v1"),
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  reportPath: z.literal("report.json"),
  entries: z
    .array(
      z.object({
        path: archivePath,
        mediaType: z.string().min(1).max(120),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(4)
    .max(31),
});

export type SessionManifest = z.infer<typeof sessionManifestSchema>;

export interface ImportedSession {
  manifest: SessionManifest;
  report: Report;
  files: ReadonlyMap<string, Uint8Array>;
}

interface ZipDirectoryEntry {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

function zipValue(bytes: Uint8Array): [Uint8Array, { mtime: Date }] {
  return [bytes, { mtime: fixedZipDate }];
}

function isSafeArchivePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[a-zA-Z]:/.test(path)
  )
    return false;
  const components = path.split("/");
  return components.every(
    (component) => component !== "" && component !== "." && component !== "..",
  );
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.byteLength) throw new Error("Truncated ZIP structure");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) throw new Error("Truncated ZIP structure");
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUInt32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

export function inspectZip(
  bytes: Uint8Array,
  limits: SessionLimits = defaultSessionLimits,
): readonly ZipDirectoryEntry[] {
  if (bytes.byteLength > limits.maxArchiveBytes)
    throw new Error("Session archive exceeds compressed size limit");
  const endOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = readUInt16(bytes, endOffset + 4);
  const directoryDisk = readUInt16(bytes, endOffset + 6);
  const diskEntries = readUInt16(bytes, endOffset + 8);
  const totalEntries = readUInt16(bytes, endOffset + 10);
  const directoryBytes = readUInt32(bytes, endOffset + 12);
  const directoryOffset = readUInt32(bytes, endOffset + 16);
  const commentBytes = readUInt16(bytes, endOffset + 20);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries)
    throw new Error("Multi-disk ZIP archives are not supported");
  if (endOffset + 22 + commentBytes !== bytes.byteLength)
    throw new Error("Trailing or truncated ZIP data is not accepted");
  if (totalEntries > limits.maxEntries)
    throw new Error("Session archive entry count exceeds limit");
  if (directoryOffset + directoryBytes > endOffset)
    throw new Error("ZIP central directory is outside the archive");

  const entries: ZipDirectoryEntry[] = [];
  const names = new Set<string>();
  let totalUncompressed = 0;
  let offset = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(bytes, offset) !== 0x02014b50)
      throw new Error("Invalid ZIP central-directory entry");
    const flags = readUInt16(bytes, offset + 8);
    const compressionMethod = readUInt16(bytes, offset + 10);
    const compressedBytes = readUInt32(bytes, offset + 20);
    const uncompressedBytes = readUInt32(bytes, offset + 24);
    const nameBytes = readUInt16(bytes, offset + 28);
    const extraBytes = readUInt16(bytes, offset + 30);
    const entryCommentBytes = readUInt16(bytes, offset + 32);
    const localHeaderOffset = readUInt32(bytes, offset + 42);
    if ((flags & 1) !== 0)
      throw new Error("Encrypted ZIP entries are not supported");
    if (compressionMethod !== 0 && compressionMethod !== 8)
      throw new Error("Unsupported ZIP compression method");
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameBytes;
    if (nameEnd > bytes.byteLength) throw new Error("Truncated ZIP entry name");
    const path = decoder.decode(bytes.subarray(nameStart, nameEnd));
    if (!isSafeArchivePath(path))
      throw new Error(`Unsafe archive path: ${path}`);
    if (names.has(path)) throw new Error(`Duplicate archive path: ${path}`);
    names.add(path);
    if (uncompressedBytes > limits.maxEntryBytes)
      throw new Error(`Archive entry exceeds size limit: ${path}`);
    totalUncompressed += uncompressedBytes;
    if (totalUncompressed > limits.maxTotalUncompressedBytes)
      throw new Error("Session archive exceeds total uncompressed size limit");
    const ratio = uncompressedBytes / Math.max(1, compressedBytes);
    if (ratio > limits.maxCompressionRatio)
      throw new Error(`Archive entry exceeds compression ratio limit: ${path}`);

    if (readUInt32(bytes, localHeaderOffset) !== 0x04034b50)
      throw new Error(`Missing ZIP local header: ${path}`);
    const localMethod = readUInt16(bytes, localHeaderOffset + 8);
    const localNameBytes = readUInt16(bytes, localHeaderOffset + 26);
    const localExtraBytes = readUInt16(bytes, localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    const localNameEnd = localNameStart + localNameBytes;
    if (
      localMethod !== compressionMethod ||
      decoder.decode(bytes.subarray(localNameStart, localNameEnd)) !== path
    ) {
      throw new Error(`ZIP local and central headers disagree: ${path}`);
    }
    if (localNameEnd + localExtraBytes + compressedBytes > directoryOffset)
      throw new Error(`ZIP entry data is outside archive bounds: ${path}`);

    entries.push({
      path,
      compressedBytes,
      uncompressedBytes,
      compressionMethod,
      localHeaderOffset,
    });
    offset = nameEnd + extraBytes + entryCommentBytes;
  }
  if (offset !== directoryOffset + directoryBytes)
    throw new Error("ZIP central-directory length mismatch");
  return entries;
}

export function createSession(evidence: CanonicalEvidence): Uint8Array {
  const reportBytes = strToU8(stableJson(evidence.report));
  const figure = evidence.report.figures[0];
  if (figure === undefined) throw new Error("At least one figure is required");
  const files = new Map<string, { bytes: Uint8Array; mediaType: string }>([
    ["report.json", { bytes: reportBytes, mediaType: "application/json" }],
    [
      "figures/overview.svg",
      { bytes: strToU8(renderFigureSvg(figure)), mediaType: "image/svg+xml" },
    ],
  ]);
  for (const model of evidence.report.models) {
    const bytes = evidence.models.get(model.archivePath);
    if (bytes === undefined)
      throw new Error(`Missing source model: ${model.archivePath}`);
    if (sha256(bytes) !== model.sha256)
      throw new Error(`Source model hash mismatch: ${model.archivePath}`);
    files.set(model.archivePath, { bytes, mediaType: model.mediaType });
  }
  const manifest: SessionManifest = sessionManifestSchema.parse({
    schema: "https://voxelspy.dev/schemas/session-manifest/v1",
    schemaVersion: 1,
    createdAt: evidence.report.generatedAt,
    reportPath: "report.json",
    entries: [...files.entries()]
      .map(([path, file]) => ({
        path,
        mediaType: file.mediaType,
        bytes: file.bytes.byteLength,
        sha256: sha256(file.bytes),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  const archiveEntries: Record<string, [Uint8Array, { mtime: Date }]> = {
    "manifest.json": zipValue(strToU8(stableJson(manifest))),
  };
  for (const [path, file] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    archiveEntries[path] = zipValue(file.bytes);
  }
  return zipSync(archiveEntries, { level: 6 });
}

export function importSession(
  bytes: Uint8Array,
  limits: SessionLimits = defaultSessionLimits,
): ImportedSession {
  const directory = inspectZip(bytes, limits);
  if (!directory.some(({ path }) => path === "manifest.json"))
    throw new Error("Session manifest is missing");
  let inflated: Record<string, Uint8Array>;
  try {
    inflated = unzipSync(bytes);
  } catch (error) {
    throw new Error("Session archive decompression failed", { cause: error });
  }
  const manifestBytes = inflated["manifest.json"];
  if (manifestBytes === undefined)
    throw new Error("Session manifest is missing");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(decoder.decode(manifestBytes));
  } catch (error) {
    throw new Error("Session manifest is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  if (
    typeof manifestValue !== "object" ||
    manifestValue === null ||
    (manifestValue as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error(
      `Unsupported session schema version: ${String((manifestValue as { schemaVersion?: unknown } | null)?.schemaVersion)}`,
    );
  }
  const manifest = sessionManifestSchema.parse(manifestValue);
  const listedPaths = new Set(manifest.entries.map(({ path }) => path));
  const archivePaths = new Set(
    directory
      .map(({ path }) => path)
      .filter((path) => path !== "manifest.json"),
  );
  if (
    listedPaths.size !== manifest.entries.length ||
    listedPaths.size !== archivePaths.size ||
    [...listedPaths].some((path) => !archivePaths.has(path))
  ) {
    throw new Error("Manifest entries do not exactly match archive contents");
  }
  const files = new Map<string, Uint8Array>();
  for (const expected of manifest.entries) {
    const file = inflated[expected.path];
    if (
      file === undefined ||
      file.byteLength !== expected.bytes ||
      sha256(file) !== expected.sha256
    ) {
      throw new Error(
        `Session entry failed size or hash verification: ${expected.path}`,
      );
    }
    files.set(expected.path, file);
  }
  const reportBytes = files.get(manifest.reportPath);
  if (reportBytes === undefined) throw new Error("Session report is missing");
  let reportValue: unknown;
  try {
    reportValue = JSON.parse(decoder.decode(reportBytes));
  } catch (error) {
    throw new Error("Session report is not valid UTF-8 JSON", { cause: error });
  }
  const report = parseVersionedReport(reportValue);
  for (const model of report.models) {
    const source = files.get(model.archivePath);
    if (source === undefined || sha256(source) !== model.sha256)
      throw new Error(
        `Report source model is missing or changed: ${model.archivePath}`,
      );
  }
  return { manifest, report, files };
}
