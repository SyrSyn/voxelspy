import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import { regionSurfaceGeometry, toRenderPositions } from "./Workbench";

describe("workbench rendering coordinates", () => {
  it("preserves small differences at large world offsets", () => {
    const positions = toRenderPositions(
      new Float64Array([1_000_000_000, 2, 3, 1_000_000_000.5, 2, 3]),
      new Matrix4(),
      new Vector3(1_000_000_000, 0, 0),
    );
    expect([...positions]).toEqual([0, 2, 3, 0.5, 2, 3]);
  });

  it("builds semantic overlays from the referenced source triangles", () => {
    const model = normalizedModelSchema.parse({
      contractVersion: 1,
      id: "model.overlay",
      frame: CANONICAL_FRAME,
      meshes: [
        {
          id: "mesh.overlay",
          geometry: {
            positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
          },
        },
      ],
      placement: {
        kind: "flat",
        instances: [
          {
            id: "instance.overlay",
            meshId: "mesh.overlay",
            meshToModel: IDENTITY_MAT4,
          },
        ],
      },
      warnings: [],
      provenance: {
        formatId: "test",
        importerId: "test",
        importerVersion: "1",
        sourceName: "overlay.test",
        detectedSourceUnit: "millimetre",
        detectedSourceAxis: "right-handed-z-up",
        sourceUnit: "millimetre",
        sourceAxis: "right-handed-z-up",
        sourceResolution: { unit: "embedded", axis: "embedded" },
        appliedSourceToModel: IDENTITY_MAT4,
        notes: [],
      },
    });

    const geometry = regionSurfaceGeometry(
      model,
      new Matrix4(),
      [1],
      new Vector3(),
    );
    expect([...geometry.getAttribute("position").array]).toEqual([
      0, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    geometry.dispose();
  });
});
