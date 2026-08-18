import { describe, expect, it } from "vitest";

import {
  MeasurementInputError,
  MeasurementResourceLimitError,
  measureOnModel,
} from "../src/index.js";
import type { MeasurementQuery, SnapPointResult } from "../src/index.js";
import { boxModel } from "./fixtures.js";

const box = boxModel("box", [2, 2, 2]);

describe("measureOnModel: snap-point (point input)", () => {
  it("snaps exactly to a vertex", () => {
    const result = measureOnModel(box, {
      kind: "snap-point",
      at: { kind: "point", point: [0, 0, 0] },
    });
    expect(result.kind).toBe("snap-point");
    const snapResult = result as SnapPointResult;
    expect(snapResult.outcome.hit).toBe(true);
    if (!snapResult.outcome.hit) throw new Error("expected a hit");
    expect(snapResult.outcome.pointMillimetres).toEqual([0, 0, 0]);
    expect(snapResult.outcome.snap).toEqual({
      kind: "vertex",
      positionMillimetres: [0, 0, 0],
    });
  });

  it("snaps exactly to an edge", () => {
    const result = measureOnModel(box, {
      kind: "snap-point",
      at: { kind: "point", point: [1, 0, 0] },
    });
    if (result.kind !== "snap-point" || !result.outcome.hit) {
      throw new Error("expected a snap-point hit");
    }
    expect(result.outcome.pointMillimetres).toEqual([1, 0, 0]);
    expect(result.outcome.snap.kind).toBe("edge");
    if (result.outcome.snap.kind !== "edge") return;
    const endpoints = [...result.outcome.snap.endpointsMillimetres].sort(
      (a, b) => a[0] - b[0],
    );
    expect(endpoints).toEqual([
      [0, 0, 0],
      [2, 0, 0],
    ]);
  });

  it("reports a face-interior point outside the snap tolerance", () => {
    // (1.4, 0.6, 0) sits inside the bottom face's lower-right triangle,
    // well clear of every real box edge/vertex AND the triangulation's own
    // internal diagonal (the (0,0,0)-(2,2,0) split of the bottom quad).
    const result = measureOnModel(box, {
      kind: "snap-point",
      at: { kind: "point", point: [1.4, 0.6, 0] },
    });
    if (result.kind !== "snap-point" || !result.outcome.hit) {
      throw new Error("expected a snap-point hit");
    }
    expect(result.outcome.pointMillimetres).toEqual([1.4, 0.6, 0]);
    expect(result.outcome.snap).toEqual({ kind: "face" });
  });

  it("prefers vertex classification over edge when both are within tolerance", () => {
    const result = measureOnModel(
      box,
      { kind: "snap-point", at: { kind: "point", point: [0.2, 0, 0] } },
      { snapToleranceMillimetres: 0.5 },
    );
    if (result.kind !== "snap-point" || !result.outcome.hit) {
      throw new Error("expected a snap-point hit");
    }
    // (0.2, 0, 0) snaps exactly onto the surface at (0.2, 0, 0), which is
    // within 0.5mm of both vertex (0,0,0) and the edge it sits on -- vertex
    // must win, since it is the more specific classification.
    expect(result.outcome.snap).toEqual({
      kind: "vertex",
      positionMillimetres: [0, 0, 0],
    });
  });

  it("snapToleranceMillimetres bounds which classification is chosen", () => {
    // (0.2, 0.35, 0) is 0.403mm from vertex (0,0,0), and its nearest edge
    // (the bottom face's internal diagonal) is 0.106mm away.
    const nearVertex: { kind: "point"; point: [number, number, number] } = {
      kind: "point",
      point: [0.2, 0.35, 0],
    };
    const loose = measureOnModel(
      box,
      { kind: "snap-point", at: nearVertex },
      { snapToleranceMillimetres: 0.5 },
    );
    const tight = measureOnModel(
      box,
      { kind: "snap-point", at: nearVertex },
      { snapToleranceMillimetres: 0.05 },
    );
    if (loose.kind !== "snap-point" || !loose.outcome.hit)
      throw new Error("expected a hit");
    if (tight.kind !== "snap-point" || !tight.outcome.hit)
      throw new Error("expected a hit");
    expect(loose.outcome.snap.kind).toBe("vertex");
    expect(tight.outcome.snap.kind).toBe("face");
  });
});

