import { IDENTITY_MAT4, rigidTransformSchema } from "@voxelspy/contracts";
import type { RigidTransform } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import { flattenModel } from "../src/geometry.js";
import {
  TriangleLocatorInputError,
  flattenedTriangleLocator,
  resolveFlattenedTriangle,
} from "../src/index.js";
import { anchoredTriangle, customModel, translation } from "./fixtures.js";
import { UNMETERED_WORK } from "./test-utils.js";

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

/** Three single-triangle meshes, instantiated in a deliberately unsorted order relative to `model.meshes` -- see `flatten-order.test.ts` for the same fixture shape and why it exercises order fidelity. */
function multiMeshModel() {
  return customModel(
    "locator-multi-mesh",
    [
      { id: "mesh-a", ...anchoredTriangle(10) },
      { id: "mesh-b", ...anchoredTriangle(20) },
      { id: "mesh-c", ...anchoredTriangle(30) },
    ],
    {
      kind: "flat",
      instances: [
        { id: "inst-c", meshId: "mesh-c", meshToModel: IDENTITY_MAT4 },
        { id: "inst-a", meshId: "mesh-a", meshToModel: IDENTITY_MAT4 },
        { id: "inst-b", meshId: "mesh-b", meshToModel: IDENTITY_MAT4 },
      ],
    },
  );
}

/** One two-triangle mesh, instantiated three times at unsorted x-translations -- exercises multi-instance provenance and mesh-local triangle order together. */
function multiInstanceModel() {
  const dualTriMesh = {
    id: "dual-tri-mesh",
    positions: [
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0, // mesh-local triangle 0, anchor (0,0,0)
      5,
      0,
      0,
      6,
      0,
      0,
      5,
      1,
      0, // mesh-local triangle 1, anchor (5,0,0)
    ],
    indices: [0, 1, 2, 3, 4, 5],
  };
  return customModel("locator-multi-instance", [dualTriMesh], {
    kind: "flat",
    instances: [
      {
        id: "inst-x100",
        meshId: dualTriMesh.id,
        meshToModel: translation(100),
      },
      { id: "inst-x0", meshId: dualTriMesh.id, meshToModel: translation(0) },
      {
        id: "inst-x200",
        meshId: dualTriMesh.id,
        meshToModel: translation(200),
      },
    ],
  });
}

describe("flattenedTriangleLocator: positions and provenance", () => {
  it("resolves the first, a middle, and the last flattened triangle of a multi-mesh model to their correct world-space positions and provenance", () => {
    const model = multiMeshModel();
    const locator = flattenedTriangleLocator(model);

    expect(locator.triangleCount).toBe(3);

    const first = locator.resolve(0);
    expect(first.meshId).toBe("mesh-c");
    expect(first.instanceId).toBe("inst-c");
    expect(first.meshLocalTriangleIndex).toBe(0);
    expect(first.positionsMillimetres).toEqual([
      [30, 0, 0],
      [31, 0, 0],
      [30, 1, 0],
    ]);

    const middle = locator.resolve(1);
    expect(middle.meshId).toBe("mesh-a");
    expect(middle.instanceId).toBe("inst-a");
    expect(middle.meshLocalTriangleIndex).toBe(0);
    expect(middle.positionsMillimetres).toEqual([
      [10, 0, 0],
      [11, 0, 0],
      [10, 1, 0],
    ]);

    const last = locator.resolve(2);
    expect(last.meshId).toBe("mesh-b");
    expect(last.instanceId).toBe("inst-b");
    expect(last.meshLocalTriangleIndex).toBe(0);
    expect(last.positionsMillimetres).toEqual([
      [20, 0, 0],
      [21, 0, 0],
      [20, 1, 0],
    ]);
  });

  it("resolves correct provenance across multiple instances of the same mesh, including mesh-local triangle index cycling per instance", () => {
    const model = multiInstanceModel();
    const locator = flattenedTriangleLocator(model);

    expect(locator.triangleCount).toBe(6);

    const expected: readonly {
      readonly instanceId: string;
      readonly meshLocalTriangleIndex: number;
      readonly anchor: readonly [number, number, number];
    }[] = [
      {
        instanceId: "inst-x100",
        meshLocalTriangleIndex: 0,
        anchor: [100, 0, 0],
      },
      {
        instanceId: "inst-x100",
        meshLocalTriangleIndex: 1,
        anchor: [105, 0, 0],
      },
      { instanceId: "inst-x0", meshLocalTriangleIndex: 0, anchor: [0, 0, 0] },
      { instanceId: "inst-x0", meshLocalTriangleIndex: 1, anchor: [5, 0, 0] },
      {
        instanceId: "inst-x200",
        meshLocalTriangleIndex: 0,
        anchor: [200, 0, 0],
      },
      {
        instanceId: "inst-x200",
        meshLocalTriangleIndex: 1,
        anchor: [205, 0, 0],
      },
    ];

    expected.forEach((expectation, triangleIndex) => {
      const location = locator.resolve(triangleIndex);
      expect(location.triangleIndex).toBe(triangleIndex);
      expect(location.meshId).toBe("dual-tri-mesh");
      expect(location.instanceId).toBe(expectation.instanceId);
      expect(location.meshLocalTriangleIndex).toBe(
        expectation.meshLocalTriangleIndex,
      );
      expect(location.positionsMillimetres[0]).toEqual([...expectation.anchor]);
    });
  });

  it("honors a supplied modelToComparison, applied identically to resolved positions", () => {
    const model = multiInstanceModel();
    const locator = flattenedTriangleLocator(model, {
      modelToComparison: rigidTransformSchema.parse(translation(0, 1000, 0)),
    });
    const location = locator.resolve(0);
    expect(location.positionsMillimetres).toEqual([
      [100, 1000, 0],
      [101, 1000, 0],
      [100, 1001, 0],
    ]);
  });
});

