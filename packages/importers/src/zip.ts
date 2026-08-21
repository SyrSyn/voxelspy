import { UnsafeArchiveError } from "./errors.js";

// ---------------------------------------------------------------------------
// A defensive, read-only ZIP (OPC container) reader for the 3MF importer.
//
// This is deliberately independent of `@voxelspy/session-archive`'s ZIP
// reader/writer: that package is stored-only by design (a security property
// of the portable-session format), so it must never gain a deflate code
// path. Real-world 3MF files are ordinary ZIP archives and are very
// commonly deflate-compressed, so this module implements its own narrow,
// defensive ZIP reader -- structurally similar in spirit to
// `session-archive`'s (central directory is authoritative, local headers are
// cross-checked, never trusted alone), but permissive of the header fields
// (version-made-by, timestamps, attributes, extra fields) real third-party
// ZIP writers legitimately vary, since this module reads other tools'
// output rather than its own fixed writer profile.
// ---------------------------------------------------------------------------

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const END_RECORD_BYTES = 22;
const CENTRAL_RECORD_FIXED_BYTES = 46;
const LOCAL_RECORD_FIXED_BYTES = 30;
const ZIP64_SENTINEL = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ArchiveSafetyLimits {
  /** Maximum number of ZIP entries. */
  readonly entryCount: number;
  /** Maximum decompressed byte size of any single entry. */
  readonly entryBytes: number;
  /** Maximum decompressed byte size summed across every entry read. */
  readonly expandedBytes: number;
  /** Maximum allowed (decompressed / compressed) ratio for any single entry. */
  readonly compressionRatio: number;
}

export interface ZipEntry {
  readonly path: string;
  readonly method: typeof METHOD_STORED | typeof METHOD_DEFLATE;
  readonly crc32: number;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly dataOffset: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  readonly byName: ReadonlyMap<string, ZipEntry>;
}

/**
 * Reads and defensively validates a ZIP central directory. Returns entry
 * metadata only -- no payload is decompressed or even sliced here, so this
 * function's cost is independent of any entry's (declared) expanded size.
 */
