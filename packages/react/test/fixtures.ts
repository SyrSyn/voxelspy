import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisRequestSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type { AnalysisRequest, NormalizedModel } from "@voxelspy/contracts";

const BOX_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4,
  7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
]);

/** A minimal, valid, closed-box `NormalizedModel`, built directly through
 *  the contracts schema (never through an importer) -- this package's tests
 *  exercise its hooks/worker protocol over the public engine surface, not
 *  file import, so a hand-built fixture is the right level of test data.
 *  Mirrors `packages/analysis/test/fixtures.ts`'s `boxModel`, independently,
 *  since that helper is private to that package's own tests. */
export function boxModel(
  id: string,
  options: {
    readonly maximum?: readonly [number, number, number];
    readonly open?: boolean;
  } = {},
): NormalizedModel {
  const [x, y, z] = options.maximum ?? [2, 2, 2];
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
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "react-test-fixture",
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

/**
 * A minimal, valid `AnalysisRequest` comparing `baseline` against
 * `candidate` with the given method, built through `analysisRequestSchema`
 * so its branded fields (`requestId`, `method.id`, `modelToComparison`,
 * ...) are constructed the same way production code constructs them --
 * never cast past the schema with `as`.
 */
export function analysisRequestFor(
  baseline: NormalizedModel,
  candidate: NormalizedModel,
  methodId: "surface-distance" | "axis-aligned-box-solid",
  options: {
    readonly executionBudget?: { maxMemoryBytes: number; maxWorkUnits: number };
  } = {},
): AnalysisRequest {
  return analysisRequestSchema.parse({
    contractVersion: 1,
    requestId: "req.1",
    baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
    candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
    method: { id: methodId, version: "1.0.0", parameters: {} },
    tolerance: { distanceMillimetres: 0.1 },
    ...(options.executionBudget === undefined
      ? {}
      : { executionBudget: options.executionBudget }),
  });
}
