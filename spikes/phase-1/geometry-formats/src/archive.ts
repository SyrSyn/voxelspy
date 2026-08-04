import { DEFAULT_LIMITS, type ImportLimits } from "./contracts.ts";

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export async function readZip(
  archive: Uint8Array,
  overrides: Partial<ImportLimits> = {},
  allowUnboundedDeflate = false,
): Promise<readonly ZipEntry[]> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const eocdOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount > limits.maxArchiveEntries) {
    throw new Error(
      `Archive has ${entryCount} entries; limit is ${limits.maxArchiveEntries}`,
    );
  }

  const entries: ZipEntry[] = [];
  let expandedBytes = 0;
  let offset = centralOffset;

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    requireRange(view, offset, 46);
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("Invalid ZIP central directory");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const expandedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    requireRange(view, offset + 46, nameLength + extraLength + commentLength);
    const name = new TextDecoder().decode(
      archive.subarray(offset + 46, offset + 46 + nameLength),
    );
    validateEntryName(name);
    if ((flags & 1) !== 0)
      throw new Error(`Encrypted ZIP entry is unsupported: ${name}`);
    if (method !== 0 && method !== 8)
      throw new Error(`Unsupported ZIP compression method ${method}`);
    if (method === 8 && !allowUnboundedDeflate) {
      throw new Error(
        `Deflated ZIP entry requires explicit unbounded-decompression opt-in: ${name}`,
      );
    }
    if (expandedSize > 0 && compressedSize === 0)
      throw new Error(`Invalid compression sizes for ${name}`);
    if (
      compressedSize > 0 &&
      expandedSize / compressedSize > limits.maxCompressionRatio
    ) {
      throw new Error(`ZIP entry exceeds compression-ratio limit: ${name}`);
    }
    expandedBytes += expandedSize;
    if (expandedBytes > limits.maxExpandedBytes)
      throw new Error("Archive exceeds expanded-byte limit");

    requireRange(view, localOffset, 30);
    if (view.getUint32(localOffset, true) !== 0x04034b50)
      throw new Error("Invalid ZIP local header");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(view, dataOffset, compressedSize);
    const compressed = archive.slice(dataOffset, dataOffset + compressedSize);
    const bytes = method === 0 ? compressed : await inflateRaw(compressed);
    if (bytes.byteLength !== expandedSize)
      throw new Error(`Expanded size mismatch for ${name}`);
    entries.push({ name, bytes });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

function validateEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(name)}`);
  }
  if (name.split("/").some((segment) => segment === "..")) {
    throw new Error(`ZIP entry escapes its archive root: ${name}`);
  }
}

function requireRange(view: DataView, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new Error("Truncated ZIP structure");
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const owned = bytes.slice().buffer as ArrayBuffer;
  const stream = new Blob([owned])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
