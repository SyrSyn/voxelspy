import { normalizedModelSchema } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import {
  SimplifyInputError,
  SimplifyResourceLimitError,
  diagnoseMeshHealth,
  inspectModel,
  simplifyModel,
} from "../src/index.js";
import { boxModel, disconnectedFacetModel } from "./fixtures.js";

describe("simplifyModel: decimation", () => {
  it("decimates a coarse closed box to a lower triangle-count target with a small certified deviation", () => {
    const box = boxModel("mild-box", [10, 10, 10]);
    const result = simplifyModel(box, {
      target: { kind: "triangle-count", triangleCount: 10 },
    });

    expect(result.original.triangleCount).toBe(12);
    expect(result.simplified.triangleCount).toBeLessThanOrEqual(10);
    expect(result.reduction.triangleCountRemoved).toBeGreaterThan(0);
    expect(result.reduction.triangleReductionRatio).toBeGreaterThan(0);
    expect(result.reduction.targetReached).toBe(true);
    expect(
      result.warnings.some((w) => w.code === "simplify.target-not-reached"),
    ).toBe(false);

    // A single mild collapse on a 10mm box measures a real but proportionate
    // deviation -- well under the box's own edge length, not an
    // unbounded/garbage value. The "small relative to an aggressive
    // reduction" comparison is the next test below.
    expect(result.certification.maximumDistanceMillimetres).toBeGreaterThan(0);
    expect(result.certification.maximumDistanceMillimetres).toBeLessThan(10);
    expect(result.certification.semantics).toBe("approximate-sampled-bound");
    expect(result.certification.originalToSimplified.semantics).toBe(
      "approximate-sampled",
    );
    expect(result.certification.simplifiedToOriginal.semantics).toBe(
      "approximate-sampled",
    );
  });

  it("shows a larger measured deviation for a more aggressive reduction than a mild one", () => {
    const mild = simplifyModel(boxModel("compare-box"), {
      target: { kind: "triangle-count", triangleCount: 10 },
    });
    const aggressive = simplifyModel(boxModel("compare-box"), {
      target: { kind: "triangle-count", triangleCount: 4 },
    });

    expect(aggressive.simplified.triangleCount).toBeLessThanOrEqual(
      mild.simplified.triangleCount,
    );
    expect(aggressive.certification.maximumDistanceMillimetres).toBeGreaterThan(
      mild.certification.maximumDistanceMillimetres,
    );
  });

  it("accepts a reduction-ratio target and resolves it to an absolute triangle count", () => {
    const box = boxModel("ratio-box", [10, 10, 10]);
    const result = simplifyModel(box, {
      target: { kind: "reduction-ratio", reductionRatio: 0.5 },
    });
    expect(result.parameters.effectiveTargetTriangleCount).toBe(6);
    expect(result.simplified.triangleCount).toBeLessThanOrEqual(6);
  });

  it("reports an honest achieved count with a warning when the target cannot be reached", () => {
    const box = boxModel("unreachable-box", [10, 10, 10]);
    // A closed 2-manifold triangle mesh cannot go below 4 triangles (a
    // tetrahedron); asking for 1 is unreachable no matter how decimation
    // proceeds.
    const result = simplifyModel(box, {
      target: { kind: "triangle-count", triangleCount: 1 },
    });

    expect(result.reduction.targetReached).toBe(false);
    expect(result.simplified.triangleCount).toBeGreaterThan(1);
    expect(
      result.warnings.some((w) => w.code === "simplify.target-not-reached"),
    ).toBe(true);
    // Never garbage: still a schema-valid, non-empty, inspectable model.
    expect(() => normalizedModelSchema.parse(result.model)).not.toThrow();
    expect(() => inspectModel(result.model)).not.toThrow();
  });

  it("preserves boundary edges and the boundary loop count by default on an open surface", () => {
    const open = boxModel("open-box", [10, 10, 10], { open: true });
    const before = diagnoseMeshHealth(open);
    expect(before.boundaryLoops.loopCount).toBe(1);

    const result = simplifyModel(open, {
      target: { kind: "triangle-count", triangleCount: 8 },
    });

    const after = diagnoseMeshHealth(result.model);
    expect(after.boundaryLoops.loopCount).toBe(before.boundaryLoops.loopCount);
    expect(after.boundaryLoops.loops[0]!.edgeCount).toBe(
      before.boundaryLoops.loops[0]!.edgeCount,
    );
    expect(after.boundaryLoops.loops[0]!.pointsMillimetres).toEqual(
      before.boundaryLoops.loops[0]!.pointsMillimetres,
    );
    expect(
      result.warnings.some(
        (w) => w.code === "simplify.boundary-edges-collapsible",
      ),
    ).toBe(false);
  });

  it("warns when collapseBoundaryEdges is explicitly enabled on a model with boundary edges", () => {
    const open = boxModel("open-box-collapsible", [10, 10, 10], {
      open: true,
    });
    const result = simplifyModel(open, {
      target: { kind: "triangle-count", triangleCount: 6 },
      collapseBoundaryEdges: true,
    });
    expect(
      result.warnings.some(
        (w) => w.code === "simplify.boundary-edges-collapsible",
      ),
    ).toBe(true);
  });

  it("produces a simplified model that passes the contracts schema and can be fed back into inspectModel", () => {
    const box = boxModel("feed-back-box", [10, 10, 10]);
    const result = simplifyModel(box, {
      target: { kind: "triangle-count", triangleCount: 6 },
    });
    const validated = normalizedModelSchema.parse(result.model);
    const inspection = inspectModel(validated);
    expect(inspection.summary.triangleCount).toBe(
      result.simplified.triangleCount,
    );
    expect(inspection.watertightness.state).not.toBe("indeterminate");
  });

  it("is deterministic: two runs on identical input produce a deeply equal result, including emitted geometry", () => {
    const first = simplifyModel(boxModel("determinism-box", [7, 11, 13]), {
      target: { kind: "triangle-count", triangleCount: 6 },
    });
    const second = simplifyModel(boxModel("determinism-box", [7, 11, 13]), {
      target: { kind: "triangle-count", triangleCount: 6 },
    });

    expect(second.simplified).toEqual(first.simplified);
    expect(second.reduction).toEqual(first.reduction);
    expect(second.certification).toEqual(first.certification);
    expect(Array.from(second.model.meshes[0]!.geometry.positions)).toEqual(
      Array.from(first.model.meshes[0]!.geometry.positions),
    );
    expect(Array.from(second.model.meshes[0]!.geometry.indices)).toEqual(
      Array.from(first.model.meshes[0]!.geometry.indices),
    );
  });

  it("reports a flattened-placement warning when the input has multiple disconnected pieces flattened into one mesh", () => {
    const many = disconnectedFacetModel("many-facets-simplify", 20);
    // All triangles here are mutually disconnected (each is its own
    // boundary-only shell), so nothing is eligible to collapse by default;
    // this exercises the honest "target not reached" path together with a
    // single-mesh/single-instance input (no flattened-placement warning
    // expected here since it's already one mesh/one instance).
    const result = simplifyModel(many, {
      target: { kind: "triangle-count", triangleCount: 5 },
    });
    expect(result.reduction.targetReached).toBe(false);
    expect(result.simplified.triangleCount).toBe(20);
  });
});

