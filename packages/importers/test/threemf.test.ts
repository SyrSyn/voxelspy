import { importRequestSchema, type ImportOptions } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import { exportModel, importModel } from "../src/index.js";
import {
  normalizePositions,
  sourceToModelTransform,
  type ResolvedSourceUnit,
} from "../src/normalize.js";

// ---------------------------------------------------------------------------
// Every 3MF fixture in this file is a genuine ZIP (OPC) container built from
// scratch in code: a hand-rolled local-header/central-directory/end-record
// writer below (`buildZip`), fed either plain XML strings (stored) or bytes
// pushed through the platform `CompressionStream("deflate-raw")` (deflated).
// Nothing here is a committed binary fixture, and nothing hand-rolls
// deflate/inflate -- only the platform's own (de)compression streams are
// used, exactly like `src/zip.ts`.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const MODEL_REL_TYPE =
  "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const MODEL_CONTENT_TYPE =
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
const MODEL_PATH = "3D/3dmodel.model";

// ---------------------------------------------------------------------------
// ZIP construction
// ---------------------------------------------------------------------------

type ZipEntryInput =
  | {
      readonly name: string;
      readonly data: Uint8Array;
      readonly method?: "stored" | "deflate";
    }
  | {
      readonly name: string;
      readonly method: "deflate";
      /** Already-compressed bytes, injected verbatim (used only by the decompression-bomb fixture). */
      readonly rawCompressed: Uint8Array;
      readonly crc: number;
      readonly uncompressedLength: number;
    };

interface ZipEntryOffsets {
  readonly local: number;
  readonly central: number;
}

interface BuiltZip {
  readonly bytes: Uint8Array;
  readonly offsets: ReadonlyMap<string, ZipEntryOffsets>;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // Same `Uint8Array<ArrayBufferLike>` vs `Uint8Array<ArrayBuffer>` narrowing
  // cast as `src/zip.ts`'s `inflateRawBounded` -- this test module never
  // constructs a view over a `SharedArrayBuffer`.
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Compresses `totalBytes` of zero bytes to genuine (small) raw-deflate
 * output WITHOUT ever materializing `totalBytes` of memory in this test
 * process: a single reused 64 KiB zero chunk is enqueued repeatedly into a
 * pull-based `ReadableStream`, piped through the platform
 * `CompressionStream`. This is how the decompression-bomb fixture below can
 * declare tens of megabytes of expansion from a source file of a few
 * kilobytes.
 */
async function deflateZeroBomb(totalBytes: number): Promise<Uint8Array> {
  const chunkSize = 65_536;
  const zeroChunk = new Uint8Array(chunkSize) as Uint8Array<ArrayBuffer>;
  let remaining = totalBytes;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, remaining);
      controller.enqueue(
        size === chunkSize
          ? zeroChunk
          : (zeroChunk.subarray(0, size) as Uint8Array<ArrayBuffer>),
      );
      remaining -= size;
    },
  });
  const reader = source
    .pipeThrough(new CompressionStream("deflate-raw"))
    .getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Builds a complete, spec-shaped ZIP archive (local headers, central directory, end record) from `entries`, in document order. */
