import {
  ANALYSIS_LIMITS,
  estimateAlignment,
  MIN_CORRESPONDENCES,
  type CorrespondencePoint,
} from "@voxelspy/analysis";
import { IDENTITY_MAT4 } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import {
  alignmentNeedsReview,
  correspondenceRowsReady,
  correspondenceRowsToPoints,
  isIdentityTransform,
  sourceCapability,
  sourceSelectionForFile,
} from "./ComparisonFlow";
import {
  ANALYSIS_MEMORY_MAX_MIB,
  analysisExecutionBudget,
} from "./worker-client";

describe("comparison source defaults", () => {
  it("uses millimetre and right-handed Z-up before a file is chosen", () => {
    expect(sourceSelectionForFile(null)).toEqual({
      file: null,
      unit: "millimetre",
      axis: "right-handed-z-up",
      frameSource: "default",
    });
  });

  it("restores the defaults when a file is chosen or replaced", () => {
    const first = sourceSelectionForFile(new File(["first"], "baseline.stl"));
    const expertSelection = {
      ...first,
      unit: "inch" as const,
      axis: "right-handed-y-up" as const,
      frameSource: "expert" as const,
    };
    const replacement = sourceSelectionForFile(
      new File(["replacement"], "replacement.obj"),
    );

    expect(sourceCapability(expertSelection)).toMatchObject({ ready: true });
    expect(replacement).toMatchObject({
      unit: "millimetre",
      axis: "right-handed-z-up",
      frameSource: "default",
    });
    expect(sourceCapability(replacement)).toEqual({
      ready: true,
      message:
        "Ready for local comparison using millimetres and right-handed Z-up.",
    });
  });

  it("refuses an unsupported extension with an honest message naming what is supported", () => {
    expect(
      sourceCapability(sourceSelectionForFile(new File(["x"], "model.step"))),
    ).toEqual({
      ready: false,
      message:
        "This release supports STL, OBJ, glTF, GLB, or 3MF mesh files (.stl, .obj, .gltf, .glb, .3mf).",
    });
  });

  it("accepts glTF/GLB/3MF and starts from the file's own declared frame, not a default", () => {
    const glb = sourceSelectionForFile(new File(["x"], "baseline.glb"));
    expect(glb).toMatchObject({ unit: "", axis: "", frameSource: "default" });
    expect(sourceCapability(glb)).toEqual({
      ready: true,
      message:
        "Ready for local comparison using this file's own declared source frame.",
    });
    const threeMf = sourceSelectionForFile(new File(["x"], "baseline.3mf"));
    expect(threeMf).toMatchObject({ unit: "", axis: "" });
    expect(sourceCapability(threeMf)).toMatchObject({ ready: true });
  });
});

describe("analysis capacity", () => {
  it("maps the visible RAM allowance to bounded memory and compute budgets", () => {
    const middle = analysisExecutionBudget(256);
    expect(middle.maxMemoryBytes).toBe(256 * 1024 * 1024);
    const highest = analysisExecutionBudget(ANALYSIS_MEMORY_MAX_MIB);
    expect(highest.maxMemoryBytes).toBe(ANALYSIS_MEMORY_MAX_MIB * 1024 * 1024);
    // A larger allowance must buy proportionally more compute, and neither
    // budget may exceed what the analysis package itself permits.
    expect(highest.maxWorkUnits).toBeGreaterThan(middle.maxWorkUnits);
    for (const budget of [middle, highest]) {
      expect(budget.maxWorkUnits).toBeLessThanOrEqual(
        ANALYSIS_LIMITS.maxWorkUnits,
      );
      expect(budget.maxMemoryBytes).toBeLessThanOrEqual(
        ANALYSIS_LIMITS.maxMemoryBytes,
      );
    }
    expect(() => analysisExecutionBudget(192)).toThrow(/128 MiB increment/u);
  });
});

type Point3 = [number, number, number];
type TestCorrespondenceRow = { key: number; moving: Point3; fixed: Point3 };

