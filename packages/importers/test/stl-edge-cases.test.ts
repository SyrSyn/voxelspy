import { importRequestSchema, type ImportOptions } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import { importModel } from "../src/index.js";

const encoder = new TextEncoder();
const limits = {
  inputBytes: 40_000_000,
  triangleCount: 100,
};
const declaredFrame: ImportOptions = {
  declaredUnit: "millimetre",
  declaredAxis: "right-handed-z-up",
  limits,
};

function request(bytes: Uint8Array, options: ImportOptions = declaredFrame) {
  return importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: "model.test",
    format: "stl",
    sourceName: "generated.stl",
    bytes,
    options,
  });
}

function asciiStl(body: string): Uint8Array {
  return encoder.encode(body);
}

const BINARY_HEADER_BYTES = 84;
const BINARY_FACET_BYTES = 50;

function binaryStl(
  triangleCount: number,
  fill: (view: DataView) => void = () => {},
): Uint8Array {
  const bytes = new Uint8Array(
    BINARY_HEADER_BYTES + BINARY_FACET_BYTES * triangleCount,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangleCount, true);
  const coordinates = [7, 8, 9, 8, 8, 9, 7, 9, 9];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    coordinates.forEach((value, index) =>
      view.setFloat32(
        BINARY_HEADER_BYTES + triangle * BINARY_FACET_BYTES + 12 + index * 4,
        value,
        true,
      ),
    );
  }
  fill(view);
  return bytes;
}

describe("binary STL edge cases", () => {
  it("pins the truncated diagnostic when the file is one byte short of the declared count", async () => {
    // Truth pinned: a binary STL missing a handful of trailing bytes (within
    // one facet's width of the declared length) gets the accurate,
    // actionable "byte(s) short (truncated)" diagnostic rather than a
    // misleading UTF-8 error.
    const full = binaryStl(1);
    const short = full.slice(0, full.byteLength - 1);
    const result = await importModel(request(short));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("1 byte(s) short (truncated)");
    expect(result.message).toContain(`${full.byteLength}`);
    expect(result.message).toContain(`${short.byteLength}`);
  });

  it("pins that a large truncation (beyond one facet) escapes the friendly diagnostic and surfaces as a UTF-8 error", async () => {
    // Truth pinned: the length-mismatch diagnostic is intentionally narrow
    // (documented in src/stl.ts) to avoid misclassifying ordinary ASCII STL
    // text as "almost binary". A truncation larger than one facet's width
    // falls outside that window and falls through to the ASCII parser,
    // which — for genuinely binary bytes — fails with a generic "not valid
    // UTF-8" message instead of a byte-accounting diagnostic. This is a
    // known, documented ambiguity, not a hidden defect.
    const full = binaryStl(5);
    const short = full.slice(0, full.byteLength - 100);
    // Force a byte that can never be valid UTF-8 so the fallback path is
    // deterministic regardless of what the truncated float bytes decode to.
    short[10] = 0xff;
    const result = await importModel(request(short));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("not valid UTF-8");
  });

  it("pins that a declared facet count of zero is rejected as having no triangles", async () => {
    // Truth pinned: an exact-length binary STL with a zero facet count is
    // classified as binary and then rejected by the shared triangle-count
    // guard (not a special-cased "empty mesh" success).
    const empty = binaryStl(0);
    const result = await importModel(request(empty));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain(
      "Geometry must contain at least one complete triangle",
    );
  });

  it("rejects a non-finite coordinate inside a binary facet", async () => {
    const withNaN = binaryStl(1, (view) => {
      view.setFloat32(BINARY_HEADER_BYTES + 12, NaN, true);
    });
    const result = await importModel(request(withNaN));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("non-finite coordinate");
  });

  it("rejects a non-finite (Infinity) coordinate inside a binary facet", async () => {
    const withInfinity = binaryStl(1, (view) => {
      view.setFloat32(BINARY_HEADER_BYTES + 16, Infinity, true);
    });
    const result = await importModel(request(withInfinity));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("imports a nonzero attribute byte count and reports it as unread rather than silently dropping it", async () => {
    const withAttribute = binaryStl(1, (view) => {
      view.setUint16(BINARY_HEADER_BYTES + 48, 7, true);
    });
    const result = await importModel(request(withAttribute));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.provenance.notes).toContainEqual(
      expect.stringContaining(
        "1 binary facet attribute field(s) were not interpreted",
      ),
    );
  });

  it("pins the known ambiguity: an exact-length binary file whose header text spells 'solid ' is still parsed as binary", async () => {
    // Truth pinned (audit-flagged ambiguity): STL format detection here is
    // purely length-based. A binary STL whose 80-byte header happens to
    // start with the ASCII text "solid " (legal and common in real binary
    // STL files) is still classified as binary because its length exactly
    // matches the declared facet count, even though the same prefix is what
    // ASCII STL files use to open a "solid" block. The bytes are read as
    // binary facet data, not as ASCII text.
    const bytes = binaryStl(1);
    bytes.set(encoder.encode("solid "), 0);
    const result = await importModel(request(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.positions.slice(0, 3)]).toEqual(
      [7, 8, 9],
    );
  });

  it("rejects non-UTF-8 bytes that are neither an exact-length nor near-length binary match", async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x01]);
    const result = await importModel(request(bytes));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("not valid UTF-8");
  });
});