async function buildZip(entries: readonly ZipEntryInput[]): Promise<BuiltZip> {
  interface Resolved {
    readonly name: string;
    readonly nameBytes: Uint8Array;
    readonly method: number;
    readonly crc: number;
    readonly compressed: Uint8Array;
    readonly uncompressedLength: number;
  }
  const resolved: Resolved[] = [];
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    if ("rawCompressed" in entry) {
      resolved.push({
        name: entry.name,
        nameBytes,
        method: 8,
        crc: entry.crc,
        compressed: entry.rawCompressed,
        uncompressedLength: entry.uncompressedLength,
      });
      continue;
    }
    const method = entry.method === "deflate" ? 8 : 0;
    const compressed = method === 8 ? await deflateRaw(entry.data) : entry.data;
    resolved.push({
      name: entry.name,
      nameBytes,
      method,
      crc: crc32(entry.data),
      compressed,
      uncompressedLength: entry.data.byteLength,
    });
  }

  const offsets = new Map<string, { local: number; central: number }>();
  const localChunks: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let offset = 0;
  for (const record of resolved) {
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, record.method, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, record.crc, true);
    view.setUint32(18, record.compressed.byteLength, true);
    view.setUint32(22, record.uncompressedLength, true);
    view.setUint16(26, record.nameBytes.byteLength, true);
    view.setUint16(28, 0, true);
    localOffsets.push(offset);
    localChunks.push(header, record.nameBytes, record.compressed);
    offset +=
      header.byteLength +
      record.nameBytes.byteLength +
      record.compressed.byteLength;
  }

  const centralChunks: Uint8Array[] = [];
  const centralOffset = offset;
  resolved.forEach((record, index) => {
    const centralStart = offset;
    const header = new Uint8Array(46);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, record.method, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, record.compressed.byteLength, true);
    view.setUint32(24, record.uncompressedLength, true);
    view.setUint16(28, record.nameBytes.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, localOffsets[index]!, true);
    centralChunks.push(header, record.nameBytes);
    offsets.set(record.name, {
      local: localOffsets[index]!,
      central: centralStart,
    });
    offset += header.byteLength + record.nameBytes.byteLength;
  });

  const centralSize = offset - centralOffset;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, resolved.length, true);
  endView.setUint16(10, resolved.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return {
    bytes: concatBytes(...localChunks, ...centralChunks, end),
    offsets,
  };
}

function patchUint16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    offset,
    value,
    true,
  );
}

function patchUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value,
    true,
  );
}

// ---------------------------------------------------------------------------
// OPC / model XML builders
// ---------------------------------------------------------------------------

function relsXml(target = `/${MODEL_PATH}`, type = MODEL_REL_TYPE): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rel1" Type="${type}" Target="${target}"/>` +
    `</Relationships>`
  );
}

function contentTypesXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>` +
    `</Types>`
  );
}

interface ObjectSpec {
  readonly id: string;
  readonly type?: string;
  readonly extraAttrs?: string;
  readonly mesh?: {
    readonly positions: readonly (readonly [number, number, number])[];
    readonly triangles: readonly (readonly [number, number, number])[];
  };
  readonly components?: readonly {
    readonly objectId: string;
    readonly transform?: string;
  }[];
}

interface BuildItemSpec {
  readonly objectId: string;
  readonly transform?: string;
}

function buildModelXml(options: {
  readonly unit?: string;
  readonly objects: readonly ObjectSpec[];
  readonly items: readonly BuildItemSpec[];
  readonly requiredExtensions?: string;
  readonly modelPrefixContent?: string;
  readonly omitClosingTag?: boolean;
  readonly leadingComment?: string;
}): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>`;
  if (options.leadingComment !== undefined) {
    xml += `<!--${options.leadingComment}-->`;
  }
  xml += `<model unit="${options.unit ?? "millimeter"}" xmlns="${CORE_NS}"`;
  if (options.requiredExtensions !== undefined) {
    xml += ` requiredextensions="${options.requiredExtensions}"`;
  }
  xml += `>`;
  if (options.modelPrefixContent !== undefined) {
    xml += options.modelPrefixContent;
  }
  xml += `<resources>`;
  for (const object of options.objects) {
    xml += `<object id="${object.id}" type="${object.type ?? "model"}"${
      object.extraAttrs ? ` ${object.extraAttrs}` : ""
    }>`;
    if (object.mesh) {
      xml += `<mesh><vertices>`;
      for (const [x, y, z] of object.mesh.positions) {
        xml += `<vertex x="${x}" y="${y}" z="${z}"/>`;
      }
      xml += `</vertices><triangles>`;
      for (const [v1, v2, v3] of object.mesh.triangles) {
        xml += `<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`;
      }
      xml += `</triangles></mesh>`;
    } else if (object.components) {
      xml += `<components>`;
      for (const component of object.components) {
        xml += `<component objectid="${component.objectId}"${
          component.transform ? ` transform="${component.transform}"` : ""
        }/>`;
      }
      xml += `</components>`;
    }
    xml += `</object>`;
  }
  xml += `</resources><build>`;
  for (const item of options.items) {
    xml += `<item objectid="${item.objectId}"${
      item.transform ? ` transform="${item.transform}"` : ""
    }/>`;
  }
  xml += `</build>`;
  if (!options.omitClosingTag) xml += `</model>`;
  return xml;
}

