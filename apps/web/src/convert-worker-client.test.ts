import {
  importRequestSchema,
  modelIdSchema,
  type ImportResult,
  type NormalizedModel,
} from "@voxelspy/contracts";
import {
  exportModel,
  importModel,
  type ExportFormat,
} from "@voxelspy/importers";
import { simplifyModel } from "@voxelspy/analysis";
import { describe, expect, it } from "vitest";

/**
 * Coverage for the round trip `ConvertFlow`'s "Export and download" button
 * actually performs: `simplifyModel` (optionally) then `exportModel`, both
 * called exactly the way `convert.worker.ts` calls them, followed by
 * re-importing the produced bytes with `importModel`. Exercised here as a
 * plain Node-side unit test rather than a browser download -- more reliable
 * than asserting on a Playwright `download` event's bytes, and this package
 * already imports `@voxelspy/importers`/`@voxelspy/analysis` directly in
 * other `*.test.ts` files (see `session.test.ts`, `sample-models.test.ts`)
 * for the same reason.
 *
 * The fixture is a 10mm axis-aligned box (12 triangles, 8 vertices, one
 * vertex deliberately at a non-round 12.345mm coordinate so the binary-STL
 * float32 precision claim in `ConvertFlow.tsx`'s `precisionNote` has
 * something to actually measure).
 */

function boxFacets(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): string {
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  const vertices: Record<number, readonly [number, number, number]> = {
    0: [minX, minY, minZ],
    1: [maxX, minY, minZ],
    2: [maxX, maxY, minZ],
    3: [minX, maxY, minZ],
    4: [minX, minY, maxZ],
    5: [maxX, minY, maxZ],
    6: [maxX, maxY, maxZ],
    7: [minX, maxY, maxZ],
  };
  const faces: readonly (readonly [number, number, number])[] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [3, 6, 2],
    [3, 7, 6],
    [0, 4, 7],
    [0, 7, 3],
    [1, 2, 6],
    [1, 6, 5],
  ];
  return faces
    .map(([i1, i2, i3]) => {
      const v1 = vertices[i1]!.join(" ");
      const v2 = vertices[i2]!.join(" ");
      const v3 = vertices[i3]!.join(" ");
      return `facet normal 0 0 0\nouter loop\nvertex ${v1}\nvertex ${v2}\nvertex ${v3}\nendloop\nendfacet`;
    })
    .join("\n");
}

const boxStl = `solid convert-fixture-box\n${boxFacets([0, 0, 0], [10, 10, 12.345])}\nendsolid convert-fixture-box\n`;

async function importBoxModel(): Promise<NormalizedModel> {
  const request = importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: modelIdSchema.parse("model.convert-test"),
    format: "stl",
    sourceName: "convert-fixture-box.stl",
    bytes: new TextEncoder().encode(boxStl),
    options: {
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
      limits: { inputBytes: 32 * 1024 * 1024, triangleCount: 500_000 },
    },
  });
  const result: ImportResult = await importModel(request);
  if (!result.ok) throw new Error(result.message);
  return result.model;
}

async function reimport(
  bytes: Uint8Array,
  format: ExportFormat,
  sourceName: string,
): Promise<NormalizedModel> {
  const request = importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: modelIdSchema.parse("model.convert-test.reimported"),
    format: format === "obj" ? "obj" : "stl",
    sourceName,
    bytes,
    options: {
      userUnit: "millimetre",
      userAxis: "right-handed-z-up",
      limits: { inputBytes: 32 * 1024 * 1024, triangleCount: 500_000 },
    },
  });
  const result: ImportResult = await importModel(request);
  if (!result.ok) throw new Error(result.message);
  return result.model;
}

function placedCounts(model: NormalizedModel): {
  triangleCount: number;
  vertexCount: number;
} {
  const meshById = new Map(
    model.meshes.map((mesh) => [mesh.id, mesh.geometry]),
  );
  let triangleCount = 0;
  let vertexCount = 0;
  for (const instance of model.placement.instances) {
    const geometry = meshById.get(instance.meshId)!;
    triangleCount += geometry.indices.length / 3;
    vertexCount += geometry.positions.length / 3;
  }
  return { triangleCount, vertexCount };
}

describe("export -> re-import equivalence (the download this tool produces)", () => {
  it.each(["stl-binary", "stl-ascii", "obj"] as const)(
    "the original model's %s bytes re-import to the same placed triangle and vertex counts",
    async (format) => {
      const model = await importBoxModel();
      const original = placedCounts(model);

      const exported = await exportModel(model, {
        targetFormat: format,
        targetUnit: "millimetre",
        targetAxis: "right-handed-z-up",
      });
      expect(exported.geometry.triangleCount).toBe(original.triangleCount);

      const reimported = await reimport(
        exported.bytes,
        format,
        `box.${format === "obj" ? "obj" : "stl"}`,
      );
      const roundTripped = placedCounts(reimported);
      expect(roundTripped.triangleCount).toBe(original.triangleCount);
      expect(roundTripped.vertexCount).toBe(original.vertexCount);
    },
  );

  it("exporting a simplified model re-imports to the SIMPLIFIED triangle count, not the original", async () => {
    const model = await importBoxModel();
    const simplified = simplifyModel(model, {
      target: { kind: "triangle-count", triangleCount: 10 },
    });
    expect(simplified.simplified.triangleCount).toBeLessThan(
      simplified.original.triangleCount,
    );

    const exported = await exportModel(simplified.model, {
      targetFormat: "stl-ascii",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    expect(exported.geometry.triangleCount).toBe(
      simplified.simplified.triangleCount,
    );

    const reimported = await reimport(
      exported.bytes,
      "stl-ascii",
      "box.simplified.stl",
    );
    expect(placedCounts(reimported).triangleCount).toBe(
      simplified.simplified.triangleCount,
    );
  });

  it("every export warns that the unit and axis cannot be recorded in the file, for every format", async () => {
    const model = await importBoxModel();
    for (const format of ["stl-binary", "stl-ascii", "obj"] as const) {
      const exported = await exportModel(model, {
        targetFormat: format,
        targetUnit: "inch",
        targetAxis: "right-handed-y-up",
      });
      const unitWarning = exported.warnings.find(
        (warning) => warning.code === "export.unit-not-declared",
      );
      expect(unitWarning).toBeDefined();
      expect(unitWarning?.message).toContain("inch");
    }
  });

  it("ASCII STL round-trips a millimetre coordinate bit-exactly; binary STL only to float32 precision", async () => {
    const model = await importBoxModel();

    const asciiExport = await exportModel(model, {
      targetFormat: "stl-ascii",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const asciiReimport = await reimport(
      asciiExport.bytes,
      "stl-ascii",
      "box.stl",
    );
    const asciiZ = Array.from(asciiReimport.meshes[0]!.geometry.positions).find(
      (value) => value !== 0 && value !== 10,
    );
    expect(asciiZ).toBe(12.345);

    const binaryExport = await exportModel(model, {
      targetFormat: "stl-binary",
      targetUnit: "millimetre",
      targetAxis: "right-handed-z-up",
    });
    const binaryReimport = await reimport(
      binaryExport.bytes,
      "stl-binary",
      "box.stl",
    );
    const binaryZ = Array.from(
      binaryReimport.meshes[0]!.geometry.positions,
    ).find((value) => value !== 0 && value !== 10);
    expect(binaryZ).not.toBe(12.345);
    expect(binaryZ).toBeCloseTo(12.345, 4);
  });
});
