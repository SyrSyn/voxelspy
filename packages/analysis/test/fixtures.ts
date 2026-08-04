import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisRequestSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type {
  AnalysisRequest,
  Mat4,
  NormalizedModel,
} from "@voxelspy/contracts";

const BOX_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4,
  7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
]);

export function boxModel(
  id: string,
  maximum: readonly [number, number, number] = [2, 2, 2],
  options: { open?: boolean; meshToModel?: Mat4 } = {},
): NormalizedModel {
  const [x, y, z] = maximum;
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: {
          positions: new Float64Array([
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
          indices: options.open
            ? new Uint32Array([...BOX_INDICES].slice(0, -6))
            : new Uint32Array(BOX_INDICES),
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `${id}.instance`,
          meshId: `${id}.mesh`,
          meshToModel: options.meshToModel ?? IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "analysis-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: ["Procedurally generated rectangular box."],
    },
  });
}

export function triangleModel(id: string): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: {
          positions: new Float64Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
          indices: new Uint32Array([0, 1, 2]),
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
      importerId: "analysis-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: ["Procedurally generated triangle."],
    },
  });
}

export function facetLocalSquareModel(id: string): NormalizedModel {
  return generatedMeshModel(
    id,
    new Float64Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0]),
    new Uint32Array([0, 1, 2, 3, 4, 5]),
    "stl",
    "Two connected facets with facet-local duplicate vertices.",
  );
}

export function disconnectedFacetModel(
  id: string,
  triangleCount: number,
): NormalizedModel {
  const positions = new Float64Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const x = triangle * 10;
    positions.set([x, 0, 0, x + 1, 0, 0, x, 1, 0], triangle * 9);
    indices.set(
      [triangle * 3, triangle * 3 + 1, triangle * 3 + 2],
      triangle * 3,
    );
  }
  return generatedMeshModel(
    id,
    positions,
    indices,
    "generated-fixture",
    "Separated procedural triangles.",
  );
}

function generatedMeshModel(
  id: string,
  positions: Float64Array,
  indices: Uint32Array,
  formatId: string,
  note: string,
): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: { positions, indices },
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
      formatId,
      importerId: "analysis-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [note],
    },
  });
}

export function request(
  method: "surface-distance" | "axis-aligned-box-solid" | "unknown-method",
  options: {
    candidateTransform?: Mat4;
    parameters?: Record<string, unknown>;
    maxWorkUnits?: number;
    baselineId?: string;
    candidateId?: string;
  } = {},
): AnalysisRequest {
  return analysisRequestSchema.parse({
    contractVersion: 1,
    requestId: "analysis.request.1",
    baseline: {
      modelId: options.baselineId ?? "baseline",
      modelToComparison: IDENTITY_MAT4,
    },
    candidate: {
      modelId: options.candidateId ?? "candidate",
      modelToComparison: options.candidateTransform ?? IDENTITY_MAT4,
    },
    method: {
      id: method,
      version: "1.0.0",
      parameters: options.parameters ?? {},
    },
    tolerance: { distanceMillimetres: 0.01 },
    ...(options.maxWorkUnits === undefined
      ? {}
      : {
          executionBudget: {
            maxWorkUnits: options.maxWorkUnits,
            maxMemoryBytes: 8 * 1024 * 1024,
          },
        }),
  });
}

export function translation(x: number, y = 0, z = 0): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}