describe("alignment: correspondence-row helpers", () => {
  it("is not ready until at least MIN_CORRESPONDENCES rows are all finite", () => {
    const incomplete: TestCorrespondenceRow[] = [
      { key: 0, moving: [0, 0, 0], fixed: [1, 0, 0] },
      { key: 1, moving: [1, 0, 0], fixed: [2, 0, 0] },
      { key: 2, moving: [0, 1, 0], fixed: [Number.NaN, 1, 0] },
    ];
    expect(correspondenceRowsReady(incomplete)).toBe(false);

    const tooFew = incomplete.slice(0, MIN_CORRESPONDENCES - 1);
    expect(correspondenceRowsReady(tooFew)).toBe(false);

    const complete: TestCorrespondenceRow[] = [
      { key: 0, moving: [0, 0, 0], fixed: [1, 0, 0] },
      { key: 1, moving: [1, 0, 0], fixed: [2, 0, 0] },
      { key: 2, moving: [0, 1, 0], fixed: [1, 1, 0] },
    ];
    expect(correspondenceRowsReady(complete)).toBe(true);
  });

  it("converts rows into the CorrespondencePoint[] shape estimateAlignment expects", () => {
    const rows: TestCorrespondenceRow[] = [
      { key: 0, moving: [0, 0, 0], fixed: [5, 2, -3] },
      { key: 1, moving: [10, 0, 0], fixed: [15, 2, -3] },
    ];
    expect(correspondenceRowsToPoints(rows)).toEqual([
      { moving: [0, 0, 0], fixed: [5, 2, -3] },
      { moving: [10, 0, 0], fixed: [15, 2, -3] },
    ]);
  });
});

describe("alignment: isIdentityTransform", () => {
  it("recognizes the identity matrix and rejects any other rigid transform", () => {
    expect(isIdentityTransform(IDENTITY_MAT4)).toBe(true);
    const translated = [...IDENTITY_MAT4];
    translated[12] = 5;
    expect(isIdentityTransform(translated)).toBe(false);
  });
});

describe("alignment: correspondence-points estimate wiring", () => {
  it("recovers a known rigid translation with no warnings and passes review cleanly", () => {
    const offset: Point3 = [5, 2, -3];
    const correspondences: CorrespondencePoint[] = [
      { moving: [0, 0, 0], fixed: offset },
      { moving: [10, 0, 0], fixed: [10 + offset[0], offset[1], offset[2]] },
      { moving: [0, 10, 0], fixed: [offset[0], 10 + offset[1], offset[2]] },
    ];
    const estimate = estimateAlignment({
      method: "correspondence-points",
      correspondences,
    });
    expect(estimate.evidence.converged).toBe(true);
    expect(estimate.evidence.poorFit).toBe(false);
    expect(estimate.warnings).toEqual([]);
    expect(alignmentNeedsReview(estimate)).toBe(false);
    expect(
      estimate.evidence.residualsAfterMillimetres.rmsMillimetres,
    ).toBeLessThan(1e-6);
    // Pure translation: rotation columns are the identity, translation is
    // exactly the offset supplied above.
    expect(estimate.transform[0]).toBeCloseTo(1, 9);
    expect(estimate.transform[5]).toBeCloseTo(1, 9);
    expect(estimate.transform[10]).toBeCloseTo(1, 9);
    expect(estimate.transform[12]).toBeCloseTo(offset[0], 9);
    expect(estimate.transform[13]).toBeCloseTo(offset[1], 9);
    expect(estimate.transform[14]).toBeCloseTo(offset[2], 9);
  });

  it("surfaces a poor-fit warning and reads as review, never success, for a shape-inconsistent point set", () => {
    // No rigid (rotation + translation, no scale) transform can map these
    // moving points onto these fixed points: the fixed side's third point
    // is twice as far from the first two as the moving side's is, a length
    // mismatch no rotation or translation can resolve.
    const correspondences: CorrespondencePoint[] = [
      { moving: [0, 0, 0], fixed: [0, 0, 0] },
      { moving: [10, 0, 0], fixed: [10, 0, 0] },
      { moving: [0, 10, 0], fixed: [0, 0, 20] },
    ];
    const estimate = estimateAlignment({
      method: "correspondence-points",
      correspondences,
    });
    expect(estimate.evidence.poorFit).toBe(true);
    expect(estimate.evidence.poorFitReason).toBeDefined();
    expect(
      estimate.warnings.some(
        (warning) => warning.code === "alignment.poor-fit",
      ),
    ).toBe(true);
    // The defining assertion for this bead: a poor-fit estimate must read
    // as "review this", never as success.
    expect(alignmentNeedsReview(estimate)).toBe(true);
  });
});
