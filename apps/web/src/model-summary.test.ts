import { analyzeModelPair, SURFACE_DISTANCE_METHOD } from "@voxelspy/analysis";
import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisResultSchema,
  analysisRequestSchema,
  normalizedModelSchema,
  type AnalysisResult,
  type Mat4,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import {
  summarizeModelComparison,
  summarizeModelGeometry,
} from "./model-summary";

const BOX_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4,
  7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
]);

describe("model presentation summaries", () => {
  it("uses hierarchical placement and comparison transforms with Float64 geometry", () => {
    const model = boxModel("baseline", [1, 1, 1], {
      placement: {
        kind: "hierarchy",
        instances: [
          {
            id: "baseline.instance",
            meshId: "baseline.mesh",
            meshToNode: scale(2, 3, 4),
          },
        ],
        rootIds: ["baseline.root"],
        nodes: [
          {
            id: "baseline.root",
            childIds: ["baseline.child"],
            instanceIds: [],
            localToParent: IDENTITY_MAT4,
          },
          {
            id: "baseline.child",
            childIds: [],
            instanceIds: ["baseline.instance"],
            localToParent: translation(10, 20, 30),
          },
        ],
      },
    });

    const summary = summarizeModelGeometry(model, translation(-5, 0, 0));

    expect(summary).toMatchObject({
      vertexCount: 8,
      triangleCount: 12,
      meshCount: 1,
      instanceCount: 1,
      componentCount: 1,
      bounds: {
        available: true,
        min: [5, 20, 30],
        max: [7, 23, 34],
        dimensionsMillimetres: [2, 3, 4],
      },
      surfaceAreaSquareMillimetres: 52,
    });
    expect(summary.volume).toMatchObject({
      available: true,
      absoluteCubicMillimetres: 24,
      topology: {
        boundaryEdgeCount: 0,
        nonManifoldEdgeCount: 0,
        inconsistentEdgeCount: 0,
        degenerateTriangleCount: 0,
      },
    });
    if (summary.volume.available) {
      expect(Math.abs(summary.volume.signedCubicMillimetres)).toBeCloseTo(24);
    }
  });

  it("reports directional deltas and a complete result with no regions", () => {
    const baseline = boxModel("baseline", [1, 2, 3]);
    const candidate = boxModel("candidate", [2, 3, 4]);
    const analysis = analyze(baseline, candidate);
    const summary = summarizeModelComparison(baseline, candidate, analysis);

    expect(summary.deltas.dimensionsMillimetres).toEqual({
      available: true,
      x: { baseline: 1, candidate: 2, difference: 1, direction: "increase" },
      y: { baseline: 2, candidate: 3, difference: 1, direction: "increase" },
      z: { baseline: 3, candidate: 4, difference: 1, direction: "increase" },
    });
    expect(summary.deltas.triangleCount.direction).toBe("unchanged");
    expect(summary.deltas.surfaceAreaSquareMillimetres).toMatchObject({
      baseline: 22,
      candidate: 52,
      difference: 30,
      direction: "increase",
    });
    expect(summary.deltas.absoluteVolumeCubicMillimetres).toMatchObject({
      available: true,
      baseline: 6,
      candidate: 24,
      difference: 18,
      direction: "increase",
    });

    const identical = boxModel("candidate", [1, 2, 3]);
    const noChange = summarizeModelComparison(
      baseline,
      identical,
      analyze(baseline, identical),
    );
    expect(noChange.analysis).toMatchObject({
      state: "complete",
      changeStatus: "no-regions",
      regionCount: 0,
      semantics: "approximate",
    });
  });

  it("recognizes exact shared edges in facet-local closed geometry", () => {
    const indexed = boxModel("indexed", [2, 3, 4]);
    const mesh = indexed.meshes[0]!;
    const facetLocalPositions = new Float64Array(
      mesh.geometry.indices.length * 3,
    );
    mesh.geometry.indices.forEach((vertexIndex, index) => {
      facetLocalPositions.set(
        mesh.geometry.positions.slice(vertexIndex * 3, vertexIndex * 3 + 3),
        index * 3,
      );
    });
    const facetLocal = meshModel(
      "facet-local",
      facetLocalPositions,
      Uint32Array.from(
        { length: mesh.geometry.indices.length },
        (_, index) => index,
      ),
    );

    const summary = summarizeModelGeometry(facetLocal);
    expect(summary).toMatchObject({
      vertexCount: 36,
      triangleCount: 12,
      componentCount: 1,
      volume: {
        available: true,
        absoluteCubicMillimetres: 24,
        topology: {
          boundaryEdgeCount: 0,
          nonManifoldEdgeCount: 0,
          inconsistentEdgeCount: 0,
        },
      },
    });
  });

  it("withholds volume for open and non-manifold geometry with explicit evidence", () => {
    const open = meshModel(
      "open",
      new Float64Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    );
    const openSummary = summarizeModelGeometry(open);

    expect(openSummary).toMatchObject({
      vertexCount: 4,
      triangleCount: 2,
      componentCount: 1,
      surfaceAreaSquareMillimetres: 4,
      volume: {
        available: false,
        reasons: ["boundary-edges"],
        topology: { boundaryEdgeCount: 4 },
      },
    });

    const nonManifold = meshModel(
      "non-manifold",
      new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]),
      new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]),
    );
    const nonManifoldSummary = summarizeModelGeometry(nonManifold);
    expect(nonManifoldSummary.volume).toMatchObject({
      available: false,
      reasons: expect.arrayContaining(["boundary-edges", "non-manifold-edges"]),
      topology: { nonManifoldEdgeCount: 1 },
    });
  });

  it("preserves an indeterminate analysis code and its reasons", () => {
    const baseline = boxModel("baseline", [1, 1, 1]);
    const candidate = boxModel("candidate", [1, 1, 1]);
    const complete = analyze(baseline, candidate);
    const indeterminate = analysisResultSchema.parse({
      ...complete,
      outcome: {
        state: "indeterminate",
        code: "summary-test.indeterminate",
        reasons: ["The selected method could not produce a result."],
        requestedMethod: complete.outcome.requestedMethod,
        requestedTolerance: complete.outcome.requestedTolerance,
        validation: complete.outcome.validation,
      },
    });

    expect(
      summarizeModelComparison(baseline, candidate, indeterminate).analysis,
    ).toEqual({
      state: "indeterminate",
      code: "summary-test.indeterminate",
      reasons: ["The selected method could not produce a result."],
      warningCount: 0,
      methodId: "surface-distance",
      methodVersion: "1.0.0",
    });
  });

  it("rejects analysis bindings for different models", () => {
    const baseline = boxModel("baseline", [1, 1, 1]);
    const candidate = boxModel("candidate", [1, 1, 1]);
    expect(() =>
      summarizeModelComparison(
        candidate,
        baseline,
        analyze(baseline, candidate),
      ),
    ).toThrow(/bindings must match/u);
  });
});

