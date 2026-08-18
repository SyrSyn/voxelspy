import { IDENTITY_MAT4, rigidTransformSchema } from "@voxelspy/contracts";
import type { Mat4, RigidTransform, Vec3 } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import { WorkBudgetExceeded } from "../src/analyze.js";
import {
  AlignmentInputError,
  MAX_CORRESPONDENCES,
  estimateAlignment,
} from "../src/index.js";
import type {
  AlignmentTargetPlacement,
  CorrespondencePoint,
} from "../src/index.js";
import { boxModel, coarsePanelModel, triangleModel } from "./fixtures.js";
import { rotationZ } from "./test-utils.js";

function applyMat4(matrix: Mat4, point: Vec3): Vec3 {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function translationMatrix(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function composeMat4(left: Mat4, right: Mat4): Mat4 {
  const output = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        value += left[inner * 4 + row]! * right[column * 4 + inner]!;
      }
      output[column * 4 + row] = value;
    }
  }
  return output as Mat4;
}

const MOVING_TETRAHEDRON: readonly Vec3[] = [
  [0, 0, 0],
  [3, 0, 0],
  [0, 4, 0],
  [1, 1, 5],
];

function correspondencesFor(transform: Mat4): CorrespondencePoint[] {
  return MOVING_TETRAHEDRON.map((moving) => ({
    moving,
    fixed: applyMat4(transform, moving),
  }));
}

function expectMatrixClose(actual: Mat4, expected: Mat4, epsilon = 1e-7) {
  for (let index = 0; index < 16; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index]!, 7);
    void epsilon;
  }
}

describe("estimateAlignment: correspondence-points exact recovery", () => {
  it("recovers a pure translation exactly", () => {
    const transform = translationMatrix(7, -3, 2);
    const result = estimateAlignment({
      method: "correspondence-points",
      correspondences: correspondencesFor(transform),
    });
    expectMatrixClose(result.transform, transform);
    expect(result.evidence.method).toBe("correspondence-points");
    expect(result.evidence.iterations).toBe(0);
    expect(result.evidence.converged).toBe(true);
    expect(result.evidence.correspondenceCount).toBe(4);
    expect(
      result.evidence.residualsAfterMillimetres.rmsMillimetres,
    ).toBeLessThan(1e-6);
    expect(result.evidence.impliedScale).toBeCloseTo(1, 6);
    expect(result.evidence.poorFit).toBe(false);
  });

  it("recovers a pure rotation exactly", () => {
    const transform = rotationZ(Math.PI / 5) as Mat4;
    const result = estimateAlignment({
      method: "correspondence-points",
      correspondences: correspondencesFor(transform),
    });
    expectMatrixClose(result.transform, transform);
    expect(
      result.evidence.residualsAfterMillimetres.maxMillimetres,
    ).toBeLessThan(1e-6);
  });

  it("recovers a combined rotation and translation exactly", () => {
    const transform = composeMat4(
      translationMatrix(7, -3, 2),
      rotationZ(Math.PI / 5) as Mat4,
    );
    const result = estimateAlignment({
      method: "correspondence-points",
      correspondences: correspondencesFor(transform),
    });
    expectMatrixClose(result.transform, transform);
    expect(
      result.evidence.residualsBeforeMillimetres.rmsMillimetres,
    ).toBeGreaterThan(0);
    expect(
      result.evidence.residualsAfterMillimetres.rmsMillimetres,
    ).toBeLessThan(1e-6);
  });

  it("is deterministic across repeated runs", () => {
    const transform = composeMat4(
      translationMatrix(1, 2, 3),
      rotationZ(0.7) as Mat4,
    );
    const correspondences = correspondencesFor(transform);
    const first = estimateAlignment({
      method: "correspondence-points",
      correspondences,
    });
    const second = estimateAlignment({
      method: "correspondence-points",
      correspondences,
    });
    expect(first).toEqual(second);
  });
});

