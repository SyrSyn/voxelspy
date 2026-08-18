import { IDENTITY_MAT4, rigidTransformSchema } from "@voxelspy/contracts";
import type { Mat4, RigidTransform } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import { flattenModel } from "../src/geometry.js";
import {
  UNIT_TRIANGLE,
  anchoredTriangle,
  customModel,
  translation,
} from "./fixtures.js";
import { UNMETERED_WORK } from "./test-utils.js";

/**
 * These tests PIN `flattenModel`'s documented traversal order (see its doc
 * comment in `src/geometry.ts`) behaviourally: every fixture below places
 * each triangle at its own distinct, hand-computed world-space position, so
 * a specific flattened `triangleIndex` can only match its expected vertex
 * positions if the mesh-instance walk and per-mesh triangle order are
 * exactly as documented. If a future change reorders mesh iteration,
 * instance expansion, or the placement-tree walk, these positions stop
 * lining up and the assertions fail loudly -- unlike count- or
 * distance-only tests, which cannot detect a reordering at all.
 */

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

function rigid(matrix: Mat4): RigidTransform {
  return rigidTransformSchema.parse(matrix);
}

function expectTriangle(
  geometry: ReturnType<typeof flattenModel>,
  triangleIndex: number,
  expected: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ],
): void {
  const base = triangleIndex * 3;
  const ia = geometry.indices[base]!;
  const ib = geometry.indices[base + 1]!;
  const ic = geometry.indices[base + 2]!;
  const readVertex = (vertexIndex: number): [number, number, number] => [
    geometry.positions[vertexIndex * 3]!,
    geometry.positions[vertexIndex * 3 + 1]!,
    geometry.positions[vertexIndex * 3 + 2]!,
  ];
  expect([readVertex(ia), readVertex(ib), readVertex(ic)]).toEqual(
    expected.map((vertex) => [...vertex]),
  );
}