export function readZipCentralDirectory(
  bytes: Uint8Array,
  limits: ArchiveSafetyLimits,
): ZipArchive {
  if (bytes.byteLength < END_RECORD_BYTES) {
    throw new TypeError("3MF input is too small to be a ZIP archive");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // This reader requires the end-of-central-directory record to be the
  // final 22 bytes of the input (no ZIP archive comment, no trailing
  // bytes after the declared archive end). This is a deliberate, documented
  // restriction: real 3MF producers do not rely on a ZIP comment, and
  // trailing bytes after the declared end of a ZIP archive are exactly the
  // kind of "polyglot" construction where different tools disagree about
  // what the file contains -- a security-relevant ambiguity this importer
  // refuses outright rather than guessing which bytes are authoritative.
  const endOffset = bytes.byteLength - END_RECORD_BYTES;
  if (read32(view, endOffset) !== END_SIGNATURE) {
    throw new UnsafeArchiveError(
      "3MF input has a ZIP comment or trailing bytes after its central directory, which is not supported",
    );
  }
  const diskNumber = read16(view, endOffset + 4);
  const centralDiskNumber = read16(view, endOffset + 6);
  const diskEntries = read16(view, endOffset + 8);
  const totalEntries = read16(view, endOffset + 10);
  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    diskEntries !== totalEntries
  ) {
    throw new UnsafeArchiveError("Multi-disk ZIP archives are not supported");
  }
  if (totalEntries === ZIP64_SENTINEL || totalEntries > limits.entryCount) {
    throw new RangeError(
      "3MF archive exceeds the importer's ZIP entry-count safety limit",
    );
  }
  const centralLength = read32(view, endOffset + 12);
  const centralOffset = read32(view, endOffset + 16);
  if (
    centralLength === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL ||
    !Number.isSafeInteger(centralOffset + centralLength) ||
    centralOffset + centralLength !== endOffset
  ) {
    throw new TypeError("3MF ZIP central directory is inconsistent");
  }

  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  const payloadRanges: Array<readonly [number, number]> = [];
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(bytes, offset, CENTRAL_RECORD_FIXED_BYTES);
    if (read32(view, offset) !== CENTRAL_SIGNATURE) {
      throw new TypeError(
        "3MF ZIP central-directory entry has a bad signature",
      );
    }
    const flags = read16(view, offset + 8);
    const method = read16(view, offset + 10);
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      throw new UnsafeArchiveError("Encrypted ZIP entries are not supported");
    }
    if ((flags & 0x8) !== 0) {
      throw new UnsafeArchiveError(
        "Streamed ZIP entries using a trailing data descriptor are not supported; sizes must be given directly in the local and central headers",
      );
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new UnsafeArchiveError(
        `Unsupported ZIP compression method ${method}; only stored (0) and deflate (8) are supported`,
      );
    }
    const crc32Value = read32(view, offset + 16);
    const compressedBytes = read32(view, offset + 20);
    const expandedBytesDeclared = read32(view, offset + 24);
    const nameLength = read16(view, offset + 28);
    const extraLength = read16(view, offset + 30);
    const commentLength = read16(view, offset + 32);
    const diskNumberStart = read16(view, offset + 34);
    const localOffset = read32(view, offset + 42);
    if (
      compressedBytes === ZIP64_SENTINEL ||
      expandedBytesDeclared === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      throw new UnsafeArchiveError(
        "ZIP64 extensions are not supported; every entry must use standard 32-bit ZIP fields",
      );
    }
    if (diskNumberStart !== 0) {
      throw new UnsafeArchiveError("Multi-disk ZIP archives are not supported");
    }
    if (method === METHOD_STORED && compressedBytes !== expandedBytesDeclared) {
      throw new TypeError(
        "3MF ZIP stored entry declares inconsistent compressed/expanded sizes",
      );
    }
    requireRange(bytes, offset + CENTRAL_RECORD_FIXED_BYTES, nameLength);
    const nameBytes = bytes.subarray(
      offset + CENTRAL_RECORD_FIXED_BYTES,
      offset + CENTRAL_RECORD_FIXED_BYTES + nameLength,
    );
    const path = decodeEntryName(nameBytes);
    assertSafeEntryName(path);
    if (byName.has(path)) {
      throw new UnsafeArchiveError(
        `3MF archive contains a duplicate entry name: ${path}`,
      );
    }

    requireRange(bytes, localOffset, LOCAL_RECORD_FIXED_BYTES);
    if (read32(view, localOffset) !== LOCAL_SIGNATURE) {
      throw new TypeError("3MF ZIP local header is missing");
    }
    const localFlags = read16(view, localOffset + 6);
    const localMethod = read16(view, localOffset + 8);
    const localCrc32 = read32(view, localOffset + 14);
    const localCompressedBytes = read32(view, localOffset + 18);
    const localExpandedBytes = read32(view, localOffset + 22);
    const localNameLength = read16(view, localOffset + 26);
    const localExtraLength = read16(view, localOffset + 28);
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localCrc32 !== crc32Value ||
      localCompressedBytes !== compressedBytes ||
      localExpandedBytes !== expandedBytesDeclared ||
      localNameLength !== nameLength
    ) {
      throw new UnsafeArchiveError(
        `3MF ZIP local and central-directory headers disagree for entry: ${path}`,
      );
    }
    requireRange(
      bytes,
      localOffset + LOCAL_RECORD_FIXED_BYTES,
      localNameLength,
    );
    const localName = decodeEntryName(
      bytes.subarray(
        localOffset + LOCAL_RECORD_FIXED_BYTES,
        localOffset + LOCAL_RECORD_FIXED_BYTES + localNameLength,
      ),
    );
    if (localName !== path) {
      throw new UnsafeArchiveError(
        `3MF ZIP local and central-directory entry names disagree: ${path}`,
      );
    }
    const dataOffset =
      localOffset +
      LOCAL_RECORD_FIXED_BYTES +
      localNameLength +
      localExtraLength;
    requireRange(bytes, dataOffset, compressedBytes);
    if (dataOffset + compressedBytes > centralOffset) {
      throw new UnsafeArchiveError(
        `3MF ZIP entry payload overlaps the central directory: ${path}`,
      );
    }

    const entry: ZipEntry = {
      path,
      method: method as typeof METHOD_STORED | typeof METHOD_DEFLATE,
      crc32: crc32Value,
      compressedBytes,
      expandedBytes: expandedBytesDeclared,
      dataOffset,
    };
    entries.push(entry);
    byName.set(path, entry);
    payloadRanges.push([dataOffset, dataOffset + compressedBytes]);

    offset +=
      CENTRAL_RECORD_FIXED_BYTES + nameLength + extraLength + commentLength;
    requireRange(bytes, offset, 0);
  }
  if (offset !== endOffset) {
    throw new TypeError(
      "3MF ZIP central-directory length does not match its entries",
    );
  }

  // Overlap-only check: unlike `@voxelspy/session-archive`'s own fixed
  // writer profile, third-party ZIP writers may legitimately leave small
  // gaps (alignment padding, etc.) between entries, so only overlapping
  // byte ranges -- which could let two different readers disagree about
  // which entry owns a given byte -- are rejected.
  const sorted = [...payloadRanges].sort(([left], [right]) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current[0] < previous[1]) {
      throw new UnsafeArchiveError("3MF ZIP entry payloads overlap");
    }
  }

  return { entries, byName };
}

