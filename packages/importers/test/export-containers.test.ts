import { createHash } from "node:crypto";
import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  normalizedModelSchema,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import {
  exportModel,
  importModel,
  ExportInputError,
  ExportResourceLimitError,
  type ExportFormat,
} from "../src/index.js";
import {
  writeGltfContainer,
  writeThreeMfContainer,
  type ContainerGeometry,
} from "../src/export-containers.js";

const decode = new TextDecoder();
function model(repeated = false): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id: "model.export-container",
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: "mesh.original",
        geometry: {
          positions: Float64Array.of(
            1000,
            2000,
            3000,
            2000,
            2000,
            3000,
            1000,
            4000,
            3000,
          ),
          indices: Uint32Array.of(0, 1, 2),
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [
        {
          id: "instance.first",
          meshId: "mesh.original",
          meshToModel: IDENTITY_MAT4,
        },
        ...(repeated
          ? [
              {
                id: "instance.second",
                meshId: "mesh.original",
                meshToModel: [
                  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1,
                ],
              },
            ]
          : []),
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "original-fixture",
      importerVersion: "1",
      sourceName: "original.generated",
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [],
    },
  });
}
const gltfOptions = {
  targetUnit: "metre",
  targetAxis: "right-handed-y-up",
} as const;
function gltfDocument(
  bytes: Uint8Array,
  binary: boolean,
): { document: Record<string, any>; buffer: Uint8Array } {
  if (!binary) {
    const document = JSON.parse(decode.decode(bytes));
    return {
      document,
      buffer: Uint8Array.from(
        Buffer.from(document.buffers[0].uri.split(",")[1], "base64"),
      ),
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(4, true)).toBe(2);
  expect(view.getUint32(8, true)).toBe(bytes.length);
  const jsonLength = view.getUint32(12, true);
  expect(jsonLength % 4).toBe(0);
  expect(view.getUint32(16, true)).toBe(0x4e4f534a);
  const bin = 20 + jsonLength;
  expect(view.getUint32(bin + 4, true)).toBe(0x004e4942);
  expect(view.getUint32(bin, true)).toBe(bytes.length - bin - 8);
  return {
    document: JSON.parse(decode.decode(bytes.subarray(20, 20 + jsonLength))),
    buffer: bytes.slice(bin + 8),
  };
}
/** Independent stored ZIP walk: checks local/central headers, sizes, names and CRC via an independent bitwise implementation. */
function storedEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    result = new Map<string, Uint8Array>();
  let cursor = 0;
  while (view.getUint32(cursor, true) === 0x04034b50) {
    expect(view.getUint16(cursor + 8, true)).toBe(0);
    expect(view.getUint16(cursor + 6, true)).toBe(0x0800);
    const size = view.getUint32(cursor + 18, true),
      nameLength = view.getUint16(cursor + 26, true);
    expect(view.getUint32(cursor + 22, true)).toBe(size);
    expect(view.getUint16(cursor + 28, true)).toBe(0);
    const name = decode.decode(
      bytes.subarray(cursor + 30, cursor + 30 + nameLength),
    );
    const data = bytes.slice(
      cursor + 30 + nameLength,
      cursor + 30 + nameLength + size,
    );
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    expect(view.getUint32(cursor + 14, true)).toBe((crc ^ 0xffffffff) >>> 0);
    result.set(name, data);
    cursor += 30 + nameLength + size;
  }
  const centralStart = cursor;
  for (const [name, data] of result) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    expect(view.getUint32(cursor + 24, true)).toBe(data.length);
    const length = view.getUint16(cursor + 28, true);
    expect(
      decode.decode(bytes.subarray(cursor + 46, cursor + 46 + length)),
    ).toBe(name);
    cursor += 46 + length;
  }
  expect(view.getUint32(cursor, true)).toBe(0x06054b50);
  expect(view.getUint16(cursor + 10, true)).toBe(result.size);
  expect(view.getUint32(cursor + 12, true)).toBe(cursor - centralStart);
  expect(view.getUint32(cursor + 16, true)).toBe(centralStart);
  expect(cursor + 22).toBe(bytes.length);
  return result;
}
async function ownImport(format: "gltf" | "glb" | "3mf", bytes: Uint8Array) {
  const result = await importModel({
    contractVersion: 1,
    targetModelId: "model.roundtrip",
    format,
    sourceName: `generated.${format}`,
    bytes,
    options: {
      limits: { inputBytes: 32 * 1024 * 1024, triangleCount: 500_000 },
    },
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.message);
  return result.model;
}

describe("container geometry exports", () => {
  it.each(["gltf", "glb"] as const)(
    "writes independent %s binary/frame/winding evidence and round trips local geometry",
    async (format) => {
      const result = await exportModel(model(true), {
        ...gltfOptions,
        targetFormat: format,
      });
      const { document, buffer } = gltfDocument(result.bytes, format === "glb");
      expect(document.asset.version).toBe("2.0");
      expect(document.meshes[0].primitives[0].mode).toBe(4);
      expect(document.accessors[0]).toMatchObject({
        componentType: 5126,
        type: "VEC3",
        count: 6,
        min: [1, 3, -4],
        max: [3, 3, -2],
      });
      expect(document.accessors[1]).toMatchObject({
        componentType: 5125,
        type: "SCALAR",
        count: 6,
      });
      const view = new DataView(buffer.buffer);
      expect([0, 4, 8].map((offset) => view.getFloat32(offset, true))).toEqual([
        1, 3, -2,
      ]);
      expect(
        [0, 1, 2, 3, 4, 5].map((i) => view.getUint32(72 + i * 4, true)),
      ).toEqual([0, 1, 2, 3, 4, 5]);
      // +Z source normal becomes +Y in target coordinates, preserving winding.
      const a = [0, 4, 8].map((o) => view.getFloat32(o, true)),
        b = [12, 16, 20].map((o) => view.getFloat32(o, true)),
        c = [24, 28, 32].map((o) => view.getFloat32(o, true));
      expect(
        (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!),
      ).toBeGreaterThan(0);
      const imported = await ownImport(format, result.bytes);
      expect(imported.provenance).toMatchObject({
        sourceUnit: "metre",
        sourceAxis: "right-handed-y-up",
      });
      expect(imported.meshes[0]!.geometry.indices.length / 3).toBe(2);
      expect(result.geometry).toEqual({ triangleCount: 2, vertexCount: 6 });
      expect(
        result.warnings.some((w) => w.code === "export.float32-coordinates"),
      ).toBe(true);
      expect(
        result.warnings.some((w) => w.code === "export.unit-not-declared"),
      ).toBe(false);
      if (format === "gltf")
        expect(document.buffers[0].uri).toMatch(
          /^data:application\/octet-stream;base64,/u,
        );
      else expect(document.buffers[0]).not.toHaveProperty("uri");
      const repeated = await exportModel(model(true), {
        ...gltfOptions,
        targetFormat: format,
      });
      expect(repeated.bytes).toEqual(result.bytes);
      expect(result.digest.value).toBe(
        createHash("sha256").update(result.bytes).digest("hex"),
      );
    },
  );
  it.each([
    "micrometre",
    "millimetre",
    "centimetre",
    "metre",
    "inch",
    "foot",
  ] as const)(
    "writes declared %s Z-up 3MF with exact OPC paths and own-importer roundtrip",
    async (unit) => {
      const options = {
        targetFormat: "3mf",
        targetUnit: unit,
        targetAxis: "right-handed-z-up",
      } as const;
      const result = await exportModel(model(true), options);
      const entries = storedEntries(result.bytes);
      expect([...entries.keys()]).toEqual([
        "[Content_Types].xml",
        "_rels/.rels",
        "3D/3dmodel.model",
      ]);
      expect(decode.decode(entries.get("[Content_Types].xml"))).toContain(
        'ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"',
      );
      expect(decode.decode(entries.get("_rels/.rels"))).toContain(
        'Target="/3D/3dmodel.model"',
      );
      const xml = decode.decode(entries.get("3D/3dmodel.model"));
      expect(xml.match(/<vertex /gu)).toHaveLength(6);
      expect(xml).toContain('<triangle v1="3" v2="4" v3="5"/>');
      const names = {
        micrometre: "micron",
        millimetre: "millimeter",
        centimetre: "centimeter",
        metre: "meter",
        inch: "inch",
        foot: "foot",
      };
      expect(xml).toContain(`unit="${names[unit]}"`);
      const imported = await ownImport("3mf", result.bytes);
      expect(imported.provenance.sourceUnit).toBe(unit);
      expect(imported.meshes[0]!.geometry.indices.length).toBe(6);
      const raw = imported.meshes[0]!.geometry.positions,
        scale = imported.provenance.appliedSourceToModel[0];
      expect(raw[0]! * scale).toBeCloseTo(1000, 10);
      expect(raw[1]! * scale).toBeCloseTo(2000, 10);
      expect(raw[2]! * scale).toBeCloseTo(3000, 10);
      expect((await exportModel(model(true), options)).bytes).toEqual(
        result.bytes,
      );
      expect(result.digest.value).toBe(
        createHash("sha256").update(result.bytes).digest("hex"),
      );
    },
  );
  it.each(["gltf", "glb"] as const)(
    "refuses unsupported frame choices and float32 overflow for %s",
    async (format) => {
      await expect(
        exportModel(model(), {
          targetFormat: format,
          targetUnit: "millimetre",
          targetAxis: "right-handed-z-up",
        }),
      ).rejects.toThrow(ExportInputError);
      const source = model();
      source.meshes[0]!.geometry.positions[0] = 1e43;
      await expect(
        exportModel(source, { ...gltfOptions, targetFormat: format }),
      ).rejects.toThrow(ExportInputError);
    },
  );
  it("refuses Y-up 3MF and enforces encoded ceilings before output allocation", async () => {
    await expect(
      exportModel(model(), {
        targetFormat: "3mf",
        targetUnit: "millimetre",
        targetAxis: "right-handed-y-up",
      }),
    ).rejects.toThrow(ExportInputError);
    const geometry: ContainerGeometry = {
      vertexCount: 3,
      triangleCount: 1,
      forEachVertex(visit) {
        visit(0, 0, 0);
        visit(1, 0, 0);
        visit(0, 1, 0);
      },
      forEachTriangle(visit) {
        visit(0, 1, 2);
      },
    };
    const bytes = writeThreeMfContainer(geometry, "millimetre", 4096);
    expect(() =>
      writeThreeMfContainer(geometry, "millimetre", bytes.length),
    ).not.toThrow();
    expect(() =>
      writeThreeMfContainer(geometry, "millimetre", bytes.length - 1),
    ).toThrow(ExportResourceLimitError);
    for (const binary of [false, true]) {
      const data = writeGltfContainer(geometry, binary, 4096);
      expect(writeGltfContainer(geometry, binary, data.length)).toEqual(data);
      expect(() =>
        writeGltfContainer(geometry, binary, data.length - 1),
      ).toThrow(ExportResourceLimitError);
    }
  });
  it("rejects expanded geometry over the shared ceiling in every new format", async () => {
    const base = model();
    const source: NormalizedModel = {
      ...base,
      meshes: [
        {
          ...base.meshes[0]!,
          geometry: {
            positions: base.meshes[0]!.geometry.positions,
            indices: new Uint32Array(500_001 * 3),
          },
        },
      ],
    };
    for (const format of ["gltf", "glb", "3mf"] as ExportFormat[])
      await expect(
        exportModel(source, {
          targetFormat: format,
          targetUnit: format === "3mf" ? "millimetre" : "metre",
          targetAxis:
            format === "3mf" ? "right-handed-z-up" : "right-handed-y-up",
        }),
      ).rejects.toThrow(ExportResourceLimitError);
  });
  it("rejects non-finite 3MF output rather than writing malformed XML", () => {
    const bad: ContainerGeometry = {
      vertexCount: 3,
      triangleCount: 1,
      forEachVertex(visit) {
        visit(Infinity, 0, 0);
      },
      forEachTriangle() {},
    };
    expect(() => writeThreeMfContainer(bad, "millimetre", 4096)).toThrow(
      ExportInputError,
    );
  });
});