function analyze(
  baseline: NormalizedModel,
  candidate: NormalizedModel,
): AnalysisResult {
  return analyzeModelPair({
    baseline,
    candidate,
    request: analysisRequestSchema.parse({
      contractVersion: 1,
      requestId: "analysis.summary.1",
      baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
      candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
      method: SURFACE_DISTANCE_METHOD,
      tolerance: { distanceMillimetres: 0.01 },
      executionBudget: {
        maxWorkUnits: 2_000_000,
        maxMemoryBytes: 32 * 1024 * 1024,
      },
    }),
  });
}

function boxModel(
  id: string,
  maximum: readonly [number, number, number],
  options: { placement?: unknown } = {},
): NormalizedModel {
  const [x, y, z] = maximum;
  return meshModel(
    id,
    new Float64Array([
      0,
      0,
      0,
      x,
      0,
      0,
      x,
      y,
      0,
      0,
      y,
      0,
      0,
      0,
      z,
      x,
      0,
      z,
      x,
      y,
      z,
      0,
      y,
      z,
    ]),
    new Uint32Array(BOX_INDICES),
    options.placement,
  );
}

function meshModel(
  id: string,
  positions: Float64Array,
  indices: Uint32Array,
  placement?: unknown,
): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [{ id: `${id}.mesh`, geometry: { positions, indices } }],
    placement: placement ?? {
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
      importerId: "model-summary-test",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: ["Procedurally generated test geometry."],
    },
  });
}

function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function scale(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}
