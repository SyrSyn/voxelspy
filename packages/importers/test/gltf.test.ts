import { importRequestSchema, type ImportOptions } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import { exportModel, importModel } from "../src/index.js";
import { sourceToModelTransform } from "../src/normalize.js";

// ---------------------------------------------------------------------------
// Fixture builders -- every glTF/GLB fixture in this file is generated in
// code from a plain JSON document object plus a packed binary payload,
// never committed as a binary file.
// ---------------------------------------------------------------------------

function packFloat32(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function packUint16(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
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

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function dataUri(bytes: Uint8Array): string {
  return `data:application/octet-stream;base64,${toBase64(bytes)}`;
}

/** A minimal single-primitive triangle mesh (one node, one mesh, one scene), overridable per test. */
function triangleDocument(
  overrides: Record<string, unknown> = {},
  positions: readonly number[] = [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: readonly number[] | undefined = [0, 1, 2],
): { doc: Record<string, unknown>; bufferBytes: Uint8Array } {
  const positionBytes = packFloat32(positions);
  const indexBytes = indices ? packUint16(indices) : new Uint8Array(0);
  const bufferBytes = concatBytes(positionBytes, indexBytes);
  const bufferViews: unknown[] = [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength },
  ];
  const accessors: unknown[] = [
    {
      bufferView: 0,
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
    },
  ];
  const primitive: Record<string, unknown> = {
    attributes: { POSITION: 0 },
  };
  if (indices) {
    bufferViews.push({
      buffer: 0,
      byteOffset: positionBytes.byteLength,
      byteLength: indexBytes.byteLength,
    });
    accessors.push({
      bufferView: 1,
      componentType: 5123,
      count: indices.length,
      type: "SCALAR",
    });
    primitive.indices = 1;
  }
  const doc: Record<string, unknown> = {
    asset: { version: "2.0" },
    buffers: [
      { byteLength: bufferBytes.byteLength, uri: dataUri(bufferBytes) },
    ],
    bufferViews,
    accessors,
    meshes: [{ primitives: [primitive] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...overrides,
  };
  return { doc, bufferBytes };
}

function encodeGltf(doc: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const remainder = bytes.byteLength % 4;
  if (remainder === 0) return bytes;
  return concatBytes(bytes, new Uint8Array(4 - remainder).fill(fill));
}

const GLB_MAGIC = 0x46_54_6c_67;
const GLB_JSON_CHUNK_TYPE = 0x4e_4f_53_4a;
const GLB_BIN_CHUNK_TYPE = 0x00_4e_49_42;

function encodeGlb(
  doc: Record<string, unknown>,
  binaryChunk?: Uint8Array,
): Uint8Array {
  const json = pad4(encodeGltf(doc), 0x20);
  const bin = binaryChunk ? pad4(binaryChunk, 0x00) : undefined;
  const totalLength = 12 + 8 + json.byteLength + (bin ? 8 + bin.byteLength : 0);
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, GLB_JSON_CHUNK_TYPE, true);
  out.set(json, 20);
  let offset = 20 + json.byteLength;
  if (bin) {
    view.setUint32(offset, bin.byteLength, true);
    view.setUint32(offset + 4, GLB_BIN_CHUNK_TYPE, true);
    out.set(bin, offset + 8);
    offset += 8 + bin.byteLength;
  }
  return out;
}

/** Builds a GLB fixture from a `triangleDocument`-shaped `{ doc, bufferBytes }`, moving buffer 0 into the binary chunk. */
function toGlbFixture(built: {
  doc: Record<string, unknown>;
  bufferBytes: Uint8Array;
}): Uint8Array {
  const doc = {
    ...built.doc,
    buffers: [{ byteLength: built.bufferBytes.byteLength }],
  };
  return encodeGlb(doc, built.bufferBytes);
}

const limits = { inputBytes: 10_000_000, triangleCount: 10_000 };

function request(
  format: "gltf" | "glb",
  bytes: Uint8Array,
  options: ImportOptions = { limits },
) {
  return importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: "model.test",
    format,
    sourceName: `generated.${format}`,
    bytes,
    options,
  });
}

describe("glTF/GLB importer", () => {
  it("imports an equivalent minimal .gltf (data URI) and .glb producing identical geometry", async () => {
    const built = triangleDocument();
    const gltfResult = await importModel(
      request("gltf", encodeGltf(built.doc)),
    );
    const glbResult = await importModel(request("glb", toGlbFixture(built)));
    expect(gltfResult.ok).toBe(true);
    expect(glbResult.ok).toBe(true);
    if (!gltfResult.ok || !glbResult.ok) return;

    const gltfExport = await exportModel(gltfResult.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const glbExport = await exportModel(glbResult.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(new TextDecoder().decode(gltfExport.bytes)).toBe(
      new TextDecoder().decode(glbExport.bytes),
    );
  });

  it("resolves glTF's declared metre, right-handed-Y-up frame without requiring caller input", async () => {
    const built = triangleDocument();
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.provenance).toMatchObject({
      detectedSourceUnit: "metre",
      detectedSourceAxis: "right-handed-y-up",
      sourceUnit: "metre",
      sourceAxis: "right-handed-y-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
    });
    expect(result.model.provenance.appliedSourceToModel).toEqual(
      sourceToModelTransform("metre", "right-handed-y-up"),
    );
    expect(
      result.model.warnings.some((w) => w.code === "user-source-frame"),
    ).toBe(false);

    const exported = await exportModel(result.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const text = new TextDecoder().decode(exported.bytes);
    // (0,0,0) (1,0,0) (0,1,0) metres, Y-up -> millimetres, Z-up:
    // (x,y,z) -> (x*1000, -z*1000, y*1000)
    expect(text).toContain("v 0 0 0");
    expect(text).toContain("v 1000 0 0");
    expect(text).toContain("v 0 0 1000");
  });

  it("honors a user frame override and records it distinctly from the embedded declaration", async () => {
    const built = triangleDocument();
    const result = await importModel(
      request("gltf", encodeGltf(built.doc), {
        userUnit: "centimetre",
        userAxis: "right-handed-z-up",
        limits,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.provenance).toMatchObject({
      detectedSourceUnit: "metre",
      detectedSourceAxis: "right-handed-y-up",
      sourceUnit: "centimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "user", axis: "user" },
    });
    expect(result.model.provenance.appliedSourceToModel).toEqual(
      sourceToModelTransform("centimetre", "right-handed-z-up"),
    );
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: "user-source-frame" }),
    );
  });

  it("composes nested node translations and a matrix node into the final placement", async () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const positionBytes = packFloat32(positions);
    const indexBytes = packUint16([0, 1, 2]);
    const bufferBytes = concatBytes(positionBytes, indexBytes);
    const doc = {
      asset: { version: "2.0" },
      buffers: [
        { byteLength: bufferBytes.byteLength, uri: dataUri(bufferBytes) },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength },
        {
          buffer: 0,
          byteOffset: positionBytes.byteLength,
          byteLength: indexBytes.byteLength,
        },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      // node 0 (root): translation (10, 0, 0) metres, child is node 1
      // node 1: a matrix that translates by (0, 5, 0) metres, child is node 2
      // node 2: carries the mesh, identity transform
      nodes: [
        { translation: [10, 0, 0], children: [1] },
        {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1],
          children: [2],
        },
        { mesh: 0 },
      ],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
    const result = await importModel(request("gltf", encodeGltf(doc)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.placement.kind).toBe("hierarchy");

    const exported = await exportModel(result.model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    // World position (metres, Y-up) = (10, 5, 0) -> mm, Z-up = (10000, 0, 5000)
    expect(new TextDecoder().decode(exported.bytes)).toContain(
      "v 10000 0 5000",
    );
  });

  it("imports multiple meshes and multiple primitives per mesh as distinct mesh records", async () => {
    const p0 = packFloat32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const p1 = packFloat32([2, 0, 0, 3, 0, 0, 2, 1, 0]);
    const buffer = concatBytes(p0, p1);
    const doc = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: buffer.byteLength, uri: dataUri(buffer) }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: p0.byteLength },
        { buffer: 0, byteOffset: p0.byteLength, byteLength: p1.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      ],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 } },
            { attributes: { POSITION: 1 } },
          ],
        },
        { primitives: [{ attributes: { POSITION: 0 } }] },
      ],
      nodes: [{ mesh: 0 }, { mesh: 1 }],
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
    };
    const result = await importModel(request("gltf", encodeGltf(doc)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.meshes).toHaveLength(3);
    expect(result.model.placement.instances).toHaveLength(3);
  });

  it("generates sequential indices for a non-indexed primitive", async () => {
    const built = triangleDocument({}, [0, 0, 0, 1, 0, 0, 0, 1, 0], undefined);
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.indices]).toEqual([0, 1, 2]);
  });

  it("rejects animations explicitly", async () => {
    const built = triangleDocument({
      animations: [{ channels: [], samplers: [] }],
    });
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects morph targets on a primitive explicitly", async () => {
    const p0 = packFloat32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const doc = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: p0.byteLength, uri: dataUri(p0) }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: p0.byteLength }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      ],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] },
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
    const result = await importModel(request("gltf", encodeGltf(doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects skins explicitly, at both the document and node level", async () => {
    const withSkinsArray = triangleDocument({ skins: [{ joints: [0] }] });
    expect(
      await importModel(request("gltf", encodeGltf(withSkinsArray.doc))),
    ).toMatchObject({
      ok: false,
      code: "unsupported-input",
    });

    const withNodeSkin = triangleDocument({ nodes: [{ mesh: 0, skin: 0 }] });
    expect(
      await importModel(request("gltf", encodeGltf(withNodeSkin.doc))),
    ).toMatchObject({
      ok: false,
      code: "unsupported-input",
    });
  });

  it("rejects an external or relative buffer URI explicitly", async () => {
    const built = triangleDocument({
      buffers: [{ byteLength: 36, uri: "https://example.com/model.bin" }],
    });
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects an external or relative image URI explicitly, even though images are otherwise ignored", async () => {
    const built = triangleDocument({
      images: [{ uri: "textures/diffuse.png" }],
    });
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects sparse accessors explicitly", async () => {
    const built = triangleDocument();
    const accessors = built.doc.accessors as Record<string, unknown>[];
    accessors[0]!.sparse = { count: 1, indices: {}, values: {} };
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects an unsupported primitive mode (TRIANGLE_STRIP), naming it in the error", async () => {
    const built = triangleDocument();
    const primitives = (built.doc.meshes as Record<string, unknown>[])[0]!
      .primitives as Record<string, unknown>[];
    primitives[0]!.mode = 5;
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
    if (result.ok) return;
    expect(result.message).toMatch(/TRIANGLE_STRIP/u);
  });

  it("rejects an unsupported POSITION component type", async () => {
    const built = triangleDocument();
    const accessors = built.doc.accessors as Record<string, unknown>[];
    accessors[0]!.componentType = 5122; // SHORT, not FLOAT
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects a required extension explicitly", async () => {
    const built = triangleDocument({
      extensionsRequired: ["KHR_draco_mesh_compression"],
    });
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
    if (result.ok) return;
    expect(result.message).toContain("KHR_draco_mesh_compression");
  });

  it("ignores non-required extensions, materials, textures, and cameras, but warns about each", async () => {
    const built = triangleDocument({
      extensionsUsed: ["KHR_materials_unlit"],
      materials: [{}],
      textures: [{}],
      images: [{ uri: dataUri(new Uint8Array([1, 2, 3])) }],
      cameras: [{ type: "perspective" }],
      nodes: [{ mesh: 0, camera: 0 }],
    });
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: "gltf-extension-ignored" }),
    );
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: "gltf-decorative-data-ignored" }),
    );
  });

  it("fails closed for a truncated GLB", async () => {
    const built = triangleDocument();
    const full = toGlbFixture(built);
    const truncated = Uint8Array.from(full.subarray(0, full.byteLength - 10));
    const result = await importModel(request("glb", truncated));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("fails closed for a wrong GLB magic number", async () => {
    const built = triangleDocument();
    const bytes = toGlbFixture(built);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xdeadbeef, true);
    const result = await importModel(request("glb", bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("fails closed for an unsupported GLB version", async () => {
    const built = triangleDocument();
    const bytes = toGlbFixture(built);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 1, true);
    const result = await importModel(request("glb", bytes));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("fails closed for a GLB chunk length that overruns the input", async () => {
    const built = triangleDocument();
    const bytes = toGlbFixture(built);
    const view = new DataView(bytes.buffer);
    view.setUint32(12, view.getUint32(12, true) + 4_000, true);
    const result = await importModel(request("glb", bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects an accessor that overruns its bufferView", async () => {
    const built = triangleDocument();
    const accessors = built.doc.accessors as Record<string, unknown>[];
    accessors[0]!.count = 100; // POSITION bufferView only has room for 3 vertices
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects an absurd declared accessor count before allocating any geometry", async () => {
    const built = triangleDocument();
    const accessors = built.doc.accessors as Record<string, unknown>[];
    accessors[0]!.count = 4_000_000_000; // would ask for ~96 GB as Float64Array(count * 3)
    const start = Date.now();
    const result = await importModel(request("gltf", encodeGltf(built.doc)));
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("rejects a document with no static mesh geometry reachable from its default scene", async () => {
    const doc = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [] }],
      scene: 0,
    };
    const result = await importModel(request("gltf", encodeGltf(doc)));
    expect(result).toMatchObject({ ok: false, code: "unsupported-input" });
  });

  it("rejects a caller-provided triangle limit that the geometry exceeds", async () => {
    const built = triangleDocument(
      {},
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      [0, 1, 2, 1, 3, 2],
    );
    const result = await importModel(
      request("gltf", encodeGltf(built.doc), {
        limits: { inputBytes: 10_000_000, triangleCount: 1 },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
  });
});
