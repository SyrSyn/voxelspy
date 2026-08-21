/**
 * Consumer contract tests: everything in this file imports exclusively
 * through the package's public entry point (`@voxelspy/analysis`) and its
 * declared runtime dependency (`@voxelspy/contracts`) -- never a relative
 * `../src/*.js` path, unlike every other file under `test/`, which
 * deliberately reaches into internals for white-box coverage.
 *
 * The point of this file is different from those: it is the package's own
 * proof that an outside consumer -- who can only ever `import` from
 * `"@voxelspy/analysis"`, per its `package.json` `exports` map -- gets a
 * self-contained, usable public surface. That is why this suite:
 *
 *   - resolves `@voxelspy/analysis` the same way a real consumer's bundler
 *     or Node runtime would (through the package's own `exports` map, i.e.
 *     against the built `dist/`, not source -- see the `pretest` script in
 *     `package.json`, which rebuilds `dist/` before this suite runs so the
 *     assertion is always against current output, not a stale artifact);
 *   - exercises a realistic build-geometry -> analyze -> inspect -> measure
 *     flow end to end, the way a consumer application would chain calls;
 *   - names every type it touches explicitly (rather than only ever letting
 *     TypeScript infer them), so a type an exported function's signature
 *     depends on but that the package forgot to re-export from its own
 *     entry point fails this file's typecheck, not silently at a
 *     consumer's build time;
 *   - catches the shared, cross-cutting error classes (`WorkBudgetExceeded`,
 *     `NumericRangeExceededError`) by `instanceof` through the same public
 *     import, proving they are reachable, not just documented.
 */
import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisRequestSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type { NormalizedModel } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_LIMITS,
  NumericRangeExceededError,
  SURFACE_DISTANCE_METHOD,
  WorkBudgetExceeded,
  analyzeModelPair,
  flattenedTriangleLocator,
  inspectModel,
  measureOnModel,
} from "@voxelspy/analysis";
import type {
  AnalysisInput,
  Bounds,
  FlatGeometry,
  FlattenedTriangleLocator,
  InspectionResult,
  MeasurementResult,
  PlacedInstanceId,
  PlacedMeshId,
} from "@voxelspy/analysis";

// ---------------------------------------------------------------------------
// A minimal closed box, built the way any outside consumer would: parsed
// against the contracts schema directly, never through this package's own
// internal test fixtures (`./fixtures.js`, which every other test file in
// this package uses instead).
// ---------------------------------------------------------------------------

const BOX_TRIANGLE_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4,
  7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
]);

function unitBoxModel(id: string, size: number): NormalizedModel {
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
            size,
            0,
            0,
            size,
            size,
            0,
            0,
            size,
            0,
            0,
            0,
            size,
            size,
            0,
            size,
            size,
            size,
            size,
            0,
            size,
            size,
          ]),
          indices: BOX_TRIANGLE_INDICES,
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
      importerId: "consumer-entry-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [
        "Procedurally generated unit box for a consumer-entry-point test.",
      ],
    },
  });
}

describe("@voxelspy/analysis public entry point", () => {
  it("supports a realistic build -> analyze -> inspect -> measure flow using only public exports", () => {
    const baseline = unitBoxModel("baseline", 10);
    const candidate = unitBoxModel("candidate", 10);

    // --- analyze -------------------------------------------------------
    const analysisInput: AnalysisInput = {
      request: analysisRequestSchema.parse({
        contractVersion: 1,
        requestId: "consumer-entry.request.1",
        baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
        candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
        method: {
          id: SURFACE_DISTANCE_METHOD.id,
          version: SURFACE_DISTANCE_METHOD.version,
          parameters: {},
        },
        tolerance: { distanceMillimetres: 0.01 },
      }),
      baseline,
      candidate,
    };
    const analysisResult = analyzeModelPair(analysisInput);
    expect(analysisResult.outcome.state).toBe("complete");
    if (analysisResult.outcome.state === "complete") {
      // Identical boxes: no changed region should be reported.
      expect(analysisResult.outcome.orderedRegionIds).toEqual([]);
    }

    // --- inspect ---------------------------------------------------------
    const inspection: InspectionResult = inspectModel(baseline);
    expect(inspection.watertightness).toEqual({ state: "closed" });
    expect(inspection.topologyFindings).toEqual([]);
    expect(inspection.meshBreakdown.meshes).toHaveLength(1);

    // --- measure -----------------------------------------------------
    const boundingExtent: MeasurementResult = measureOnModel(baseline, {
      kind: "bounding-extent",
    });
    if (
      boundingExtent.kind === "bounding-extent" &&
      boundingExtent.bounds.available
    ) {
      expect(boundingExtent.bounds.dimensionsMillimetres).toEqual([10, 10, 10]);
    } else {
      throw new Error("expected an available bounding-extent result");
    }

    const snap = measureOnModel(baseline, {
      kind: "snap-point",
      at: { kind: "point", point: [5, 5, 0] },
    });
    expect(snap.kind).toBe("snap-point");
    if (snap.kind === "snap-point" && snap.outcome.hit) {
      expect(snap.outcome.pointMillimetres).toEqual([5, 5, 0]);
    } else {
      throw new Error("expected snap-point to hit the box surface");
    }

    // --- triangle locator (resolving a reported index back to geometry) --
    // `modelToComparison` defaults to identity; omitted here, just like a
    // consumer who has not placed this model into an assembly frame would.
    const locator: FlattenedTriangleLocator =
      flattenedTriangleLocator(baseline);
    const flatGeometry: FlatGeometry = locator.geometry;
    expect(flatGeometry.triangleCount).toBe(12);
    const resolved = locator.resolve(0);
    const meshId: PlacedMeshId = resolved.meshId;
    const instanceId: PlacedInstanceId = resolved.instanceId;
    expect(meshId).toBe("baseline.mesh");
    expect(instanceId).toBe("baseline.instance");
  });

  it("exposes Bounds as a nameable type usable outside the package", () => {
    // Compile-time proof that `Bounds` -- referenced by `OverhangRegion` and
    // `IslandComponent` (both from `printability.ts`) -- is itself directly
    // importable, not merely structurally reachable through those types.
    const bounds: Bounds = { min: [0, 0, 0], max: [1, 1, 1] };
    expect(bounds.max[0]).toBe(1);
  });

  it("propagates WorkBudgetExceeded, reachable through the public entry point, when a caller's own budget cannot finish the work", () => {
    const model = unitBoxModel("budget-model", 10);
    expect(() =>
      measureOnModel(
        model,
        { kind: "point-to-surface", point: [0, 0, 0] },
        { executionBudget: { maxWorkUnits: 1 } },
      ),
    ).toThrow(WorkBudgetExceeded);
  });

  it("keeps ANALYSIS_LIMITS reachable for a consumer sizing its own execution budgets", () => {
    expect(ANALYSIS_LIMITS.maxExpandedTriangles).toBeGreaterThan(0);
    expect(ANALYSIS_LIMITS.maxWorkUnits).toBeGreaterThan(0);
  });

  it("exposes NumericRangeExceededError -- only explicitly caught and converted to an indeterminate outcome by analyzeModelPair/checkClearance -- so every other entry point that can also throw it (e.g. measureOnModel, assessPrintability) lets a consumer catch it by name too", () => {
    const error = new NumericRangeExceededError("out of range");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NumericRangeExceededError");
  });
});