describe("measureOnModel: snap-point (ray input)", () => {
  it("casts a ray onto the exact surface intersection point", () => {
    // Hits the x=0 face at (0, 1.4, 0.6): clear of every edge/vertex and of
    // that face's own internal triangulation diagonal ((0,0,0)-(0,2,2)).
    const result = measureOnModel(box, {
      kind: "snap-point",
      at: { kind: "ray", origin: [-5, 1.4, 0.6], direction: [1, 0, 0] },
    });
    if (result.kind !== "snap-point" || !result.outcome.hit) {
      throw new Error("expected a snap-point hit");
    }
    expect(result.outcome.pointMillimetres).toEqual([0, 1.4, 0.6]);
    expect(result.outcome.snap).toEqual({ kind: "face" });
  });

  it("reports a miss, not an error, when the ray never crosses the surface", () => {
    const result = measureOnModel(box, {
      kind: "snap-point",
      at: { kind: "ray", origin: [-5, 10, 10], direction: [1, 0, 0] },
    });
    if (result.kind !== "snap-point")
      throw new Error("expected a snap-point result");
    expect(result.outcome).toEqual({
      hit: false,
      reason: "ray-missed-surface",
    });
  });

  it("rejects a degenerate (zero-length) ray direction", () => {
    expect(() =>
      measureOnModel(box, {
        kind: "snap-point",
        at: { kind: "ray", origin: [-5, 1, 1], direction: [0, 0, 0] },
      }),
    ).toThrow(MeasurementInputError);
  });
});

describe("measureOnModel: point-to-point", () => {
  it("returns the exact distance and componentwise delta", () => {
    const result = measureOnModel(box, {
      kind: "point-to-point",
      first: [0, 0, 0],
      second: [3, 4, 0],
    });
    if (result.kind !== "point-to-point") throw new Error("wrong kind");
    expect(result.distanceMillimetres).toBe(5);
    expect(result.deltaMillimetres).toEqual([3, 4, 0]);
  });

  it("rejects non-finite point coordinates", () => {
    expect(() =>
      measureOnModel(box, {
        kind: "point-to-point",
        first: [0, 0, 0],
        second: [Number.NaN, 0, 0],
      }),
    ).toThrow(MeasurementInputError);
  });
});

describe("measureOnModel: point-to-surface", () => {
  it("measures from a point inside the model", () => {
    const result = measureOnModel(box, {
      kind: "point-to-surface",
      point: [1, 1, 1],
    });
    if (result.kind !== "point-to-surface") throw new Error("wrong kind");
    expect(result.distanceMillimetres).toBe(1);
  });

  it("measures from a point outside the model", () => {
    const result = measureOnModel(box, {
      kind: "point-to-surface",
      point: [5, 1, 1],
    });
    if (result.kind !== "point-to-surface") throw new Error("wrong kind");
    expect(result.distanceMillimetres).toBe(3);
    expect(result.closestPointMillimetres).toEqual([2, 1, 1]);
  });
});

describe("measureOnModel: bounding-extent", () => {
  it("reuses summarizeModelGeometry's own bounds computation", () => {
    const result = measureOnModel(box, { kind: "bounding-extent" });
    if (result.kind !== "bounding-extent") throw new Error("wrong kind");
    expect(result.bounds).toEqual({
      available: true,
      min: [0, 0, 0],
      max: [2, 2, 2],
      dimensionsMillimetres: [2, 2, 2],
    });
  });
});

describe("measureOnModel: determinism", () => {
  it("produces a deeply equal result for identical input", () => {
    const query: MeasurementQuery = {
      kind: "snap-point",
      at: { kind: "point", point: [0.3, 0.1, 0] },
    };
    const first = measureOnModel(box, query);
    const second = measureOnModel(box, query);
    expect(first).toEqual(second);
  });
});

describe("measureOnModel: resource limits and validation", () => {
  it("throws MeasurementInputError for non-finite query coordinates", () => {
    expect(() =>
      measureOnModel(box, {
        kind: "point-to-surface",
        point: [Number.POSITIVE_INFINITY, 0, 0],
      }),
    ).toThrow(MeasurementInputError);
  });

  it("throws RangeError for an out-of-range snap tolerance", () => {
    expect(() =>
      measureOnModel(
        box,
        { kind: "snap-point", at: { kind: "point", point: [0, 0, 0] } },
        { snapToleranceMillimetres: -1 },
      ),
    ).toThrow(RangeError);
  });

  it("throws MeasurementResourceLimitError when the memory budget is too small", () => {
    expect(() =>
      measureOnModel(
        box,
        { kind: "bounding-extent" },
        { executionBudget: { maxMemoryBytes: 1 } },
      ),
    ).toThrow(MeasurementResourceLimitError);
  });

  it("fails closed with WorkBudgetExceeded when the work budget is too small", () => {
    expect(() =>
      measureOnModel(
        box,
        { kind: "point-to-surface", point: [1, 1, 1] },
        { executionBudget: { maxWorkUnits: 1 } },
      ),
    ).toThrow(/work budget|Analysis exhausted/i);
  });
});
