import { analysisResultSchema } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_LIMITS,
  analyzeModelPair,
  supportedAnalysisMethods,
} from "../src/index.js";
import { boxModel, request, translation, triangleModel } from "./fixtures.js";

describe("analysis method selection", () => {
  it("advertises explicit semantics and preconditions", () => {
    expect(supportedAnalysisMethods()).toEqual([
      expect.objectContaining({
        id: "surface-distance",
        resultSemantics: "approximate",
      }),
      expect.objectContaining({
        id: "axis-aligned-box-solid",
        resultSemantics: "exact-within-validated-preconditions",
        requiredPreconditions: [
          "closed",
          "consistently-oriented",
          "axis-aligned-box",
        ],
      }),
    ]);
  });

  it("returns indeterminate for an unknown method without substituting one", () => {
    const result = analyzeModelPair({
      request: request("unknown-method"),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "unsupported-method",
      requestedMethod: { id: "unknown-method" },
    });
  });

  it("rejects a model that does not match the request binding", () => {
    const result = analyzeModelPair({
      request: request("surface-distance"),
      baseline: boxModel("different-baseline"),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "model-binding-mismatch",
    });
  });
});

describe("approximate surface-distance adapter", () => {
  it("returns deterministic ranked changed regions with honest uncertainty", () => {
    const input = {
      request: request("surface-distance", {
        candidateTransform: translation(0.5),
      }),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    };
    const first = analyzeModelPair(input);
    const second = analyzeModelPair(input);

    expect(second).toEqual(first);
    expect(first.outcome.state).toBe("complete");
    if (first.outcome.state !== "complete") return;
    expect(first.outcome.semantics).toBe("approximate");
    expect(first.outcome.regions.length).toBeGreaterThan(0);
    expect(first.outcome.orderedRegionIds).toEqual(
      first.outcome.regions.map(({ id }) => id),
    );
    expect(
      first.outcome.metrics.find(({ id }) => id === "surface.maximum-distance")
        ?.value,
    ).toBeCloseTo(0.5);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(() => analysisResultSchema.parse(first)).not.toThrow();
    if (first.outcome.semantics === "approximate") {
      expect(first.outcome.uncertainty.description).toMatch(
        /finite vertex and triangle-centroid samples/u,
      );
    }
  });

  it("keeps identical tessellations complete but approximate", () => {
    const result = analyzeModelPair({
      request: request("surface-distance"),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome).toMatchObject({
      state: "complete",
      semantics: "approximate",
      regions: [],
      orderedRegionIds: [],
    });
  });

  it("rejects degenerate surfaces and invalid parameters", () => {
    const degenerate = triangleModel("baseline");
    degenerate.meshes[0]!.geometry.positions[3] = 0;
    degenerate.meshes[0]!.geometry.positions[4] = 0;
    const failed = analyzeModelPair({
      request: request("surface-distance"),
      baseline: degenerate,
      candidate: triangleModel("candidate"),
    });
    expect(failed.outcome).toMatchObject({
      state: "indeterminate",
      code: "surface-precondition-failed",
    });

    const invalidParameter = analyzeModelPair({
      request: request("surface-distance", {
        parameters: { maxRegions: ANALYSIS_LIMITS.maxReportedRegions + 1 },
      }),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    });
    expect(invalidParameter.outcome).toMatchObject({
      state: "indeterminate",
      code: "invalid-method-parameters",
    });
  });

  it("fails closed before work when the caller budget is insufficient", () => {
    const result = analyzeModelPair({
      request: request("surface-distance", { maxWorkUnits: 1 }),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "resource-budget-exceeded",
    });
  });
});

describe("exact axis-aligned-box adapter", () => {
  it("returns exact volumes and ranked added and removed cells in its domain", () => {
    const result = analyzeModelPair({
      request: request("axis-aligned-box-solid", {
        candidateTransform: translation(1),
      }),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.semantics).toBe(
      "exact-within-validated-preconditions",
    );
    expect(result.outcome.regions.map(({ category }) => category)).toEqual([
      "added",
      "removed",
    ]);
    expect(
      result.outcome.metrics.find(
        ({ id }) => id === "solid.symmetric-difference-volume",
      )?.value,
    ).toBe(8);
    if (result.outcome.semantics === "exact-within-validated-preconditions") {
      expect(result.outcome.validatedDomain.preconditionIds).toEqual([
        "closed",
        "consistently-oriented",
        "axis-aligned-box",
      ]);
    }
    expect(() => analysisResultSchema.parse(result)).not.toThrow();
  });

  it("returns indeterminate for open geometry instead of making a solid claim", () => {
    const result = analyzeModelPair({
      request: request("axis-aligned-box-solid"),
      baseline: boxModel("baseline", [2, 2, 2], { open: true }),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "solid-precondition-failed",
    });
    if (result.outcome.state === "indeterminate") {
      expect(result.outcome.validation[0]).toMatchObject({
        closed: false,
        boundaryEdgeCount: 4,
      });
    }
  });

  it("does not accept parameters intended for another adapter", () => {
    const result = analyzeModelPair({
      request: request("axis-aligned-box-solid", {
        parameters: { maxRegions: 1 },
      }),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "invalid-method-parameters",
    });
  });
});

describe("hostile input boundaries", () => {
  it("rejects malformed normalized geometry at the contract boundary", () => {
    const baseline = boxModel("baseline");
    baseline.meshes[0]!.geometry.positions[0] = Number.NaN;
    expect(() =>
      analyzeModelPair({
        request: request("surface-distance"),
        baseline,
        candidate: boxModel("candidate"),
      }),
    ).toThrow(/Positions must be finite/u);
  });

  it("returns indeterminate when finite coordinates overflow calculations", () => {
    const baseline = triangleModel("baseline");
    const candidate = triangleModel("candidate");
    candidate.meshes[0]!.geometry.positions.set([
      1e308, 0, 0, 1e308, 1, 0, 1e308, 0, 1,
    ]);
    const result = analyzeModelPair({
      request: request("surface-distance"),
      baseline,
      candidate,
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "numeric-range-exceeded",
    });
  });
});
