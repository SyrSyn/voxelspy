import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  importRequestSchema,
  normalizedModelSchema,
  type ImportOptions,
  type Mat4,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import {
  EXPORTER_SAFETY_LIMITS,
  ExportInputError,
  ExportResourceLimitError,
  ExportUnsupportedTargetError,
  exportModel,
  formatNumber,
  importModel,
  type ExportFormat,
} from "../src/index.js";
import {
  applyMat4,
  modelToTargetTransform,
  multiplyMat4,
  sourceToModelTransform,
  type ResolvedSourceAxis,
  type ResolvedSourceUnit,
} from "../src/normalize.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const declaredFrame: ImportOptions = {
  declaredUnit: "millimetre",
  declaredAxis: "right-handed-z-up",
  limits: { inputBytes: 1_000_000, triangleCount: 1_000 },
};

function importRequest(format: "stl" | "obj", bytes: Uint8Array) {
  return importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: "model.export-test",
    format,
    sourceName: `generated.${format}`,
    bytes,
    options: declaredFrame,
  });
}

/** A single well-shaped, non-axis-aligned triangle: every coordinate distinct, so any axis mixup or scale error is detectable. */
async function fixtureModel(): Promise<NormalizedModel> {
  const body = `solid fixture
facet normal 0 0 1
outer loop
vertex 7 8 9
vertex 11 8 9.5
vertex 7 12.25 9
endloop
endfacet
endsolid fixture
`;
  const result = await importModel(importRequest("stl", encoder.encode(body)));
  if (!result.ok) throw new Error(`fixture import failed: ${result.message}`);
  return result.model;
}

/** Builds a schema-valid flat-placement `NormalizedModel` directly, for cases the round-trip fixture above cannot express (multiple meshes/instances, boundary-sized geometry). */
function flatModel(
  meshes: readonly {
    readonly id: string;
    readonly positions: readonly number[];
    readonly indices: readonly number[];
  }[],
  instances?: readonly {
    readonly id: string;
    readonly meshId: string;
    readonly meshToModel?: Mat4;
  }[],
): NormalizedModel {
  const meshRecords = meshes.map((mesh) => ({
    id: mesh.id,
    geometry: {
      positions: Float64Array.from(mesh.positions),
      indices: Uint32Array.from(mesh.indices),
    },
  }));
  const resolvedInstances: readonly {
    readonly id: string;
    readonly meshId: string;
    readonly meshToModel?: Mat4;
  }[] =
    instances ??
    meshes.map((mesh) => ({ id: `instance.${mesh.id}`, meshId: mesh.id }));
  const instanceRecords = resolvedInstances.map((instance) => ({
    id: instance.id,
    meshId: instance.meshId,
    meshToModel: instance.meshToModel ?? IDENTITY_MAT4,
  }));
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id: "model.export-test",
    frame: CANONICAL_FRAME,
    meshes: meshRecords,
    placement: { kind: "flat", instances: instanceRecords },
    warnings: [],
    provenance: {
      formatId: "test",
      importerId: "test.importer",
      importerVersion: "0.0.0",
      sourceName: "test-fixture",
      detectedSourceUnit: "unknown",
      detectedSourceAxis: "unknown",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "user", axis: "user" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [],
    },
  });
}

async function reimport(
  format: ExportFormat,
  bytes: Uint8Array,
  targetUnit: ResolvedSourceUnit,
  targetAxis: ResolvedSourceAxis,
): Promise<NormalizedModel> {
  const importFormat = format === "obj" ? "obj" : "stl";
  const result = await importModel(
    importRequestSchema.parse({
      contractVersion: 1,
      targetModelId: "model.reimported",
      format: importFormat,
      sourceName: `roundtrip.${importFormat}`,
      bytes,
      options: {
        userUnit: targetUnit,
        userAxis: targetAxis,
        limits: { inputBytes: 40_000_000, triangleCount: 100 },
      },
    }),
  );
  if (!result.ok) throw new Error(`reimport failed: ${result.message}`);
  return result.model;
}

/**
 * Binary STL stores coordinates as float32; reimporting through this
 * package's own parser (`parseBinaryStl`, `getFloat32`) recovers exactly
 * the float32-rounded value, then the same linear unit/axis transform is
 * applied on the way back in as was applied on the way out -- so the only
 * error is the float32 rounding of the ORIGINAL millimetre value itself,
 * bounded by its own relative float32 precision (2^-23), independent of
 * whatever unit was chosen for the file in between.
 */
function float32Tolerance(originalMillimetreValue: number): number {
  return Math.max(Math.abs(originalMillimetreValue) * 2 ** -22, 1e-9);
}