const TRIANGLE_MESH: NonNullable<ObjectSpec["mesh"]> = {
  positions: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  triangles: [[0, 1, 2]],
};

const TRIANGLE_OBJECT: ObjectSpec = { id: "1", mesh: TRIANGLE_MESH };

function minimalModelXml(unit?: string): string {
  return buildModelXml({
    ...(unit !== undefined ? { unit } : {}),
    objects: [TRIANGLE_OBJECT],
    items: [{ objectId: "1" }],
  });
}

interface PackageParts {
  readonly rels?: string | null;
  readonly contentTypes?: string | null;
  readonly model: string;
  readonly modelPath?: string;
  readonly modelMethod?: "stored" | "deflate";
  readonly extra?: readonly ZipEntryInput[];
}

async function threeMfZip(parts: PackageParts): Promise<BuiltZip> {
  const modelPath = parts.modelPath ?? MODEL_PATH;
  const entries: ZipEntryInput[] = [];
  if (parts.rels !== null) {
    entries.push({
      name: "_rels/.rels",
      data: encoder.encode(parts.rels ?? relsXml()),
    });
  }
  if (parts.contentTypes !== null) {
    entries.push({
      name: "[Content_Types].xml",
      data: encoder.encode(parts.contentTypes ?? contentTypesXml()),
    });
  }
  entries.push({
    name: modelPath,
    data: encoder.encode(parts.model),
    ...(parts.modelMethod !== undefined ? { method: parts.modelMethod } : {}),
  });
  for (const extra of parts.extra ?? []) entries.push(extra);
  return buildZip(entries);
}

const defaultLimits = { inputBytes: 20_000_000, triangleCount: 10_000 };