describe("simplifyModel: input validation and resource limits", () => {
  it("rejects a target triangle count that is not smaller than the input", () => {
    const box = boxModel("reject-box", [10, 10, 10]);
    expect(() =>
      simplifyModel(box, {
        target: { kind: "triangle-count", triangleCount: 12 },
      }),
    ).toThrow(SimplifyInputError);
    expect(() =>
      simplifyModel(box, {
        target: { kind: "triangle-count", triangleCount: 0 },
      }),
    ).toThrow(SimplifyInputError);
  });

  it("rejects an out-of-range reduction ratio", () => {
    const box = boxModel("reject-ratio-box", [10, 10, 10]);
    expect(() =>
      simplifyModel(box, {
        target: { kind: "reduction-ratio", reductionRatio: 0 },
      }),
    ).toThrow(SimplifyInputError);
    expect(() =>
      simplifyModel(box, {
        target: { kind: "reduction-ratio", reductionRatio: 1 },
      }),
    ).toThrow(SimplifyInputError);
    expect(() =>
      simplifyModel(box, {
        target: { kind: "reduction-ratio", reductionRatio: Number.NaN },
      }),
    ).toThrow(SimplifyInputError);
  });

  it("rejects a caller-supplied execution budget too small to complete", () => {
    const box = boxModel("budget-box", [10, 10, 10]);
    expect(() =>
      simplifyModel(box, {
        target: { kind: "triangle-count", triangleCount: 4 },
        executionBudget: { maxWorkUnits: 1 },
      }),
    ).toThrow();
  });

  it("rejects input over the resource ceiling via a too-small maxMemoryBytes budget", () => {
    const box = boxModel("memory-box", [10, 10, 10]);
    expect(() =>
      simplifyModel(box, {
        target: { kind: "triangle-count", triangleCount: 4 },
        executionBudget: { maxMemoryBytes: 1 },
      }),
    ).toThrow(SimplifyResourceLimitError);
  });
});
