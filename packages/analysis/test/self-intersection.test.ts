import {
  IDENTITY_MAT4,
  rigidTransformSchema,
  type NormalizedModel,
  type Vec3,
} from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import {
  SELF_INTERSECTION_LIMITS,
  checkSelfIntersections,
} from "../src/index.js";
import {
  customModel,
  disconnectedFacetModel,
  translation,
} from "./fixtures.js";

type Triangle = readonly [Vec3, Vec3, Vec3];
const base: Triangle = [
  [0, 0, 0],
  [4, 0, 0],
  [0, 4, 0],
];
function model(...triangles: Triangle[]): NormalizedModel {
  return customModel(
    "model.self",
    [
      {
        id: "mesh.surface",
        positions: triangles.flat(2),
        indices: triangles.flatMap((_, i) => [3 * i, 3 * i + 1, 3 * i + 2]),
      },
    ],
    {
      kind: "flat",
      instances: [
        {
          id: "instance.surface",
          meshId: "mesh.surface",
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
  );
}
function complete(...triangles: Triangle[]) {
  const result = checkSelfIntersections(model(...triangles));
  expect(result.state).toBe("complete");
  if (result.state !== "complete") throw new Error(result.reason);
  return result;
}

describe("bounded exact self-intersection evidence", () => {
  it("reports a proper transverse intersection with source triangle locations", () => {
    const result = complete(base, [
      [1, 1, -1],
      [1, 1, 1],
      [2, 1, 1],
    ]);
    expect(result.pairCount).toBe(1);
    expect(result.pairs[0]).toMatchObject({
      kind: "noncoplanar-intersection",
      first: {
        triangleIndex: 0,
        meshLocalTriangleIndex: 0,
        meshId: "mesh.surface",
        instanceId: "instance.surface",
      },
      second: { triangleIndex: 1, meshLocalTriangleIndex: 1 },
    });
    expect(result.pairs[0]!.first.positionsMillimetres).toEqual(base);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it("rejects separated triangles, including parallel planes with overlapping boxes", () => {
    expect(
      complete(base, [
        [0, 0, 1],
        [4, 0, 1],
        [0, 4, 1],
      ]).pairCount,
    ).toBe(0);
    expect(
      complete(base, [
        [3, 3, 0],
        [4, 3, 0],
        [3, 4, 0],
      ]).pairCount,
    ).toBe(0);
  });
  it("distinguishes coplanar positive-area overlap and reversed duplicate facets", () => {
    expect(
      complete(base, [
        [1, 1, 0],
        [3, 1, 0],
        [1, 3, 0],
      ]).pairs[0]!.kind,
    ).toBe("coplanar-overlap");
    expect(complete(base, [base[2], base[1], base[0]]).pairs[0]!.kind).toBe(
      "duplicate",
    );
  });
  it("suppresses contact confined to one shared coordinate vertex or edge", () => {
    expect(
      complete(base, [
        [0, 0, 0],
        [-1, 0, 1],
        [0, -1, 1],
      ]).pairCount,
    ).toBe(0);
    expect(
      complete(base, [
        [0, 0, 0],
        [4, 0, 0],
        [0, -4, 0],
      ]).pairCount,
    ).toBe(0);
    expect(
      complete(base, [
        [0, 0, 0],
        [4, 0, 0],
        [0, 0, 4],
      ]).pairCount,
    ).toBe(0);
  });
  it("does not hide an overlap or crossing extending beyond an adjacent shared feature", () => {
    expect(
      complete(base, [
        [0, 0, 0],
        [4, 0, 0],
        [1, 1, 0],
      ]).pairs[0]!.kind,
    ).toBe("coplanar-overlap");
    expect(
      complete(base, [
        [0, 0, 0],
        [2, 2, -1],
        [2, 2, 1],
      ]).pairs[0]!.kind,
    ).toBe("noncoplanar-intersection");
    expect(
      complete(base, [
        [0, 0, 0],
        [2, 0, 0],
        [1, -1, 0],
      ]).pairs[0]!.kind,
    ).toBe("coplanar-contact");
  });
  it("reports nonadjacent point and segment contact without calling either a volume collision", () => {
    expect(
      complete(base, [
        [2, 0, 0],
        [1, -1, 1],
        [3, -1, 1],
      ]).pairs[0]!.kind,
    ).toBe("point-contact");
    expect(
      complete(base, [
        [1, 0, 0],
        [3, 0, 0],
        [2, -1, 0],
      ]).pairs[0]!.kind,
    ).toBe("coplanar-contact");
  });
  it("is invariant to corner winding/order and handles dyadic decimal coordinates", () => {
    const other: Triangle = [
      [1, 1, -1],
      [1, 1, 1],
      [2, 1, 1],
    ];
    for (const a of [
      base,
      [base[1], base[2], base[0]],
      [base[2], base[1], base[0]],
    ] as Triangle[]) {
      for (const b of [other, [other[2], other[1], other[0]]] as Triangle[])
        expect(complete(a, b).pairCount).toBe(1);
    }
    const scaled = (t: Triangle) =>
      t.map(
        (p) => p.map((v) => v / 8) as unknown as Vec3,
      ) as unknown as Triangle;
    expect(complete(scaled(base), scaled(other)).pairCount).toBe(1);
  });
  it("uses the same exact coplanar predicates in every principal plane", () => {
    const overlap: Triangle = [
      [1, 1, 0],
      [3, 1, 0],
      [1, 3, 0],
    ];
    const contact: Triangle = [
      [1, 0, 0],
      [3, 0, 0],
      [2, -1, 0],
    ];
    for (const order of [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
    ]) {
      const permute = (t: Triangle) =>
        t.map(
          (p) => order.map((i) => p[i]!) as unknown as Vec3,
        ) as unknown as Triangle;
      expect(complete(permute(base), permute(overlap)).pairs[0]!.kind).toBe(
        "coplanar-overlap",
      );
      expect(complete(permute(base), permute(contact)).pairs[0]!.kind).toBe(
        "coplanar-contact",
      );
    }
  });
  it("does not weld a one-ULP plane separation or silently repair large translated geometry", () => {
    const elevated = base.map(
      (p) => [p[0], p[1], 1] as Vec3,
    ) as unknown as Triangle;
    const adjacentPlane = base.map(
      (p) => [p[0], p[1], 1 + Number.EPSILON] as Vec3,
    ) as unknown as Triangle;
    expect(complete(elevated, adjacentPlane).pairCount).toBe(0);
    const huge: NormalizedModel = {
      ...model(base),
      placement: {
        kind: "flat",
        instances: [
          {
            id: model(base).placement.instances[0]!.id,
            meshId: model(base).meshes[0]!.id,
            meshToModel: [1e308, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
        ],
      },
    };
    expect(checkSelfIntersections(huge)).toMatchObject({
      state: "indeterminate",
      reason: "unsupported-numeric-domain",
    });
  });
  it("preserves complete totals when output is truncated, with deterministic pair ordering", () => {
    const source = model(base, base, base);
    const result = checkSelfIntersections(source, { maxReportedPairs: 1 });
    expect(result).toMatchObject({
      state: "complete",
      pairCount: 3,
      truncated: true,
      pairs: [{ first: { triangleIndex: 0 }, second: { triangleIndex: 1 } }],
    });
    expect(checkSelfIntersections(source, { maxReportedPairs: 1 })).toEqual(
      result,
    );
    expect(
      checkSelfIntersections(source, { maxReportedPairs: 0 }),
    ).toMatchObject({
      state: "complete",
      pairCount: 3,
      truncated: true,
      pairs: [],
    });
  });
  it("retains verified evidence but no total or clear verdict when candidate work is incomplete", () => {
    const result = checkSelfIntersections(model(base, base, base), {
      maxCandidatePairs: 1,
    });
    expect(result).toMatchObject({
      state: "indeterminate",
      reason: "resource-limit",
      testedPairCount: 1,
      observedPairCount: 1,
    });
    expect(result.pairs).toHaveLength(1);
    expect(result).not.toHaveProperty("pairCount");
  });
  it("fails closed on degeneracy, sub-domain exponents, huge coordinates and resource budgets", () => {
    expect(
      checkSelfIntersections(
        model(base, [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ]),
      ),
    ).toMatchObject({ state: "indeterminate", reason: "degenerate-triangle" });
    expect(
      checkSelfIntersections(
        model([
          [0, 0, 0],
          [1e-40, 0, 0],
          [0, 1, 0],
        ]),
      ),
    ).toMatchObject({
      state: "indeterminate",
      reason: "unsupported-numeric-domain",
    });
    expect(
      checkSelfIntersections(
        model([
          [1e13, 0, 0],
          [1e13, 1, 0],
          [1e13, 0, 1],
        ]),
      ),
    ).toMatchObject({
      state: "indeterminate",
      reason: "unsupported-numeric-domain",
    });
    for (const executionBudget of [{ maxWorkUnits: 1 }, { maxMemoryBytes: 1 }])
      expect(
        checkSelfIntersections(model(base), { executionBudget }),
      ).toMatchObject({ state: "indeterminate", reason: "resource-limit" });
    expect(
      checkSelfIntersections(
        disconnectedFacetModel(
          "model.large",
          SELF_INTERSECTION_LIMITS.triangles + 1,
        ),
      ),
    ).toMatchObject({ state: "indeterminate", reason: "resource-limit" });
  });
  it("accepts the minimum exact dyadic exponent and maximum coordinate magnitude", () => {
    expect(
      complete([
        [0, 0, 0],
        [2 ** -128, 0, 0],
        [0, 1, 0],
      ]).pairCount,
    ).toBe(0);
    expect(
      complete([
        [1e12, 0, 0],
        [1e12, 1, 0],
        [1e12, 0, 1],
      ]).pairCount,
    ).toBe(0);
  });
  it("cancels before geometry work and cooperatively during traversal", () => {
    expect(
      checkSelfIntersections(model(base), { isCancelled: () => true }),
    ).toMatchObject({ state: "indeterminate", reason: "cancelled" });
    let calls = 0;
    const result = checkSelfIntersections(model(base, base, base), {
      isCancelled: () => ++calls > 14,
    });
    expect(result).toMatchObject({
      state: "indeterminate",
      reason: "cancelled",
    });
    expect(checkSelfIntersections(model(base, base))).toMatchObject({
      state: "complete",
      pairCount: 1,
    });
  });
  it("rejects invalid caller options rather than claiming a geometric outcome", () => {
    expect(() =>
      checkSelfIntersections(model(base), { maxReportedPairs: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      checkSelfIntersections(model(base), { maxCandidatePairs: Infinity }),
    ).toThrow(RangeError);
    expect(() =>
      checkSelfIntersections(model(base), {
        executionBudget: { maxWorkUnits: NaN },
      }),
    ).toThrow(RangeError);
  });
  it("resolves repeated instances and hierarchical transforms without altering source buffers", () => {
    const source = customModel(
      "model.instances",
      [{ id: "mesh.reused", positions: base.flat(), indices: [0, 1, 2] }],
      {
        kind: "hierarchy",
        rootIds: ["node.root"],
        nodes: [
          {
            id: "node.root",
            localToParent: IDENTITY_MAT4,
            childIds: ["node.placed"],
            instanceIds: ["instance.first"],
          },
          {
            id: "node.placed",
            localToParent: translation(1, 0, 0),
            childIds: [],
            instanceIds: ["instance.second"],
          },
        ],
        instances: [
          {
            id: "instance.first",
            meshId: "mesh.reused",
            meshToNode: IDENTITY_MAT4,
          },
          {
            id: "instance.second",
            meshId: "mesh.reused",
            meshToNode: IDENTITY_MAT4,
          },
        ],
      },
    );
    const original = [...source.meshes[0]!.geometry.positions];
    const result = checkSelfIntersections(source, {
      modelToComparison: rigidTransformSchema.parse(translation(0, 0, 5)),
    });
    expect(result).toMatchObject({
      state: "complete",
      pairCount: 1,
      pairs: [
        {
          first: { instanceId: "instance.first", meshLocalTriangleIndex: 0 },
          second: { instanceId: "instance.second", meshLocalTriangleIndex: 0 },
        },
      ],
    });
    expect(result.pairs[0]!.second.positionsMillimetres).toEqual([
      [1, 0, 5],
      [5, 0, 5],
      [1, 4, 5],
    ]);
    expect([...source.meshes[0]!.geometry.positions]).toEqual(original);
  });

  it("matches an independent analytic plane/segment oracle over an exhaustive integer grid", () => {
    // A at z=0 occupies -2<=x<=2, -2<=y<=-x. B intersects z=0
    // at x=k on the segment y in [y-1,y]. The scalar interval oracle
    // uses no production predicate, determinant, or BVH code.
    const a: Triangle = [
      [-2, -2, 0],
      [2, -2, 0],
      [-2, 2, 0],
    ];
    for (let k = -4; k <= 4; k++)
      for (let y = -4; y <= 4; y++) {
        const b: Triangle = [
          [k, y - 1, -1],
          [k, y - 1, 1],
          [k, y + 1, 1],
        ];
        const expected = k >= -2 && k <= 2 && y >= -2 && y - 1 <= -k;
        expect(complete(a, b).pairCount, `x=${k}, y=${y}`).toBe(
          expected ? 1 : 0,
        );
      }
  });
  it("matches independent coplanar half-space feasibility on an exhaustive integer translation grid", () => {
    const a: Triangle = [
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 0],
    ];
    for (let x = -3; x <= 3; x++)
      for (let y = -3; y <= 3; y++) {
        // Both triangles require X>=max(0,x), Y>=max(0,y),
        // X+Y<=min(2,x+y+2). Strict inequality means positive area.
        const lower = Math.max(0, x) + Math.max(0, y),
          upper = Math.min(2, x + y + 2);
        if (lower === upper) continue; // boundary contacts have separate explicit tests.
        const b: Triangle = [
          [x, y, 0],
          [x + 2, y, 0],
          [x, y + 2, 0],
        ];
        expect(complete(a, b).pairCount, `x=${x}, y=${y}`).toBe(
          lower < upper ? 1 : 0,
        );
      }
  });
});