describe("flattenModel traversal order (pinned, not re-derived)", () => {
  it("flat placement: follows placement.instances array order, not model.meshes declaration order", () => {
    // Meshes are declared A, B, C -- but the instances that place them are
    // deliberately listed C, A, B. If flattening ever iterated
    // `model.meshes` instead of `placement.instances`, this test would fail.
    const model = customModel(
      "multi-mesh",
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

    const geometry = flattenModel(model, IDENTITY_RIGID, UNMETERED_WORK);

    expect(geometry.triangleCount).toBe(3);
    expectTriangle(geometry, 0, [
      [30, 0, 0],
      [31, 0, 0],
      [30, 1, 0],
    ]); // inst-c / mesh-c
    expectTriangle(geometry, 1, [
      [10, 0, 0],
      [11, 0, 0],
      [10, 1, 0],
    ]); // inst-a / mesh-a
    expectTriangle(geometry, 2, [
      [20, 0, 0],
      [21, 0, 0],
      [20, 1, 0],
    ]); // inst-b / mesh-b
  });

  it("flat placement: multiple instances of the same mesh preserve both instance order and mesh-local triangle order", () => {
    // One mesh with two distinguishable triangles (anchors x=0 and x=5),
    // instantiated three times at deliberately unsorted x-translations
    // (100, 0, 200). Each instance must contribute its own two triangles
    // consecutively, in mesh-local order (triangle 0 then triangle 1), and
    // instances must appear in `placement.instances` array order.
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
        0, // triangle 0, anchor (0,0,0)
        5,
        0,
        0,
        6,
        0,
        0,
        5,
        1,
        0, // triangle 1, anchor (5,0,0)
      ],
      indices: [0, 1, 2, 3, 4, 5],
    };
    const model = customModel("multi-instance", [dualTriMesh], {
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

    const geometry = flattenModel(model, IDENTITY_RIGID, UNMETERED_WORK);

    expect(geometry.triangleCount).toBe(6);
    expectTriangle(geometry, 0, [
      [100, 0, 0],
      [101, 0, 0],
      [100, 1, 0],
    ]); // inst-x100, mesh-local triangle 0
    expectTriangle(geometry, 1, [
      [105, 0, 0],
      [106, 0, 0],
      [105, 1, 0],
    ]); // inst-x100, mesh-local triangle 1
    expectTriangle(geometry, 2, [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]); // inst-x0, mesh-local triangle 0
    expectTriangle(geometry, 3, [
      [5, 0, 0],
      [6, 0, 0],
      [5, 1, 0],
    ]); // inst-x0, mesh-local triangle 1
    expectTriangle(geometry, 4, [
      [200, 0, 0],
      [201, 0, 0],
      [200, 1, 0],
    ]); // inst-x200, mesh-local triangle 0
    expectTriangle(geometry, 5, [
      [205, 0, 0],
      [206, 0, 0],
      [205, 1, 0],
    ]); // inst-x200, mesh-local triangle 1
  });

  it("hierarchy placement: pre-order depth-first walk -- roots in order, each node's own instances before its children, children in childIds order, nested transforms compose", () => {
    // Tree shape:
    //   root-a (own instance, y-offset 1)
    //     -> child-a1 (own instance, y-offset 2; x-offset 100 from root-a)
    //          -> grandchild-a1a (own instance, y-offset 3; x-offset +10 from child-a1)
    //     -> child-a2 (own instance, y-offset 4; x-offset 200 from root-a)
    //   root-b (own instance, y-offset 5)
    //
    // Every node-to-node and instance-to-node transform is a pure
    // translation, so composed world positions are exact integer sums --
    // this pins both the *order* instances are queued in and that nested
    // `localToParent`/`meshToNode` transforms compose correctly along the
    // walk, not just that some transform was applied.
    const model = customModel(
      "hierarchy",
      [{ id: "unit-tri", ...UNIT_TRIANGLE }],
      {
        kind: "hierarchy",
        instances: [
          {
            id: "inst-root-a",
            meshId: "unit-tri",
            meshToNode: translation(0, 1, 0),
          },
          {
            id: "inst-child-a1",
            meshId: "unit-tri",
            meshToNode: translation(0, 2, 0),
          },
          {
            id: "inst-grandchild-a1a",
            meshId: "unit-tri",
            meshToNode: translation(0, 3, 0),
          },
          {
            id: "inst-child-a2",
            meshId: "unit-tri",
            meshToNode: translation(0, 4, 0),
          },
          {
            id: "inst-root-b",
            meshId: "unit-tri",
            meshToNode: translation(0, 5, 0),
          },
        ],
        rootIds: ["root-a", "root-b"],
        nodes: [
          {
            id: "root-a",
            childIds: ["child-a1", "child-a2"],
            instanceIds: ["inst-root-a"],
            localToParent: IDENTITY_MAT4,
          },
          {
            id: "child-a1",
            childIds: ["grandchild-a1a"],
            instanceIds: ["inst-child-a1"],
            localToParent: translation(100, 0, 0),
          },
          {
            id: "grandchild-a1a",
            childIds: [],
            instanceIds: ["inst-grandchild-a1a"],
            localToParent: translation(10, 0, 0),
          },
          {
            id: "child-a2",
            childIds: [],
            instanceIds: ["inst-child-a2"],
            localToParent: translation(200, 0, 0),
          },
          {
            id: "root-b",
            childIds: [],
            instanceIds: ["inst-root-b"],
            localToParent: IDENTITY_MAT4,
          },
        ],
      },
    );

    const geometry = flattenModel(model, IDENTITY_RIGID, UNMETERED_WORK);

    expect(geometry.triangleCount).toBe(5);
    expectTriangle(geometry, 0, [
      [0, 1, 0],
      [1, 1, 0],
      [0, 2, 0],
    ]); // root-a's own instance
    expectTriangle(geometry, 1, [
      [100, 2, 0],
      [101, 2, 0],
      [100, 3, 0],
    ]); // child-a1's own instance
    expectTriangle(geometry, 2, [
      [110, 3, 0],
      [111, 3, 0],
      [110, 4, 0],
    ]); // grandchild-a1a's own instance
    expectTriangle(geometry, 3, [
      [200, 4, 0],
      [201, 4, 0],
      [200, 5, 0],
    ]); // child-a2's own instance
    expectTriangle(geometry, 4, [
      [0, 5, 0],
      [1, 5, 0],
      [0, 6, 0],
    ]); // root-b's own instance
  });

  it("applies modelToComparison on top of the same documented order (order itself is independent of the transform's value)", () => {
    const model = customModel(
      "with-comparison-transform",
      [{ id: "unit-tri", ...UNIT_TRIANGLE }],
      {
        kind: "flat",
        instances: [
          {
            id: "inst-1",
            meshId: "unit-tri",
            meshToModel: translation(1, 0, 0),
          },
          {
            id: "inst-2",
            meshId: "unit-tri",
            meshToModel: translation(2, 0, 0),
          },
        ],
      },
    );

    const geometry = flattenModel(
      model,
      rigid(translation(0, 100, 0)),
      UNMETERED_WORK,
    );

    expect(geometry.triangleCount).toBe(2);
    expectTriangle(geometry, 0, [
      [1, 100, 0],
      [2, 100, 0],
      [1, 101, 0],
    ]);
    expectTriangle(geometry, 1, [
      [2, 100, 0],
      [3, 100, 0],
      [2, 101, 0],
    ]);
  });
});
