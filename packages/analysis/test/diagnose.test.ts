import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import {
  InspectionResourceLimitError,
  diagnoseMeshHealth,
} from "../src/index.js";
import {
  duplicatedFaceBoxModel,
  facetLocalTripleJunctionModel,
} from "./adversarial-fixtures.js";
import { boxModel, disconnectedFacetModel, triangleModel } from "./fixtures.js";

/** The canonical box, but with its top and bottom faces removed, leaving two separate square boundary loops (z=0 and z=size). */
function tubeBoxModel(id: string, size: readonly [number, number, number]) {
  const base = boxModel(id, size);
  const mesh = base.meshes[0]!;
  return normalizedModelSchema.parse({
    ...base,
    meshes: [
      {
        ...mesh,
        geometry: {
          positions: mesh.geometry.positions,
          // Drops the first two faces (bottom + top; see BOX_INDICES in
          // test/fixtures.ts) -- both quads, 6 indices each.
          indices: mesh.geometry.indices.slice(12),
        },
      },
    ],
  });
}

/** Two triangles sharing edge A(0,0,0)-B(2,0,0) traversed in the SAME direction by both -- an inconsistently oriented edge. */
function inconsistentOrientationModel(id: string) {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: {
          positions: new Float64Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, -2, 0]),
          // Triangle 1: A(0)->B(1)->C(2). Triangle 2: A(0)->B(1)->D(3).
          // Both traverse the shared edge A->B the same way.
          indices: new Uint32Array([0, 1, 2, 0, 1, 3]),
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `${id}.instance`,
          meshId: `${id}.mesh`,
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "diagnose-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: ["Two triangles sharing one identically-directed edge."],
    },
  });
}

