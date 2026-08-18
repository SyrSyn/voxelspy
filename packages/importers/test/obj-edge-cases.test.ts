import { importRequestSchema, type ImportOptions } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import { importModel } from "../src/index.js";

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

function request(body: string, options: ImportOptions = declaredFrame) {
  return importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: "model.test",
    format: "obj",
    sourceName: "generated.obj",
    bytes: encoder.encode(body),
    options,
  });
}

describe("OBJ edge cases", () => {
  it("rejects a face index of 0 (OBJ indices are 1-based, never 0)", async () => {
    const result = await importModel(
      request("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 0\n"),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("invalid vertex index");
  });

  it("rejects an out-of-range negative (relative) index", async () => {
    const result = await importModel(request("v 0 0 0\nv 1 0 0\nf 1 2 -5\n"));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("vertex index is out of range");
  });

  it("rejects a forward reference to a vertex not yet declared", async () => {
    const result = await importModel(
      request("f 1 2 3\nv 0 0 0\nv 1 0 0\nv 0 1 0\n"),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("vertex index is out of range");
  });

  it("pins that the spec-legal optional homogeneous 'w' component on 'v' is rejected as a documented subset limitation", async () => {
    // Truth pinned: the OBJ spec permits "v x y z [w]", but this importer
    // only accepts exactly three components. A fourth field makes the line
    // fail with the same "exactly x, y, and z" diagnostic as any other
    // malformed vertex line. This is an intentional subset limitation, not
    // a parsing bug.
    const result = await importModel(request("v 0 0 0 1\n"));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain(
      "vertices must contain exactly x, y, and z",
    );
  });

  it("accepts the v/vt face form and reports face attributes as ignored", async () => {
    const result = await importModel(
      request("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1 2/2 3/3\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.indices]).toEqual([0, 1, 2]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({
        code: "obj-data-not-evaluated",
        details: { directives: ["face-attributes"] },
      }),
    );
  });

  it("accepts the v/vt/vn face form and reports face attributes as ignored", async () => {
    const result = await importModel(
      request("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.indices]).toEqual([0, 1, 2]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({
        code: "obj-data-not-evaluated",
        details: { directives: ["face-attributes"] },
      }),
    );
  });

  it("skips comments and blank lines", async () => {
    const body = `# header comment

v 0 0 0 # inline comment
v 1 0 0
v 0 1 0

f 1 2 3 # trailing comment
`;
    const result = await importModel(request(body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.indices]).toEqual([0, 1, 2]);
  });

  it("fan-triangulates a 5-sided polygon face in source order", async () => {
    const body = `v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 2 0
f 1 2 3 4 5
`;
    const result = await importModel(request(body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.indices]).toEqual([
      0, 1, 2, 0, 2, 3, 0, 3, 4,
    ]);
    expect(result.model.warnings).toContainEqual(
      expect.objectContaining({
        code: "polygon-fan-triangulation",
        details: { count: 1 },
      }),
    );
  });

  it("fails explicitly, not silently, on unsupported line/point/parameter-space directives", async () => {
    const line = await importModel(request("l 1 2\n"));
    expect(line).toMatchObject({ ok: false, code: "unsupported-input" });

    const point = await importModel(request("p 1\n"));
    expect(point).toMatchObject({ ok: false, code: "unsupported-input" });

    const parameterSpace = await importModel(request("vp 1 2 3\n"));
    expect(parameterSpace).toMatchObject({
      ok: false,
      code: "unsupported-input",
    });
  });

  it("rejects non-UTF-8 input bytes", async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x01]);
    const result = await importModel(
      importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: "model.test",
        format: "obj",
        sourceName: "generated.obj",
        bytes,
        options: declaredFrame,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("not valid UTF-8");
  });
});
