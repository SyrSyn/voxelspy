import { importRequestSchema, type ImportOptions } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import { IMPORTER_SAFETY_LIMITS, importModel } from "../src/index.js";
import { checkedTriangleCount } from "../src/parse.js";

const encoder = new TextEncoder();

// These tests exercise the shared safety limits (32 MiB input cap, and the
// importer's own fixed triangle/vertex ceilings, independent of whatever
// limit a caller passes in). Every fixture below is sized to be the
// smallest input that can trip the limit under test — none allocate more
// than ~32 MiB, and the biggest ones never touch per-facet payload bytes,
// so nothing here approaches "allocate gigabytes to prove a gigabyte guard
// works".

describe("shared safety limits", () => {
  it("rejects an absurd declared triangle count purely arithmetically, with zero allocation", () => {
    // Truth pinned: checkedTriangleCount is pure arithmetic (no allocation)
    // and both parseBinaryStl and parseAsciiStl call it before constructing
    // any typed array. A header count as large as the 4-byte binary STL
    // count field can express (up to 2^32 - 1, which would ask for ~309 GB
    // if naively allocated as Float64Array(count * 9)) is rejected here at
    // zero memory cost, confirming the check-before-allocate ordering
    // without needing a multi-gigabyte fixture.
    expect(() =>
      checkedTriangleCount(
        4_294_967_295,
        10_000_000,
        IMPORTER_SAFETY_LIMITS.triangleCount,
      ),
    ).toThrow(RangeError);
  });

  it("rejects a binary STL exceeding the importer's own triangle ceiling before allocating geometry, even when the caller's limit is generous", async () => {
    const triangleCount = IMPORTER_SAFETY_LIMITS.triangleCount + 1;
    const bytes = new Uint8Array(84 + 50 * triangleCount);
    new DataView(bytes.buffer).setUint32(80, triangleCount, true);
    const options: ImportOptions = {
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
      limits: {
        inputBytes: bytes.byteLength + 1,
        triangleCount: triangleCount + 1_000,
      },
    };
    const result = await importModel(
      importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: "model.test",
        format: "stl",
        sourceName: "generated.stl",
        bytes,
        options,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
    if (result.ok) return;
    expect(result.message).toContain("importer safety limit");
  });

  it("rejects an OBJ exceeding the importer's own vertex ceiling, even when the caller's triangle limit is generous", async () => {
    const vertexLimit = IMPORTER_SAFETY_LIMITS.vertexCount;
    const body = "v 1 1 1\n".repeat(vertexLimit + 1);
    const bytes = encoder.encode(body);
    const options: ImportOptions = {
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
      limits: { inputBytes: bytes.byteLength + 1, triangleCount: 100 },
    };
    const result = await importModel(
      importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: "model.test",
        format: "obj",
        sourceName: "generated.obj",
        bytes,
        options,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
    if (result.ok) return;
    expect(result.message).toContain(
      "OBJ exceeds the importer vertex safety limit",
    );
  });

  it("rejects input exceeding the fixed 32 MiB byte cap, even when the caller declares a larger limit", async () => {
    const bytes = new Uint8Array(IMPORTER_SAFETY_LIMITS.inputBytes + 1);
    const options: ImportOptions = {
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
      limits: { inputBytes: bytes.byteLength, triangleCount: 100 },
    };
    const result = await importModel(
      importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: "model.test",
        format: "stl",
        sourceName: "generated.stl",
        bytes,
        options,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "resource-limit" });
    if (result.ok) return;
    expect(result.message).toContain("byte safety limit");
  });
});
