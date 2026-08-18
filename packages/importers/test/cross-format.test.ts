import { importRequestSchema, type ImportOptions } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import { importModel } from "../src/index.js";
import {
  normalizePositions,
  sourceToModelTransform,
} from "../src/normalize.js";

const encoder = new TextEncoder();

describe("cross-format axis/unit conversion", () => {
  it("applies a non-default unit and Y-up axis to OBJ input identically to the pure normalize functions, and records the same transform in provenance", async () => {
    // Axis/unit conversion is otherwise only exercised through STL fixtures.
    // This pins that OBJ goes through the same normalize path with the same
    // result, and that the transform recorded in provenance is exactly the
    // one that was applied to the coordinates (not just "a" transform).
    const options: ImportOptions = {
      userUnit: "inch",
      userAxis: "right-handed-y-up",
      limits: { inputBytes: 1_000_000, triangleCount: 100 },
    };
    const body = "v 1 2 3\nv 2 2 3\nv 1 3 3\nf 1 2 3\n";
    const result = await importModel(
      importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: "model.test",
        format: "obj",
        sourceName: "generated.obj",
        bytes: encoder.encode(body),
        options,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedPositions = normalizePositions(
      [1, 2, 3, 2, 2, 3, 1, 3, 3],
      "inch",
      "right-handed-y-up",
    );
    expect([...result.model.meshes[0]!.geometry.positions]).toEqual([
      ...expectedPositions,
    ]);

    const expectedTransform = sourceToModelTransform(
      "inch",
      "right-handed-y-up",
    );
    expect(result.model.provenance.appliedSourceToModel).toEqual(
      expectedTransform,
    );
    expect(result.model.provenance).toMatchObject({
      sourceUnit: "inch",
      sourceAxis: "right-handed-y-up",
      sourceResolution: { unit: "user", axis: "user" },
    });
  });
});