describe("flattenedTriangleLocator: out-of-range rejection", () => {
  const model = multiMeshModel();

  it.each([-1, 3, 3.5, Number.NaN, Number.POSITIVE_INFINITY, -0.5])(
    "rejects triangleIndex %p as out of range",
    (triangleIndex) => {
      const locator = flattenedTriangleLocator(model);
      expect(() => locator.resolve(triangleIndex)).toThrow(
        TriangleLocatorInputError,
      );
    },
  );

  it("rejects an out-of-range index through the resolveFlattenedTriangle convenience wrapper too", () => {
    expect(() => resolveFlattenedTriangle(model, 99)).toThrow(
      TriangleLocatorInputError,
    );
  });

  it("accepts every valid boundary index (0 and triangleCount - 1)", () => {
    const locator = flattenedTriangleLocator(model);
    expect(() => locator.resolve(0)).not.toThrow();
    expect(() => locator.resolve(locator.triangleCount - 1)).not.toThrow();
  });
});

describe("flattenedTriangleLocator: determinism and agreement with direct flattening", () => {
  it("produces deeply equal results across repeated locator builds and resolve calls for the same input", () => {
    const model = multiInstanceModel();
    const firstRun = flattenedTriangleLocator(model);
    const secondRun = flattenedTriangleLocator(model);

    for (
      let triangleIndex = 0;
      triangleIndex < firstRun.triangleCount;
      triangleIndex += 1
    ) {
      expect(firstRun.resolve(triangleIndex)).toEqual(
        secondRun.resolve(triangleIndex),
      );
      // Calling `resolve` twice on the same locator must also agree with
      // itself -- resolution reads from precomputed, immutable state only.
      expect(firstRun.resolve(triangleIndex)).toEqual(
        firstRun.resolve(triangleIndex),
      );
    }
  });

  it("resolveFlattenedTriangle agrees with an equivalent flattenedTriangleLocator call", () => {
    const model = multiMeshModel();
    const locator = flattenedTriangleLocator(model);
    for (
      let triangleIndex = 0;
      triangleIndex < locator.triangleCount;
      triangleIndex += 1
    ) {
      expect(resolveFlattenedTriangle(model, triangleIndex)).toEqual(
        locator.resolve(triangleIndex),
      );
    }
  });

  it("agrees exactly with a directly-flattened reference geometry, for both the multi-mesh and multi-instance fixtures", () => {
    for (const model of [multiMeshModel(), multiInstanceModel()]) {
      const locator = flattenedTriangleLocator(model);
      const reference = flattenModel(model, IDENTITY_RIGID, UNMETERED_WORK);

      expect(locator.geometry.triangleCount).toBe(reference.triangleCount);
      expect(locator.geometry.vertexCount).toBe(reference.vertexCount);
      expect([...locator.geometry.positions]).toEqual([...reference.positions]);
      expect([...locator.geometry.indices]).toEqual([...reference.indices]);

      for (
        let triangleIndex = 0;
        triangleIndex < reference.triangleCount;
        triangleIndex += 1
      ) {
        const base = triangleIndex * 3;
        const ia = reference.indices[base]!;
        const ib = reference.indices[base + 1]!;
        const ic = reference.indices[base + 2]!;
        const readVertex = (vertexIndex: number): [number, number, number] => [
          reference.positions[vertexIndex * 3]!,
          reference.positions[vertexIndex * 3 + 1]!,
          reference.positions[vertexIndex * 3 + 2]!,
        ];
        const expectedPositions = [
          readVertex(ia),
          readVertex(ib),
          readVertex(ic),
        ];

        expect(locator.resolve(triangleIndex).positionsMillimetres).toEqual(
          expectedPositions,
        );
      }
    }
  });
});