describe("exportModel: STL and OBJ round trips", () => {
  it("round-trips ASCII STL with exact float equality", async () => {
    const model = await fixtureModel();
    const result = await exportModel(model, {
      targetFormat: "stl-ascii",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const reimported = await reimport(
      "stl-ascii",
      result.bytes,
      "millimetre",
      "right-handed-z-up",
    );
    expect([...reimported.meshes[0]!.geometry.positions]).toEqual([
      ...model.meshes[0]!.geometry.positions,
    ]);
    expect([...reimported.meshes[0]!.geometry.indices]).toEqual([
      ...model.meshes[0]!.geometry.indices,
    ]);
  });

  it("round-trips OBJ with exact float equality", async () => {
    const model = await fixtureModel();
    const result = await exportModel(model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const reimported = await reimport(
      "obj",
      result.bytes,
      "millimetre",
      "right-handed-z-up",
    );
    expect([...reimported.meshes[0]!.geometry.positions]).toEqual([
      ...model.meshes[0]!.geometry.positions,
    ]);
    expect([...reimported.meshes[0]!.geometry.indices]).toEqual([
      ...model.meshes[0]!.geometry.indices,
    ]);
  });

  it("round-trips binary STL within documented float32 tolerance, not exact equality", async () => {
    const model = await fixtureModel();
    const result = await exportModel(model, {
      targetFormat: "stl-binary",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const reimported = await reimport(
      "stl-binary",
      result.bytes,
      "millimetre",
      "right-handed-z-up",
    );
    const original = [...model.meshes[0]!.geometry.positions];
    const actual = [...reimported.meshes[0]!.geometry.positions];
    expect(actual).toHaveLength(original.length);
    original.forEach((expected, index) => {
      expect(Math.abs(actual[index]! - expected)).toBeLessThanOrEqual(
        float32Tolerance(expected),
      );
    });
  });

  it("produces geometrically equivalent output between binary and ASCII STL, within float32 tolerance", async () => {
    const model = await fixtureModel();
    const ascii = await exportModel(model, {
      targetFormat: "stl-ascii",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const binary = await exportModel(model, {
      targetFormat: "stl-binary",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const asciiReimported = await reimport(
      "stl-ascii",
      ascii.bytes,
      "millimetre",
      "right-handed-z-up",
    );
    const binaryReimported = await reimport(
      "stl-binary",
      binary.bytes,
      "millimetre",
      "right-handed-z-up",
    );
    const exact = [...asciiReimported.meshes[0]!.geometry.positions];
    const approximate = [...binaryReimported.meshes[0]!.geometry.positions];
    exact.forEach((expected, index) => {
      expect(Math.abs(approximate[index]! - expected)).toBeLessThanOrEqual(
        float32Tolerance(expected),
      );
    });
  });

  it("applies a non-default unit and axis, reports it in appliedModelToTarget, and round-trips exactly through OBJ", async () => {
    const model = await fixtureModel();
    const result = await exportModel(model, {
      targetFormat: "obj",
      targetUnit: "inch",
      targetAxis: "right-handed-y-up",
    });
    expect(result.targetUnit).toBe("inch");
    expect(result.targetAxis).toBe("right-handed-y-up");
    expect(result.appliedModelToTarget).toEqual(
      modelToTargetTransform("inch", "right-handed-y-up"),
    );
    // The applied transform must be the exact algebraic inverse of the
    // transform an import declaring the same unit/axis would apply.
    const roundTrip = multiplyMat4(
      sourceToModelTransform("inch", "right-handed-y-up"),
      result.appliedModelToTarget,
    );
    roundTrip.forEach((value, index) => {
      expect(value).toBeCloseTo(IDENTITY_MAT4[index]!, 12);
    });

    // A non-millimetre target unit divides every coordinate by a
    // non-power-of-two scale factor (25.4 for inch); re-importing
    // multiplies by that same factor. `formatNumber`'s text round trip is
    // still exact for the divided value actually written (asserted
    // separately below), but the division-then-multiplication pair is
    // ordinary IEEE-754 arithmetic, not a guaranteed exact inverse -- so
    // this compares within double-precision tolerance, not exact equality.
    // See this file's "millimetre and axis-only conversions are exact"
    // test below for the case that IS exact.
    const reimported = await reimport(
      "obj",
      result.bytes,
      "inch",
      "right-handed-y-up",
    );
    const original = [...model.meshes[0]!.geometry.positions];
    const actual = [...reimported.meshes[0]!.geometry.positions];
    original.forEach((expected, index) => {
      expect(actual[index]).toBeCloseTo(expected, 12);
    });
  });

  it("round-trips exactly when the target unit is millimetre, even with an axis change (Z-up/Y-up is sign flip and permutation only, never a lossy multiply)", async () => {
    const model = await fixtureModel();
    const result = await exportModel(model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-y-up",
    });
    const reimported = await reimport(
      "obj",
      result.bytes,
      "millimetre",
      "right-handed-y-up",
    );
    expect([...reimported.meshes[0]!.geometry.positions]).toEqual([
      ...model.meshes[0]!.geometry.positions,
    ]);
  });

  it("emits an OBJ file this package's own importer accepts without error", async () => {
    const model = await fixtureModel();
    const result = await exportModel(model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const text = decoder.decode(result.bytes);
    expect(text).toMatch(/^v /mu);
    expect(text).toMatch(/^f /mu);
    expect(text).not.toContain("mtllib");
    expect(text).not.toContain("vn ");
    const reimported = await reimport(
      "obj",
      result.bytes,
      "millimetre",
      "right-handed-z-up",
    );
    expect(reimported.meshes[0]!.geometry.indices.length).toBe(3);
  });
});

describe("exportModel: determinism", () => {
  it("produces byte-identical output for identical model and options", async () => {
    const model = await fixtureModel();
    const options = {
      targetFormat: "stl-binary" as const,
      targetUnit: "centimetre" as const,
      targetAxis: "right-handed-y-up" as const,
    };
    const first = await exportModel(model, options);
    const second = await exportModel(model, options);
    expect([...first.bytes]).toEqual([...second.bytes]);
    expect(first.digest).toEqual(second.digest);
  });

  it("produces byte-identical OBJ output across repeated calls", async () => {
    const model = await fixtureModel();
    const options = {
      targetFormat: "obj" as const,
      targetUnit: "millimetre" as const,
      targetAxis: "right-handed-z-up" as const,
    };
    const first = await exportModel(model, options);
    const second = await exportModel(model, options);
    expect([...first.bytes]).toEqual([...second.bytes]);
    expect(first.digest).toEqual(second.digest);
  });
});

describe("exportModel: honesty about what the file cannot carry", () => {
  it("always warns that the target format cannot declare a unit or axis", async () => {
    const model = await fixtureModel();
    for (const targetFormat of ["stl-binary", "stl-ascii", "obj"] as const) {
      const result = await exportModel(model, {
        targetFormat,
        targetUnit: "millimetre",
        targetAxis: "right-handed-z-up",
      });
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "export.unit-not-declared" }),
      );
    }
  });

  it("warns when multiple meshes and instances are flattened into one triangle soup", async () => {
    const model = flatModel([
      {
        id: "mesh.a",
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      },
      {
        id: "mesh.b",
        positions: [5, 5, 5, 6, 5, 5, 5, 6, 5],
        indices: [0, 1, 2],
      },
    ]);
    const result = await exportModel(model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(result.geometry.triangleCount).toBe(2);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "export.instances-flattened",
        details: { meshCount: 2, instanceCount: 2 },
      }),
    );
    const reimported = await reimport(
      "obj",
      result.bytes,
      "millimetre",
      "right-handed-z-up",
    );
    expect(reimported.meshes[0]!.geometry.indices.length).toBe(6);
  });

  it("does not warn about flattening for a single mesh, single instance model", async () => {
    const model = flatModel([
      {
        id: "mesh.a",
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      },
    ]);
    const result = await exportModel(model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(
      result.warnings.some((w) => w.code === "export.instances-flattened"),
    ).toBe(false);
  });

  it("warns about degenerate (zero-area) facet normals for STL, and notes normals are computed rather than sourced", async () => {
    const model = flatModel([
      {
        id: "mesh.degenerate",
        positions: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        indices: [0, 1, 2],
      },
    ]);
    const result = await exportModel(model, {
      targetFormat: "stl-ascii",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "export.degenerate-facet-normals" }),
    );
    expect(
      result.notes.some((note) => note.includes("computed geometrically")),
    ).toBe(true);
  });

  it("notes that OBJ output carries no material library", async () => {
    const model = await fixtureModel();
    const result = await exportModel(model, {
      targetFormat: "obj",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(result.notes.some((note) => note.includes("material"))).toBe(true);
  });
});

describe("exportModel: fail-closed behavior", () => {
  it("rejects an unsupported target format", async () => {
    const model = await fixtureModel();
    await expect(
      exportModel(model, {
        targetFormat: "step" as unknown as ExportFormat,
        targetUnit: "millimetre",
        targetAxis: "right-handed-z-up",
      }),
    ).rejects.toBeInstanceOf(ExportUnsupportedTargetError);
  });

  it("rejects an invalid target unit", async () => {
    const model = await fixtureModel();
    await expect(
      exportModel(model, {
        targetFormat: "obj",
        targetUnit: "bogus-unit" as unknown as ResolvedSourceUnit,
        targetAxis: "right-handed-z-up",
      }),
    ).rejects.toBeInstanceOf(ExportInputError);
  });

  it("rejects an invalid target axis", async () => {
    const model = await fixtureModel();
    await expect(
      exportModel(model, {
        targetFormat: "obj",
        targetUnit: "millimetre",
        targetAxis: "bogus-axis" as unknown as ResolvedSourceAxis,
      }),
    ).rejects.toBeInstanceOf(ExportInputError);
  });

  it("rejects flattened geometry that exceeds the exporter triangle safety limit, purely arithmetically", async () => {
    const overLimitTriangleCount = EXPORTER_SAFETY_LIMITS.triangleCount + 1;
    const indices = Uint32Array.from(
      { length: overLimitTriangleCount * 3 },
      (_, index) => index % 3,
    );
    const model = flatModel([
      {
        id: "mesh.over",
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [...indices],
      },
    ]);
    await expect(
      exportModel(model, {
        targetFormat: "stl-binary",
        targetUnit: "millimetre",
        targetAxis: "right-handed-z-up",
      }),
    ).rejects.toBeInstanceOf(ExportResourceLimitError);
  });

  it("rejects flattened geometry that exceeds the exporter vertex safety limit, purely arithmetically", async () => {
    // A single zero-filled typed array (no per-element construction) with
    // far more vertices than the safety limit, referenced by only one
    // triangle -- vertex count, not triangle count, is what should trip
    // this limit.
    const overLimitVertexCount = EXPORTER_SAFETY_LIMITS.vertexCount + 1;
    const oversized = normalizedModelSchema.parse({
      contractVersion: 1,
      id: "model.export-test",
      frame: CANONICAL_FRAME,
      meshes: [
        {
          id: "mesh.over-vertex",
          geometry: {
            positions: new Float64Array(overLimitVertexCount * 3),
            indices: Uint32Array.from([0, 1, 2]),
          },
        },
      ],
      placement: {
        kind: "flat",
        instances: [
          {
            id: "instance.over-vertex",
            meshId: "mesh.over-vertex",
            meshToModel: IDENTITY_MAT4,
          },
        ],
      },
      warnings: [],
      provenance: {
        formatId: "test",
        importerId: "test.importer",
        importerVersion: "0.0.0",
        sourceName: "test-fixture",
        detectedSourceUnit: "unknown",
        detectedSourceAxis: "unknown",
        sourceUnit: "millimetre",
        sourceAxis: "right-handed-z-up",
        sourceResolution: { unit: "user", axis: "user" },
        appliedSourceToModel: IDENTITY_MAT4,
        notes: [],
      },
    });
    await expect(
      exportModel(oversized, {
        targetFormat: "obj",
        targetUnit: "millimetre",
        targetAxis: "right-handed-z-up",
      }),
    ).rejects.toBeInstanceOf(ExportResourceLimitError);
  });

  it("rejects an invalid model", async () => {
    await expect(
      exportModel({ not: "a model" } as unknown as NormalizedModel, {
        targetFormat: "obj",
        targetUnit: "millimetre",
        targetAxis: "right-handed-z-up",
      }),
    ).rejects.toThrow();
  });
});

describe("formatNumber: canonical round-trip number formatting", () => {
  it("round-trips representative finite doubles exactly, including subnormal-scale and large-exponent values", () => {
    const values = [
      0,
      -0,
      1,
      -1,
      0.1,
      -0.1,
      7.5,
      1 / 3,
      1e21,
      1e-8,
      123456789.123456,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_VALUE,
    ];
    for (const value of values) {
      expect(Number(formatNumber(value))).toBe(
        Object.is(value, -0) ? 0 : value,
      );
    }
  });

  it("rejects non-finite values", () => {
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(
      ExportInputError,
    );
    expect(() => formatNumber(Number.NaN)).toThrow(ExportInputError);
  });
});

describe("modelToTargetTransform: exact inverse of sourceToModelTransform", () => {
  it("composes to the identity for every resolved unit and axis", () => {
    const units: readonly ResolvedSourceUnit[] = [
      "micrometre",
      "millimetre",
      "centimetre",
      "metre",
      "inch",
      "foot",
    ];
    const axes: readonly ResolvedSourceAxis[] = [
      "right-handed-z-up",
      "right-handed-y-up",
    ];
    for (const unit of units) {
      for (const axis of axes) {
        const forward = sourceToModelTransform(unit, axis);
        const backward = modelToTargetTransform(unit, axis);
        const point = applyMat4(backward, ...applyMat4(forward, 3, 5, 11));
        expect(point[0]).toBeCloseTo(3, 9);
        expect(point[1]).toBeCloseTo(5, 9);
        expect(point[2]).toBeCloseTo(11, 9);
      }
    }
  });
});