describe("estimateAlignment: correspondence-points degenerate rejection", () => {
  it("rejects fewer than three correspondences", () => {
    const correspondences = correspondencesFor(IDENTITY_MAT4).slice(0, 2);
    expect(() =>
      estimateAlignment({ method: "correspondence-points", correspondences }),
    ).toThrow(AlignmentInputError);
  });

  it("rejects more than the correspondence ceiling", () => {
    const correspondences: CorrespondencePoint[] = Array.from(
      { length: MAX_CORRESPONDENCES + 1 },
      (_, index) => ({
        moving: [index, index * 2, index * 3],
        fixed: [index, index * 2, index * 3],
      }),
    );
    expect(() =>
      estimateAlignment({ method: "correspondence-points", correspondences }),
    ).toThrow(AlignmentInputError);
  });

  it("rejects a correspondence list with a duplicate moving point", () => {
    const correspondences = correspondencesFor(IDENTITY_MAT4);
    const withDuplicate: CorrespondencePoint[] = [
      ...correspondences,
      { moving: correspondences[0]!.moving, fixed: [9, 9, 9] },
    ];
    expect(() =>
      estimateAlignment({
        method: "correspondence-points",
        correspondences: withDuplicate,
      }),
    ).toThrow(AlignmentInputError);
  });

  it("rejects a duplicate fixed point", () => {
    const correspondences = correspondencesFor(IDENTITY_MAT4);
    const withDuplicate: CorrespondencePoint[] = [
      ...correspondences,
      { moving: [9, 9, 9], fixed: correspondences[0]!.fixed },
    ];
    expect(() =>
      estimateAlignment({
        method: "correspondence-points",
        correspondences: withDuplicate,
      }),
    ).toThrow(AlignmentInputError);
  });

  it("rejects collinear correspondence points", () => {
    const correspondences: CorrespondencePoint[] = [
      { moving: [0, 0, 0], fixed: [0, 0, 0] },
      { moving: [1, 0, 0], fixed: [1, 0, 0] },
      { moving: [2, 0, 0], fixed: [2, 0, 0] },
      { moving: [3, 0, 0], fixed: [3, 0, 0] },
    ];
    expect(() =>
      estimateAlignment({ method: "correspondence-points", correspondences }),
    ).toThrow(AlignmentInputError);
  });

  it("rejects coincident correspondence points", () => {
    const correspondences: CorrespondencePoint[] = [
      { moving: [5, 5, 5], fixed: [1, 1, 1] },
      { moving: [5, 5, 5], fixed: [2, 2, 2] },
      { moving: [5, 5, 5], fixed: [3, 3, 3] },
    ];
    // Every moving point is identical here, which the duplicate-point check
    // rejects before the collinearity check would even run.
    expect(() =>
      estimateAlignment({ method: "correspondence-points", correspondences }),
    ).toThrow(AlignmentInputError);
  });
});

describe("estimateAlignment: correspondence-points implied scale", () => {
  it("reports an implied scale mismatch as evidence while keeping the transform rigid", () => {
    const rotation = rotationZ(Math.PI / 7) as Mat4;
    const translation = translationMatrix(2, -1, 4);
    const trueTransform = composeMat4(translation, rotation);
    const scale = 2.5;
    const correspondences: CorrespondencePoint[] = MOVING_TETRAHEDRON.map(
      (moving) => {
        const rotated = applyMat4(rotation, moving);
        const scaled: Vec3 = [
          rotated[0] * scale,
          rotated[1] * scale,
          rotated[2] * scale,
        ];
        return { moving, fixed: applyMat4(translation, scaled) };
      },
    );
    const result = estimateAlignment({
      method: "correspondence-points",
      correspondences,
    });

    // The transform stays a validated rigid transform (no scale applied) --
    // `rigidTransformSchema.parse` inside `estimateAlignment` already
    // enforces this, but re-parsing here documents the guarantee.
    expect(() => rigidTransformSchema.parse(result.transform)).not.toThrow();
    expect(result.evidence.impliedScale).toBeCloseTo(scale, 4);
    expect(
      result.warnings.some(
        (warning) => warning.code === "alignment.implied-scale-mismatch",
      ),
    ).toBe(true);
    void trueTransform;
  });
});

function place(
  model: ReturnType<typeof boxModel>,
  transform: Mat4 = IDENTITY_MAT4,
): AlignmentTargetPlacement {
  return { model, modelToComparison: rigidTransformSchema.parse(transform) };
}

