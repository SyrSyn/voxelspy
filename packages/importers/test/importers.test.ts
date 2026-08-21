import {
  importExchangeSchema,
  importRequestSchema,
  importResultSchema,
  type ImportOptions,
} from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import { importModel, importerDescriptor, inferFormat } from "../src/index.js";

const encoder = new TextEncoder();
const limits = {
  inputBytes: 1_000_000,
  triangleCount: 100,
};
const declaredFrame: ImportOptions = {
  declaredUnit: "millimetre",
  declaredAxis: "right-handed-z-up",
  limits,
};

function request(
  format: "stl" | "obj" | "step",
  bytes: Uint8Array,
  options: ImportOptions = declaredFrame,
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

function asciiStl(): Uint8Array {
  return encoder.encode(`solid generated
facet normal 0 0 1
  outer loop
    vertex 7 8 9
    vertex 8 8 9
    vertex 7 9 9
  endloop
endfacet
endsolid generated
`);
}

function binaryStl(triangleCount = 1): Uint8Array {
  const bytes = new Uint8Array(84 + 50 * triangleCount);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangleCount, true);
  const coordinates = [7, 8, 9, 8, 8, 9, 7, 9, 9];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    coordinates.forEach((value, index) =>
      view.setFloat32(84 + triangle * 50 + 12 + index * 4, value, true),
    );
  }
  return bytes;
}

describe("mesh importers", () => {
  it("normalizes equivalent ASCII and binary STL without moving the source", async () => {
    const ascii = await importModel(request("stl", asciiStl()));
    const binary = await importModel(request("stl", binaryStl()));
    expect(ascii.ok).toBe(true);
    expect(binary.ok).toBe(true);
    if (!ascii.ok || !binary.ok) return;
    expect([...ascii.model.meshes[0]!.geometry.positions]).toEqual([
      ...binary.model.meshes[0]!.geometry.positions,
    ]);
    expect([...ascii.model.meshes[0]!.geometry.positions.slice(0, 3)]).toEqual([
      7, 8, 9,
    ]);
    expect(ascii.model.provenance.sourceDigest!.value).toHaveLength(64);
    expect(
      importExchangeSchema.parse({
        request: request("stl", asciiStl()),
        result: ascii,
      }),
    ).toBeTruthy();
  });

  it("requires an explicit source frame for formats without embedded metadata", async () => {
    const result = await importModel(request("stl", asciiStl(), { limits }));
    expect(result).toMatchObject({
      ok: false,
      code: "needs-input",
      warnings: [
        { code: "source-unit-required" },
        { code: "source-axis-required" },
      ],
    });
  });

  it("records and applies user-selected unit and axis corrections", async () => {
    const result = await importModel(
      request("stl", asciiStl(), {
        userUnit: "centimetre",
        userAxis: "right-handed-y-up",
        limits,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.positions.slice(0, 3)]).toEqual(
      [70, -90, 80],
    );
    expect(result.model.provenance).toMatchObject({
      detectedSourceUnit: "unknown",
      detectedSourceAxis: "unknown",
      sourceUnit: "centimetre",
      sourceAxis: "right-handed-y-up",
      sourceResolution: { unit: "user", axis: "user" },
    });
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: "user-source-frame" }),
    );
  });

  it("imports OBJ triangles and explicitly reports polygon triangulation", async () => {
    const source = encoder.encode(`
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vn 0 0 1
f -4//1 -3//1 -2//1 -1//1
`);
    const result = await importModel(request("obj", source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.indices]).toEqual([
      0, 1, 2, 0, 2, 3,
    ]);
    expect(result.model.warnings.map(({ code }) => code)).toEqual([
      "polygon-fan-triangulation",
      "obj-data-not-evaluated",
    ]);
  });

  it("fails closed for malformed geometry, external references, and limits", async () => {
    const malformed = await importModel(
      request("stl", encoder.encode("solid broken\nvertex 0 0 0\nendsolid")),
    );
    expect(malformed).toMatchObject({ ok: false, code: "invalid-input" });

    const external = await importModel(
      request("obj", encoder.encode("mtllib remote.mtl\nv 0 0 0\nf 1 1 1")),
    );
    expect(external).toMatchObject({
      ok: false,
      code: "unsupported-input",
    });

    const limited = await importModel(
      request("stl", binaryStl(2), {
        ...declaredFrame,
        limits: { inputBytes: 1_000_000, triangleCount: 1 },
      }),
    );
    expect(limited).toMatchObject({ ok: false, code: "resource-limit" });
  });

  it("preserves degenerate triangles and reports them instead of repairing", async () => {
    const source = encoder.encode(`solid generated
facet normal 0 0 0
outer loop
vertex 2 2 2
vertex 2 2 2
vertex 2 2 2
endloop
endfacet
endsolid generated`);
    const result = await importModel(request("stl", source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.meshes[0]!.geometry.positions.length).toBe(9);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({ code: "degenerate-triangles" }),
    );
  });

  it("warns when an ASCII STL merges multiple solid blocks into one mesh", async () => {
    const source = encoder.encode(`solid first
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid first
solid second
facet normal 0 0 1
outer loop
vertex 2 2 2
vertex 3 2 2
vertex 2 3 2
endloop
endfacet
endsolid second
`);
    const result = await importModel(request("stl", source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.meshes[0]!.geometry.indices.length).toBe(6);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({
        code: "stl-multiple-solids-merged",
        details: { count: 2 },
      }),
    );
  });

  it("does not warn about merged solids for a single-solid ASCII STL", async () => {
    const result = await importModel(request("stl", asciiStl()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.model.warnings.some(
        (candidate) => candidate.code === "stl-multiple-solids-merged",
      ),
    ).toBe(false);
  });

  it("reports a length-mismatch diagnostic for a binary STL with trailing bytes, instead of a misleading UTF-8 error", async () => {
    const binary = binaryStl(1);
    const withTrailingByte = new Uint8Array(binary.byteLength + 1);
    withTrailingByte.set(binary);
    withTrailingByte[binary.byteLength] = 0x0a;
    const result = await importModel(request("stl", withTrailingByte));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-input");
    expect(result.message).not.toContain("not valid UTF-8");
    expect(result.message).toMatch(/byte/iu);
    expect(result.message).toContain(`${binary.byteLength}`);
    expect(result.message).toContain(`${withTrailingByte.byteLength}`);
  });

  it("returns contract-valid unsupported outcomes and exposes deterministic discovery", async () => {
    const unsupported = await importModel(
      request("step", encoder.encode("STEP")),
    );
    expect(importResultSchema.parse(unsupported)).toMatchObject({
      ok: false,
      code: "unsupported-input",
    });
    expect(inferFormat("PART.STL")).toBe("stl");
    expect(inferFormat("part.step")).toBeUndefined();
    expect(importerDescriptor.formats).toEqual([
      "stl",
      "obj",
      "gltf",
      "glb",
      "3mf",
    ]);
  });
});