/**
 * Reads one ZIP entry's payload, decompressing it if necessary, bounded by
 * `limits` and `aggregate` (a running total shared across every entry read
 * from the same archive). Output is verified against the entry's CRC-32.
 *
 * Decompression safety: see `inflateRawBounded` below for how expansion is
 * bounded incrementally rather than after the fact.
 */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  limits: ArchiveSafetyLimits,
  aggregate: { consumedBytes: number },
): Promise<Uint8Array> {
  const compressed = bytes.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedBytes,
  );
  const payload =
    entry.method === METHOD_STORED
      ? compressed.slice()
      : await inflateRawBounded(
          compressed,
          limits.entryBytes,
          limits.compressionRatio,
        );
  if (payload.byteLength > limits.entryBytes) {
    throw new RangeError(
      `3MF archive entry "${entry.path}" exceeds the maximum decompressed entry size`,
    );
  }
  aggregate.consumedBytes += payload.byteLength;
  if (aggregate.consumedBytes > limits.expandedBytes) {
    throw new RangeError(
      "3MF archive exceeds the maximum aggregate decompressed size across all entries",
    );
  }
  if (crc32(payload) !== entry.crc32) {
    throw new TypeError(
      `3MF archive entry "${entry.path}" failed its ZIP CRC-32 integrity check`,
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Bounded deflate decompression
// ---------------------------------------------------------------------------

// Compressed input is fed to `DecompressionStream` in small pieces (rather
// than as one `write()` call) so that a single native transform operation
// can only ever expand a small, bounded amount of input before this module
// gets a chance to read the produced output and check it against the caps
// below. This is what makes the cap enforcement genuinely incremental: a
// decompression bomb is caught after a small, bounded amount of output has
// been produced and held in memory, never after attempting to materialize
// the attacker's full declared (or actual) expansion.
const DEFLATE_WRITE_CHUNK_BYTES = 4_096;

async function inflateRawBounded(
  compressed: Uint8Array,
  capBytes: number,
  ratioLimit: number,
): Promise<Uint8Array> {
  if (compressed.byteLength === 0) return new Uint8Array(0);

  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalOut = 0;

  const writerDone = (async () => {
    try {
      for (
        let offset = 0;
        offset < compressed.byteLength;
        offset += DEFLATE_WRITE_CHUNK_BYTES
      ) {
        // `compressed.subarray(...)` is `Uint8Array<ArrayBufferLike>` in this
        // TypeScript version's lib types (a view could in principle be
        // backed by a `SharedArrayBuffer`), but `WritableStreamDefaultWriter
        // .write`'s `BufferSource` parameter requires the narrower
        // `ArrayBufferView<ArrayBuffer>`. This importer never constructs
        // views over a `SharedArrayBuffer` -- every byte array it handles
        // originates from an `ImportRequest.bytes` value or a slice/subarray
        // of one -- so this is a type-only narrowing cast, not a behavior
        // change; see `apps/web/src/convert.worker.ts`'s identical cast for
        // the same underlying TypeScript limitation.
        await writer.write(
          compressed.subarray(
            offset,
            offset + DEFLATE_WRITE_CHUNK_BYTES,
          ) as Uint8Array<ArrayBuffer>,
        );
      }
      await writer.close();
    } catch {
      // The reader side observes and reports the real failure (either our
      // own cap violation or a stream error from malformed input); nothing
      // further to do here.
    }
  })();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalOut += value.byteLength;
      if (totalOut > capBytes) {
        throw new RangeError(
          "3MF archive entry exceeds the maximum decompressed entry size",
        );
      }
      if (totalOut > compressed.byteLength * ratioLimit) {
        throw new RangeError(
          "3MF archive entry exceeds the maximum allowed compression ratio",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    await writerDone;
    if (error instanceof RangeError) throw error;
    throw new TypeError(
      "3MF archive entry could not be decompressed (malformed deflate data)",
    );
  }
  await writerDone;

  const result = new Uint8Array(totalOut);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.byteLength;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeEntryName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UnsafeArchiveError("3MF ZIP entry name is not valid UTF-8");
  }
}

/**
 * Rejects path traversal and other unsafe ZIP entry names: absolute paths,
 * backslashes, empty segments, `.`/`..` segments, and control characters.
 * OPC part names are always relative, forward-slash-separated paths.
 */
function assertSafeEntryName(path: string): void {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\")
  ) {
    throw new UnsafeArchiveError(`3MF archive entry name is unsafe: ${path}`);
  }
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    // Reject C0 control characters (0x00-0x1F) and DEL (0x7F), checked by
    // code point rather than a regex containing a raw control-character
    // range literal in source.
    if (code <= 0x1f || code === 0x7f) {
      throw new UnsafeArchiveError(`3MF archive entry name is unsafe: ${path}`);
    }
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new UnsafeArchiveError(
        `3MF archive entry name contains path traversal or an empty segment: ${path}`,
      );
    }
  }
}

function requireRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(offset + length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    throw new TypeError("3MF ZIP structure is truncated or out of range");
  }
}

function read16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function read32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

// Standard reflected CRC-32 (IEEE 802.3 / zlib) lookup table, built once at
// module load -- used to verify every decompressed (or stored) ZIP payload
// against its header CRC-32 before it is trusted as archive content.
const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
