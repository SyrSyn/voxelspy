import { ExportInputError, ExportResourceLimitError } from "./errors.js";
import type { ResolvedSourceUnit } from "./normalize.js";

/** Already placed in the deliberately selected file frame. Internal writer adapter, not a second geometry pipeline. */
export interface ContainerGeometry {
  readonly vertexCount: number;
  readonly triangleCount: number;
  forEachVertex(visit: (x: number, y: number, z: number) => void): void;
  forEachTriangle(visit: (a: number, b: number, c: number) => void): void;
}
function checkBytes(length: number, maximum: number): void {
  if (!Number.isSafeInteger(length) || length > maximum)
    throw new ExportResourceLimitError(
      `Encoded export exceeds the ${maximum}-byte safety limit.`,
    );
}
function float32(value: number): number {
  const rounded = Math.fround(value);
  if (!Number.isFinite(value) || !Number.isFinite(rounded))
    throw new ExportInputError(
      "glTF export produced a coordinate outside its finite float32 representation.",
    );
  return rounded;
}
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 32_768)),
    );
  return globalThis.btoa(chunks.join(""));
}

/** Static glTF2.0 triangle geometry. Every binary field is written explicitly little-endian. */
export function writeGltfContainer(
  geometry: ContainerGeometry,
  binary: boolean,
  maximumBytes: number,
): Uint8Array {
  const positionBytes = geometry.vertexCount * 12,
    indexBytes = geometry.triangleCount * 12;
  const byteLength = positionBytes + indexBytes;
  checkBytes(
    binary ? byteLength + 28 : Math.ceil(byteLength / 3) * 4,
    maximumBytes,
  );
  const buffer = new Uint8Array(byteLength),
    view = new DataView(buffer.buffer);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let vertex = 0;
  geometry.forEachVertex((x, y, z) => {
    const values = [float32(x), float32(y), float32(z)];
    for (let axis = 0; axis < 3; axis++) {
      const value = values[axis]!;
      view.setFloat32(vertex * 12 + axis * 4, value, true);
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
    vertex++;
  });
  let triangle = 0;
  geometry.forEachTriangle((a, b, c) => {
    const offset = positionBytes + triangle * 12;
    view.setUint32(offset, a, true);
    view.setUint32(offset + 4, b, true);
    view.setUint32(offset + 8, c, true);
    triangle++;
  });
  const document = {
    asset: { version: "2.0", generator: "VoxelSpy geometry export" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] },
    ],
    buffers: [binary ? { byteLength } : { byteLength, uri: "" }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes, target: 34962 },
      {
        buffer: 0,
        byteOffset: positionBytes,
        byteLength: indexBytes,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: geometry.vertexCount,
        type: "VEC3",
        min,
        max,
      },
      {
        bufferView: 1,
        componentType: 5125,
        count: geometry.triangleCount * 3,
        type: "SCALAR",
      },
    ],
  };
  const encoder = new TextEncoder();
  if (!binary) {
    const prefix = "data:application/octet-stream;base64,";
    // JSON numbers, fixed syntax and base64 are ASCII, so character and UTF-8 byte counts agree.
    checkBytes(
      JSON.stringify(document).length +
        prefix.length +
        Math.ceil(byteLength / 3) * 4,
      maximumBytes,
    );
    document.buffers[0] = { byteLength, uri: prefix + base64(buffer) };
    const text = JSON.stringify(document);
    checkBytes(text.length, maximumBytes);
    return encoder.encode(text);
  }
  const json = encoder.encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4,
    binLength = Math.ceil(buffer.length / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  checkBytes(total, maximumBytes);
  const output = new Uint8Array(total),
    header = new DataView(output.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, total, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  const binOffset = 20 + jsonLength;
  header.setUint32(binOffset, binLength, true);
  header.setUint32(binOffset + 4, 0x004e4942, true);
  output.set(buffer, binOffset + 8);
  return output;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELATIONSHIPS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
const MODEL_PATH = "3D/3dmodel.model",
  TYPE_PATH = "[Content_Types].xml",
  REL_PATH = "_rels/.rels";
function archiveOverhead(paths: readonly string[]): number {
  return 22 + paths.reduce((sum, path) => sum + 30 + 46 + 2 * path.length, 0);
}

export function writeThreeMfContainer(
  geometry: ContainerGeometry,
  unit: ResolvedSourceUnit,
  maximumBytes: number,
): Uint8Array {
  const units: Record<ResolvedSourceUnit, string> = {
    micrometre: "micron",
    millimetre: "millimeter",
    centimetre: "centimeter",
    metre: "meter",
    inch: "inch",
    foot: "foot",
  };
  const reserved =
    CONTENT_TYPES.length +
    RELATIONSHIPS.length +
    archiveOverhead([TYPE_PATH, REL_PATH, MODEL_PATH]);
  const lines: string[] = [];
  let length = reserved;
  const append = (text: string) => {
    length += text.length + 1;
    checkBytes(length, maximumBytes);
    lines.push(text);
  };
  const number = (value: number) => {
    if (!Number.isFinite(value))
      throw new ExportInputError(
        "3MF export produced a non-finite coordinate.",
      );
    return value.toString();
  };
  append('<?xml version="1.0" encoding="UTF-8"?>');
  append(
    `<model unit="${units[unit]}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>`,
  );
  geometry.forEachVertex((x, y, z) =>
    append(`<vertex x="${number(x)}" y="${number(y)}" z="${number(z)}"/>`),
  );
  append("</vertices><triangles>");
  geometry.forEachTriangle((a, b, c) =>
    append(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`),
  );
  append(
    '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>',
  );
  const encoder = new TextEncoder();
  return storedZip(
    [
      { path: TYPE_PATH, bytes: encoder.encode(CONTENT_TYPES) },
      { path: REL_PATH, bytes: encoder.encode(RELATIONSHIPS) },
      { path: MODEL_PATH, bytes: encoder.encode(`${lines.join("\n")}\n`) },
    ],
    maximumBytes,
  );
}

/** Deterministic uncompressed single-disk OPC container. Paths are fixed constants, not user input. */
function storedZip(
  entries: readonly { path: string; bytes: Uint8Array }[],
  maximumBytes: number,
): Uint8Array {
  const length =
    archiveOverhead(entries.map((e) => e.path)) +
    entries.reduce((sum, e) => sum + e.bytes.length, 0);
  checkBytes(length, maximumBytes);
  const output = new Uint8Array(length),
    view = new DataView(output.buffer),
    encoder = new TextEncoder();
  const central: {
    path: Uint8Array;
    offset: number;
    crc: number;
    size: number;
  }[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const path = encoder.encode(entry.path),
      crc = crc32(entry.bytes),
      offset = cursor,
      size = entry.bytes.length;
    view.setUint32(cursor, 0x04034b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 0x0800, true);
    view.setUint16(cursor + 12, 33, true);
    view.setUint32(cursor + 14, crc, true);
    view.setUint32(cursor + 18, size, true);
    view.setUint32(cursor + 22, size, true);
    view.setUint16(cursor + 26, path.length, true);
    output.set(path, cursor + 30);
    output.set(entry.bytes, cursor + 30 + path.length);
    cursor += 30 + path.length + size;
    central.push({ path, offset, crc, size });
  }
  const centralOffset = cursor;
  for (const entry of central) {
    view.setUint32(cursor, 0x02014b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 8, 0x0800, true);
    view.setUint16(cursor + 14, 33, true);
    view.setUint32(cursor + 16, entry.crc, true);
    view.setUint32(cursor + 20, entry.size, true);
    view.setUint32(cursor + 24, entry.size, true);
    view.setUint16(cursor + 28, entry.path.length, true);
    view.setUint32(cursor + 42, entry.offset, true);
    output.set(entry.path, cursor + 46);
    cursor += 46 + entry.path.length;
  }
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 8, entries.length, true);
  view.setUint16(cursor + 10, entries.length, true);
  view.setUint32(cursor + 12, cursor - centralOffset, true);
  view.setUint32(cursor + 16, centralOffset, true);
  return output;
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit++)
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