describe("diagnoseMeshHealth", () => {
  it("finds no boundary loops or issue segments for a watertight box", () => {
    const model = boxModel("watertight", [2, 3, 4]);
    const result = diagnoseMeshHealth(model);

    expect(result.modelId).toBe("watertight");
    expect(result.boundaryLoops).toEqual({
      loops: [],
      loopCount: 0,
      loopsTruncated: false,
    });
    expect(result.nonManifoldEdges).toEqual({
      segments: [],
      count: 0,
      truncated: false,
    });
    expect(result.inconsistentOrientationEdges).toEqual({
      segments: [],
      count: 0,
      truncated: false,
    });
    expect(result.degenerateTriangles).toEqual({
      triangles: [],
      count: 0,
      truncated: false,
    });
  });

  it("traces an open box (missing one face) as exactly one closed boundary loop", () => {
    const model = boxModel("open-box", [2, 2, 2], { open: true });
    const result = diagnoseMeshHealth(model);

    expect(result.boundaryLoops.loopCount).toBe(1);
    expect(result.boundaryLoops.loopsTruncated).toBe(false);
    const [loop] = result.boundaryLoops.loops;
    expect(loop).toBeDefined();
    expect(loop!.edgeCount).toBe(4);
    expect(loop!.closed).toBe(true);
    expect(loop!.pointsTruncated).toBe(false);
    expect(loop!.pointsMillimetres).toHaveLength(4);
    expect(loop!.perimeterMillimetres).toBeCloseTo(8, 10);

    // Every point lies on the box's x=2 face (the face `open: true` removes).
    for (const point of loop!.pointsMillimetres) {
      expect(point[0]).toBe(2);
    }
  });

  it("orders two separate holes deterministically (descending edge count, then ascending canonical start point)", () => {
    const model = tubeBoxModel("tube", [2, 2, 2]);
    const result = diagnoseMeshHealth(model);

    expect(result.boundaryLoops.loopCount).toBe(2);
    expect(result.boundaryLoops.loops).toHaveLength(2);
    const [first, second] = result.boundaryLoops.loops;
    expect(first!.edgeCount).toBe(4);
    expect(second!.edgeCount).toBe(4);
    expect(first!.closed).toBe(true);
    expect(second!.closed).toBe(true);

    // The z=0 loop's canonical start point sorts before the z=2 loop's.
    for (const point of first!.pointsMillimetres) expect(point[2]).toBe(0);
    for (const point of second!.pointsMillimetres) expect(point[2]).toBe(2);
  });

  it("does not crash tracing a non-manifold triple junction, and reports its non-manifold edge segment", () => {
    const model = facetLocalTripleJunctionModel("triple-junction");
    const result = diagnoseMeshHealth(model);

    // Every boundary edge is accounted for across whatever chains it forms,
    // whether or not each one happens to close into a clean loop.
    const totalBoundaryEdges = result.boundaryLoops.loops.reduce(
      (sum, loop) => sum + loop.edgeCount,
      0,
    );
    // No truncation at default bounds for this tiny fixture, so every
    // discovered chain is present in `loops`.
    expect(result.boundaryLoops.loopsTruncated).toBe(false);
    expect(totalBoundaryEdges).toBe(6);

    expect(result.nonManifoldEdges.count).toBe(1);
    expect(result.nonManifoldEdges.truncated).toBe(false);
    const [segment] = result.nonManifoldEdges.segments;
    expect(segment).toBeDefined();
    expect(segment!.endpointsMillimetres).toHaveLength(2);
    expect(segment!.triangleIndices.slice().sort()).toEqual([0, 1, 2]);
  });

  it("lists degenerate triangles with their triangle index and three positions", () => {
    const model = triangleModel("degenerate");
    model.meshes[0]!.geometry.positions[3] = 0;
    model.meshes[0]!.geometry.positions[4] = 0;

    const result = diagnoseMeshHealth(model);
    expect(result.degenerateTriangles.count).toBe(1);
    expect(result.degenerateTriangles.truncated).toBe(false);
    const [entry] = result.degenerateTriangles.triangles;
    expect(entry).toBeDefined();
    expect(entry!.triangleIndex).toBe(0);
    expect(entry!.positionsMillimetres).toHaveLength(3);

    // Tracing boundary loops on a degenerate (self-coincident-vertex)
    // triangle must not crash either.
    expect(() => result.boundaryLoops).not.toThrow();
  });

  it("lists an inconsistently oriented edge as a segment", () => {
    const model = inconsistentOrientationModel("inconsistent");
    const result = diagnoseMeshHealth(model);

    expect(result.inconsistentOrientationEdges.count).toBe(1);
    expect(result.inconsistentOrientationEdges.truncated).toBe(false);
    const [segment] = result.inconsistentOrientationEdges.segments;
    expect(segment).toBeDefined();
    expect(segment!.triangleIndices.slice().sort()).toEqual([0, 1]);
    // Shared edge is A(0,0,0)-B(2,0,0).
    const endpoints = segment!.endpointsMillimetres
      .map((point) => point.join(","))
      .sort();
    expect(endpoints).toEqual(["0,0,0", "2,0,0"]);
  });

  it("truncates boundary loops by count and records loopsTruncated", () => {
    // Five fully disconnected triangles, each forming its own closed
    // 3-edge boundary loop.
    const model = disconnectedFacetModel("disconnected-loops", 5);
    const result = diagnoseMeshHealth(model, { maxBoundaryLoops: 2 });

    expect(result.boundaryLoops.loopCount).toBe(5);
    expect(result.boundaryLoops.loops).toHaveLength(2);
    expect(result.boundaryLoops.loopsTruncated).toBe(true);
    for (const loop of result.boundaryLoops.loops) {
      expect(loop.edgeCount).toBe(3);
      expect(loop.closed).toBe(true);
      expect(loop.pointsTruncated).toBe(false);
    }
  });

  it("truncates a boundary loop's own points by the shared point budget, keeping edgeCount/closed/perimeter exact", () => {
    const model = disconnectedFacetModel("disconnected-points", 3);
    const result = diagnoseMeshHealth(model, {
      maxBoundaryLoops: 10,
      maxBoundaryLoopPoints: 2,
    });

    expect(result.boundaryLoops.loopCount).toBe(3);
    expect(result.boundaryLoops.loopsTruncated).toBe(true);
    const [loop] = result.boundaryLoops.loops;
    expect(loop).toBeDefined();
    expect(loop!.pointsMillimetres).toHaveLength(2);
    expect(loop!.pointsTruncated).toBe(true);
    expect(loop!.edgeCount).toBe(3);
    expect(loop!.closed).toBe(true);
    expect(loop!.perimeterMillimetres).toBeGreaterThan(0);
  });

  it("truncates non-manifold edge segments deterministically and records truncation", () => {
    // Every one of the box's 18 triangulated edges (12 cube edges + 6 face
    // diagonals) is shared by 4 triangle usages once every triangle is
    // duplicated.
    const model = duplicatedFaceBoxModel("duplicated-faces");
    const result = diagnoseMeshHealth(model, { maxIssueItems: 3 });

    expect(result.nonManifoldEdges.count).toBe(18);
    expect(result.nonManifoldEdges.segments).toHaveLength(3);
    expect(result.nonManifoldEdges.truncated).toBe(true);
  });

  it("is deterministic across repeated runs and a structurally-identical rebuilt model", () => {
    const model = tubeBoxModel("determinism", [3, 4, 5]);
    const first = diagnoseMeshHealth(model);
    const second = diagnoseMeshHealth(model);
    expect(first).toEqual(second);

    const rebuilt = tubeBoxModel("determinism", [3, 4, 5]);
    expect(diagnoseMeshHealth(rebuilt)).toEqual(first);
  });

  it("rejects invalid option bounds instead of silently clamping them", () => {
    const model = boxModel("bounds", [1, 1, 1]);
    expect(() => diagnoseMeshHealth(model, { maxBoundaryLoops: -1 })).toThrow(
      RangeError,
    );
    expect(() => diagnoseMeshHealth(model, { maxBoundaryLoops: 501 })).toThrow(
      RangeError,
    );
    expect(() =>
      diagnoseMeshHealth(model, { maxBoundaryLoopPoints: 50_001 }),
    ).toThrow(RangeError);
    expect(() => diagnoseMeshHealth(model, { maxIssueItems: -1 })).toThrow(
      RangeError,
    );
    expect(() => diagnoseMeshHealth(model, { maxIssueItems: 2_001 })).toThrow(
      RangeError,
    );
  });

  it("fails closed with a typed resource-limit error on hostile triangle counts, before any topology work runs", () => {
    const triangleCount = 1_000_001;
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array(triangleCount * 3);
    for (let index = 0; index < indices.length; index += 1) {
      indices[index] = index % 3;
    }
    const model = normalizedModelSchema.parse({
      contractVersion: 1,
      id: "hostile",
      frame: CANONICAL_FRAME,
      meshes: [{ id: "hostile.mesh", geometry: { positions, indices } }],
      placement: {
        kind: "flat",
        instances: [
          {
            id: "hostile.instance",
            meshId: "hostile.mesh",
            meshToModel: IDENTITY_MAT4,
          },
        ],
      },
      warnings: [],
      provenance: {
        formatId: "generated-fixture",
        importerId: "diagnose-test-fixture",
        importerVersion: "1.0.0",
        sourceName: "hostile.generated",
        detectedSourceUnit: "millimetre",
        detectedSourceAxis: "right-handed-z-up",
        sourceUnit: "millimetre",
        sourceAxis: "right-handed-z-up",
        sourceResolution: { unit: "embedded", axis: "embedded" },
        appliedSourceToModel: IDENTITY_MAT4,
        notes: ["One triangle definition repeated past the triangle ceiling."],
      },
    });

    expect(() => diagnoseMeshHealth(model)).toThrow(
      InspectionResourceLimitError,
    );
  });

  it("rejects a model that fails contract-schema validation", () => {
    const invalid = { not: "a model" };
    expect(() =>
      diagnoseMeshHealth(
        invalid as unknown as Parameters<typeof diagnoseMeshHealth>[0],
      ),
    ).toThrow();
  });
});