describe("ASCII STL edge cases", () => {
  function wrap(vertexLine: string): string {
    return `solid generated
facet normal 0 0 1
outer loop
${vertexLine}
vertex 8 8 9
vertex 7 9 9
endloop
endfacet
endsolid generated
`;
  }

  it("accepts scientific notation and shorthand decimal forms", async () => {
    const result = await importModel(
      request(asciiStl(wrap("vertex 1e-3 .5 3."))),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.model.meshes[0]!.geometry.positions.slice(0, 3)]).toEqual(
      [1e-3, 0.5, 3],
    );
  });

  it("rejects NaN and Infinity tokens as they are not decimal literals", async () => {
    const nan = await importModel(request(asciiStl(wrap("vertex NaN 0 0"))));
    expect(nan).toMatchObject({ ok: false, code: "invalid-input" });

    const infinity = await importModel(
      request(asciiStl(wrap("vertex Infinity 0 0"))),
    );
    expect(infinity).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("accepts CRLF line endings", async () => {
    const body = wrap("vertex 1 2 3").replace(/\n/gu, "\r\n");
    const result = await importModel(request(asciiStl(body)));
    expect(result.ok).toBe(true);
  });

  it("accepts a solid name containing spaces", async () => {
    const body = `solid my part one
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid my part one
`;
    const result = await importModel(request(asciiStl(body)));
    expect(result.ok).toBe(true);
  });

  it("pins that a missing endsolid is accepted rather than rejected", async () => {
    // Truth pinned: nothing in the state machine requires a trailing
    // "endsolid" line — after the last endfacet the parser is already back
    // in the "outside" state, so end-of-input there is indistinguishable
    // from a well-formed close. This is lenient, not a crash risk, but it
    // means malformed/truncated closers are silently accepted.
    const body = `solid generated
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
`;
    const result = await importModel(request(asciiStl(body)));
    expect(result.ok).toBe(true);
  });

  it("rejects a file that ends mid-facet", async () => {
    const body = `solid generated
facet normal 0 0 1
outer loop
vertex 0 0 0
`;
    const result = await importModel(request(asciiStl(body)));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain("ended inside a facet");
  });

  it("rejects a line exceeding the maximum safety length", async () => {
    const body = `solid ${"a".repeat(1_100_000)}\nendsolid\n`;
    const result = await importModel(request(asciiStl(body)));
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
    if (result.ok) return;
    expect(result.message).toContain("exceeds the safety limit");
  });

  it("rejects an empty solid block as containing no triangles", async () => {
    const body = "solid empty\nendsolid empty\n";
    const result = await importModel(request(asciiStl(body)));
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    if (result.ok) return;
    expect(result.message).toContain(
      "Geometry must contain at least one complete triangle",
    );
  });
});