function request(
  bytes: Uint8Array,
  overrides: Partial<{
    userUnit: ImportOptions["userUnit"];
    userAxis: ImportOptions["userAxis"];
    declaredUnit: ImportOptions["declaredUnit"];
    declaredAxis: ImportOptions["declaredAxis"];
    archive: NonNullable<ImportOptions["limits"]["archive"]>;
    inputBytes: number;
    triangleCount: number;
  }> = {},
) {
  const { archive, inputBytes, triangleCount, ...rest } = overrides;
  return importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: "model.test",
    format: "3mf",
    sourceName: "generated.3mf",
    bytes,
    options: {
      ...rest,
      limits: {
        inputBytes: inputBytes ?? defaultLimits.inputBytes,
        triangleCount: triangleCount ?? defaultLimits.triangleCount,
        ...(archive ? { archive } : {}),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("3MF Core importer", () => {
  it("imports a minimal valid 3MF to the expected geometry", async () => {
    const built = await threeMfZip({ model: minimalModelXml() });
    const result = await importModel(request(built.bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.meshes).toHaveLength(1);
    expect([...result.model.meshes[0]!.geometry.positions]).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]);
    expect([...result.model.meshes[0]!.geometry.indices]).toEqual([0, 1, 2]);
    expect(result.model.placement.kind).toBe("hierarchy");
    expect(result.model.provenance).toMatchObject({
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
    });
  });

  it("resolves every declared 3MF unit token to this package's unit vocabulary, with correct provenance and scaling", async () => {
    const cases: readonly [string, ResolvedSourceUnit][] = [
      ["micron", "micrometre"],
      ["millimeter", "millimetre"],
      ["centimeter", "centimetre"],
      ["inch", "inch"],
      ["foot", "foot"],
      ["meter", "metre"],
    ];
    for (const [token, expectedUnit] of cases) {
      const built = await threeMfZip({ model: minimalModelXml(token) });
      const result = await importModel(request(built.bytes));
      expect(result.ok, `unit token ${token}`).toBe(true);
      if (!result.ok) continue;
      expect(result.model.provenance).toMatchObject({
        detectedSourceUnit: expectedUnit,
        sourceUnit: expectedUnit,
        sourceResolution: { unit: "embedded" },
      });
      expect(result.model.provenance.appliedSourceToModel).toEqual(
        sourceToModelTransform(expectedUnit, "right-handed-z-up"),
      );
      const expectedPositions = normalizePositions(
        [0, 0, 0, 1, 0, 0, 0, 1, 0],
        expectedUnit,
        "right-handed-z-up",
      );
      const exported = await exportModel(result.model, {
        targetFormat: "obj",
        targetUnit: "millimetre",
        targetAxis: "right-handed-z-up",
      });
      const text = decoder.decode(exported.bytes);
      // The exported (canonical millimetre) coordinates must match applying
      // this package's own `normalizePositions` directly to the raw file
      // coordinates in the declared unit -- not just "some" scaling.
      for (let i = 0; i < expectedPositions.length; i += 3) {
        expect(text).toContain(
          `v ${expectedPositions[i]} ${expectedPositions[i + 1]} ${expectedPositions[i + 2]}`,
        );
      }
    }
  });

  it("rejects an unsupported/unrecognized unit token", async () => {
    const built = await threeMfZip({ model: minimalModelXml("furlong") });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("honors a user unit override, recorded distinctly from the embedded declaration", async () => {
    const built = await threeMfZip({ model: minimalModelXml("meter") });
    const result = await importModel(
      request(built.bytes, { userUnit: "centimetre" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.provenance).toMatchObject({
      detectedSourceUnit: "metre",
      sourceUnit: "centimetre",
      sourceResolution: { unit: "user", axis: "embedded" },
    });
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: "user-source-frame" }),
    );
  });

  it("composes a build-item transform with a nested component transform", async () => {
    // object 2: the raw triangle mesh. object 1: a <components> wrapper that
    // places object 2 with a +5 (x) translation. The <build><item> places
    // object 1 with a further +10 (y) translation. World position of local
    // vertex (1,0,0) is therefore (1+5, 0+10, 0) = (6, 10, 0) mm.
    const model = buildModelXml({
      objects: [
        { id: "2", mesh: TRIANGLE_MESH },
        {
          id: "1",
          components: [{ objectId: "2", transform: "1 0 0 0 1 0 0 0 1 5 0 0" }],
        },
      ],
      items: [{ objectId: "1", transform: "1 0 0 0 1 0 0 0 1 0 10 0" }],
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const exported = await exportModel(result.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(decoder.decode(exported.bytes)).toContain("v 6 10 0");
  });

  it("interprets the 3MF row-major transform convention with the documented handedness (a worked +90 degree rotation about Z)", async () => {
    // Row 0 of the 3x3 part is the image of the local X axis; row 1 is the
    // image of the local Y axis. "0 1 0 -1 0 0 0 0 1 0 0 0" therefore maps
    // local X -> world (0,1,0) and local Y -> world (-1,0,0): a +90 degree
    // rotation about Z. See src/threemf.ts's `parseOptionalTransform` for
    // the full row-major -> column-major derivation this pins.
    const model = buildModelXml({
      objects: [
        {
          id: "1",
          mesh: {
            positions: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            triangles: [[0, 1, 2]],
          },
        },
      ],
      items: [{ objectId: "1", transform: "0 1 0 -1 0 0 0 0 1 0 0 0" }],
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const exported = await exportModel(result.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const text = decoder.decode(exported.bytes);
    expect(text).toContain("v 0 1 0"); // (1,0,0) -> (0,1,0)
    expect(text).toContain("v -1 0 0"); // (0,1,0) -> (-1,0,0)
    expect(text).toContain("v 0 0 1"); // (0,0,1) unchanged
  });

  it("imports multiple independent objects as distinct meshes and instances", async () => {
    const model = buildModelXml({
      objects: [
        { id: "1", mesh: TRIANGLE_MESH },
        {
          id: "2",
          mesh: {
            positions: [
              [10, 0, 0],
              [11, 0, 0],
              [10, 1, 0],
            ],
            triangles: [[0, 1, 2]],
          },
        },
      ],
      items: [{ objectId: "1" }, { objectId: "2" }],
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.meshes).toHaveLength(2);
    expect(result.model.placement.instances).toHaveLength(2);
  });

  it("produces identical geometry for equivalent stored and deflated model parts", async () => {
    const model = minimalModelXml();
    const stored = await threeMfZip({ model, modelMethod: "stored" });
    const deflated = await threeMfZip({ model, modelMethod: "deflate" });
    const storedResult = await importModel(request(stored.bytes));
    const deflatedResult = await importModel(request(deflated.bytes));
    expect(storedResult.ok).toBe(true);
    expect(deflatedResult.ok).toBe(true);
    if (!storedResult.ok || !deflatedResult.ok) return;

    const storedExport = await exportModel(storedResult.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const deflatedExport = await exportModel(deflatedResult.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(decoder.decode(storedExport.bytes)).toBe(
      decoder.decode(deflatedExport.bytes),
    );
  });

  it("ignores metadata, materials, thumbnails, and labels, but warns naming each", async () => {
    const model = buildModelXml({
      objects: [
        {
          id: "1",
          mesh: TRIANGLE_MESH,
          extraAttrs:
            'pid="1" pindex="0" thumbnail="/Thumbnails/a.png" name="Widget" partnumber="W-1"',
        },
      ],
      items: [{ objectId: "1" }],
      modelPrefixContent: '<metadata name="Title">A test model</metadata>',
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: "3mf-decorative-data-ignored" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile inputs
// ---------------------------------------------------------------------------

describe("3MF Core importer -- hostile inputs", () => {
  it("fails fast on a decompression bomb, well before materializing its declared expansion", async () => {
    // ~20,000,000 declared/actual bytes of zeros compress (via the platform
    // deflate implementation) to well under 20 KB, a compression ratio far
    // beyond the importer's fixed 300:1 ceiling. The incremental reader in
    // `src/zip.ts` must abort once produced output crosses that ratio
    // threshold (a small fraction of the 20 MB the stream could otherwise
    // produce), not after fully expanding it -- this is exercised, not just
    // asserted, by the tight wall-clock bound below.
    const bomb = await deflateZeroBomb(20_000_000);
    const rels = encoder.encode(relsXml());
    const contentTypes = encoder.encode(contentTypesXml());
    const bombZip = await buildZip([
      { name: "_rels/.rels", data: rels },
      { name: "[Content_Types].xml", data: contentTypes },
      {
        name: MODEL_PATH,
        method: "deflate",
        rawCompressed: bomb,
        crc: 0,
        uncompressedLength: 20_000_000,
      },
    ]);
    const start = Date.now();
    const result = await importModel(request(bombZip.bytes));
    const elapsed = Date.now() - start;
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
    expect(elapsed).toBeLessThan(1_500);
  });

  it("rejects an archive exceeding the entry-count limit before parsing any entry", async () => {
    const built = await threeMfZip({
      model: minimalModelXml(),
      extra: [
        { name: "extra/a.txt", data: encoder.encode("a") },
        { name: "extra/b.txt", data: encoder.encode("b") },
      ],
    });
    const result = await importModel(
      request(built.bytes, {
        archive: {
          entryCount: 3,
          entryBytes: 10_000_000,
          expandedBytes: 10_000_000,
          compressionRatio: 300,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
  });

  it("rejects a single entry exceeding the per-entry decompressed size limit", async () => {
    const modelXml = minimalModelXml();
    const modelBytes = encoder.encode(modelXml).byteLength;
    const built = await threeMfZip({ model: modelXml });
    const result = await importModel(
      request(built.bytes, {
        archive: {
          entryCount: 10,
          entryBytes: modelBytes - 1,
          expandedBytes: 10_000_000,
          compressionRatio: 300,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
  });

  it("rejects an archive exceeding the aggregate decompressed size limit across entries", async () => {
    const rels = relsXml();
    const contentTypes = contentTypesXml();
    const modelXml = minimalModelXml();
    const total =
      encoder.encode(rels).byteLength +
      encoder.encode(contentTypes).byteLength +
      encoder.encode(modelXml).byteLength;
    const built = await threeMfZip({ rels, contentTypes, model: modelXml });
    const result = await importModel(
      request(built.bytes, {
        archive: {
          entryCount: 10,
          entryBytes: 10_000_000,
          expandedBytes: total - 1,
          compressionRatio: 300,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
  });

  it("rejects path traversal in a ZIP entry name", async () => {
    const built = await threeMfZip({
      model: minimalModelXml(),
      extra: [{ name: "../evil.txt", data: encoder.encode("evil") }],
    });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "unsafe-archive" });
  });

  it("rejects an encrypted ZIP entry", async () => {
    const built = await threeMfZip({ model: minimalModelXml() });
    const modelOffsets = built.offsets.get(MODEL_PATH)!;
    patchUint16(built.bytes, modelOffsets.local + 6, 0x1);
    patchUint16(built.bytes, modelOffsets.central + 8, 0x1);
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "unsafe-archive" });
  });

  it("rejects an unsupported ZIP compression method", async () => {
    const built = await threeMfZip({ model: minimalModelXml() });
    const modelOffsets = built.offsets.get(MODEL_PATH)!;
    patchUint16(built.bytes, modelOffsets.local + 8, 99);
    patchUint16(built.bytes, modelOffsets.central + 10, 99);
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "unsafe-archive" });
  });

  it("rejects a package whose OPC relationship targets a 3D model part that does not exist", async () => {
    const built = await threeMfZip({
      model: minimalModelXml(),
      rels: relsXml("/3D/does-not-exist.model"),
    });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects a package with no OPC root relationships part", async () => {
    const built = await threeMfZip({ model: minimalModelXml(), rels: null });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects a package whose relationship type does not declare the 3D model", async () => {
    const built = await threeMfZip({
      model: minimalModelXml(),
      rels: relsXml(
        `/${MODEL_PATH}`,
        "http://example.com/not-a-model-relationship",
      ),
    });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects malformed XML (an unterminated element)", async () => {
    const model = minimalModelXml().replace(/<\/model>$/u, "");
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects a DOCTYPE declaration in the model part", async () => {
    const model =
      `<?xml version="1.0"?><!DOCTYPE model [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
      minimalModelXml().replace(/^<\?xml[^>]*>/u, "");
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects an undefined XML entity reference", async () => {
    const model = buildModelXml({
      objects: [{ id: "1", mesh: TRIANGLE_MESH, extraAttrs: 'name="&xxe;"' }],
      items: [{ objectId: "1" }],
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects XML nesting beyond the importer's depth safety limit", async () => {
    const nested = "<a>".repeat(80) + "</a>".repeat(80);
    const model = buildModelXml({
      objects: [TRIANGLE_OBJECT],
      items: [{ objectId: "1" }],
      modelPrefixContent: nested,
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
  });

  it("rejects a cycle in component references", async () => {
    const model = buildModelXml({
      objects: [
        { id: "1", components: [{ objectId: "2" }] },
        { id: "2", components: [{ objectId: "1" }] },
      ],
      items: [{ objectId: "1" }],
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects a required extension explicitly, naming it", async () => {
    const model = buildModelXml({
      objects: [TRIANGLE_OBJECT],
      items: [{ objectId: "1" }],
      requiredExtensions: "http://example.com/ext/frobnicate",
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
    if (result.ok) return;
    expect(result.message).toContain("frobnicate");
  });

  it("rejects a component/build reference to a missing object", async () => {
    const model = buildModelXml({
      objects: [TRIANGLE_OBJECT],
      items: [{ objectId: "99" }],
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects an unrecognized object type", async () => {
    const model = buildModelXml({
      objects: [{ id: "1", type: "not-a-real-type", mesh: TRIANGLE_MESH }],
      items: [{ objectId: "1" }],
    });
    const built = await threeMfZip({ model });
    const result = await importModel(request(built.bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects a ZIP entry whose declared compressed size overruns the archive, without allocating a buffer", async () => {
    const built = await threeMfZip({ model: minimalModelXml() });
    const modelOffsets = built.offsets.get(MODEL_PATH)!;
    const bogusSize = 3_000_000_000; // < the 0xffffffff ZIP64 sentinel, but far beyond the real archive
    patchUint32(built.bytes, modelOffsets.local + 18, bogusSize);
    patchUint32(built.bytes, modelOffsets.local + 22, bogusSize);
    patchUint32(built.bytes, modelOffsets.central + 20, bogusSize);
    patchUint32(built.bytes, modelOffsets.central + 24, bogusSize);
    const start = Date.now();
    const result = await importModel(request(built.bytes));
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
  });
});