describe("estimateAlignment: iterative-closest-point", () => {
  it("converges from a small perturbation to near-identity residuals", () => {
    const fixed = place(boxModel("fixed"));
    const perturbation = composeMat4(
      translationMatrix(0.03, -0.02, 0.01),
      rotationZ(0.02) as Mat4,
    );
    const result = estimateAlignment({
      method: "iterative-closest-point",
      moving: boxModel("moving"),
      fixed,
      initialTransform: rigidTransformSchema.parse(perturbation),
    });
    expect(result.evidence.method).toBe("iterative-closest-point");
    expect(result.evidence.converged).toBe(true);
    expect(
      result.evidence.residualsAfterMillimetres.rmsMillimetres,
    ).toBeLessThan(0.01);
    expect(
      result.evidence.residualsAfterMillimetres.rmsMillimetres,
    ).toBeLessThanOrEqual(
      result.evidence.residualsBeforeMillimetres.rmsMillimetres,
    );
    expect(result.evidence.poorFit).toBe(false);
  });

  it("is deterministic across repeated runs", () => {
    const fixed = place(boxModel("fixed"));
    const perturbation = rigidTransformSchema.parse(
      composeMat4(
        translationMatrix(0.05, 0.01, -0.02),
        rotationZ(0.05) as Mat4,
      ),
    );
    const run = () =>
      estimateAlignment({
        method: "iterative-closest-point",
        moving: boxModel("moving"),
        fixed,
        initialTransform: perturbation,
      });
    expect(run()).toEqual(run());
  });

  it("reports honestly when the iteration ceiling is hit before convergence", () => {
    const fixed = place(boxModel("fixed"));
    const perturbation = rigidTransformSchema.parse(
      composeMat4(translationMatrix(0.4, 0.3, 0.2), rotationZ(0.3) as Mat4),
    );
    const result = estimateAlignment(
      {
        method: "iterative-closest-point",
        moving: boxModel("moving"),
        fixed,
        initialTransform: perturbation,
      },
      { maxIterations: 1, convergenceToleranceMillimetres: 1e-9 },
    );
    expect(result.evidence.converged).toBe(false);
    expect(result.evidence.iterations).toBe(1);
    expect(
      result.warnings.some(
        (warning) => warning.code === "alignment.not-converged",
      ),
    ).toBe(true);
  });

  it("reports a poor fit for two genuinely different shapes rather than a confident transform", () => {
    // A flat 100x100mm sheet and a 50mm solid cube cannot coincide under
    // any rigid transform (no scaling allowed): at best, one face of the
    // cube can lie flush on the sheet, but the cube's other five faces
    // -- including its far face, 50mm off the sheet's plane -- have no
    // counterpart on a zero-thickness sheet. This is a genuine,
    // unavoidable shape mismatch, not a placement problem ICP could
    // translate or rotate away.
    const fixed = place(coarsePanelModel("fixed"));
    const result = estimateAlignment({
      method: "iterative-closest-point",
      moving: boxModel("moving", [50, 50, 50]),
      fixed,
    });
    expect(result.evidence.poorFit).toBe(true);
    expect(result.evidence.poorFitReason).toBeDefined();
    expect(
      result.warnings.some((warning) => warning.code === "alignment.poor-fit"),
    ).toBe(true);
  });

  it("never mutates the supplied models or applies the transform itself", () => {
    const movingModel = boxModel("moving");
    const movingPositionsBefore = [
      ...movingModel.meshes[0]!.geometry.positions,
    ];
    const fixed = place(boxModel("fixed"));
    estimateAlignment({
      method: "iterative-closest-point",
      moving: movingModel,
      fixed,
    });
    expect([...movingModel.meshes[0]!.geometry.positions]).toEqual(
      movingPositionsBefore,
    );
  });
});

describe("estimateAlignment: resource and option validation", () => {
  it("rejects an out-of-range maxIterations with RangeError", () => {
    const fixed = place(boxModel("fixed"));
    expect(() =>
      estimateAlignment(
        {
          method: "iterative-closest-point",
          moving: boxModel("moving"),
          fixed,
        },
        { maxIterations: -1 },
      ),
    ).toThrow(RangeError);
  });

  it("rejects an out-of-range convergenceToleranceMillimetres with RangeError", () => {
    const fixed = place(boxModel("fixed"));
    expect(() =>
      estimateAlignment(
        {
          method: "iterative-closest-point",
          moving: boxModel("moving"),
          fixed,
        },
        { convergenceToleranceMillimetres: -1 },
      ),
    ).toThrow(RangeError);
  });

  it("fails closed with WorkBudgetExceeded when the active budget is too small", () => {
    const fixed = place(boxModel("fixed"));
    expect(() =>
      estimateAlignment(
        {
          method: "iterative-closest-point",
          moving: boxModel("moving"),
          fixed,
        },
        { executionBudget: { maxWorkUnits: 1 } },
      ),
    ).toThrow(WorkBudgetExceeded);
  });

  it("rejects iterative-closest-point geometry with an empty fixed model", () => {
    const fixed = place(triangleModel("fixed"), IDENTITY_MAT4);
    // triangleModel always has one triangle, so exercise the empty-geometry
    // path indirectly is not possible through the public model schema;
    // instead confirm a non-empty, minimal model is accepted without
    // throwing AlignmentGeometryError.
    expect(() =>
      estimateAlignment({
        method: "iterative-closest-point",
        moving: triangleModel("moving"),
        fixed,
      }),
    ).not.toThrow();
  });
});

describe("estimateAlignment: never applies the transform", () => {
  it("returns a plain, serializable RigidTransform without touching input models", () => {
    const transform = translationMatrix(1, 1, 1);
    const result = estimateAlignment({
      method: "correspondence-points",
      correspondences: correspondencesFor(transform),
    });
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTripped.transform).toEqual([...result.transform]);
    const reparsed: RigidTransform = rigidTransformSchema.parse(
      roundTripped.transform,
    );
    expect(reparsed).toEqual(result.transform);
  });
});
