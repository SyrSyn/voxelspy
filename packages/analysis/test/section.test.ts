import { describe, expect, it } from "vitest";

import {
  SectionInputError,
  SectionResourceLimitError,
  sectionModel,
} from "../src/index.js";
import type { SectionPlane } from "../src/index.js";
import { boxWithInternalVoidModel } from "./adversarial-fixtures.js";
import { boxModel, coarsePanelModel } from "./fixtures.js";

const box = boxModel("box", [2, 2, 2]);

describe("sectionModel: a plane cutting a box", () => {
  it("produces one closed rectangular loop with the exact perimeter and area", () => {
    const result = sectionModel(box, { point: [0, 0, 1], normal: [0, 0, 1] });
    expect(result.semantics).toBe("exact");
    expect(result.coincidentTriangleCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.loops.loopCount).toBe(1);
    expect(result.loops.loopsTruncated).toBe(false);
    const [loop] = result.loops.loops;
    expect(loop).toBeDefined();
    expect(loop!.closed).toBe(true);
    // 8, not 4: each of the box's 4 side walls is itself triangulated along
    // a diagonal spanning z=[0,2], and that diagonal is also crossed at
    // z=1, so each wall contributes two collinear segments (through the
    // diagonal's own midpoint) rather than one -- this does not change the
    // loop's shape, perimeter, or area, only its point/edge count.
    expect(loop!.edgeCount).toBe(8);
    expect(loop!.pointsTruncated).toBe(false);
    expect(loop!.perimeterMillimetres).toBe(8);
    expect(loop!.area).toEqual({
      available: true,
      signedSquareMillimetres: -4,
      absoluteSquareMillimetres: 4,
    });
    const points = [...loop!.pointsMillimetres].sort(
      (a, b) => a[0] - b[0] || a[1] - b[1],
    );
    expect(points).toEqual([
      [0, 0, 1],
      [0, 1, 1],
      [0, 2, 1],
      [1, 0, 1],
      [1, 2, 1],
      [2, 0, 1],
      [2, 1, 1],
      [2, 2, 1],
    ]);
  });

  it("normalizes a non-unit plane normal", () => {
    const result = sectionModel(box, { point: [0, 0, 1], normal: [0, 0, 5] });
    expect(result.plane.unitNormal).toEqual([0, 0, 1]);
  });
});

describe("sectionModel: two separate loops", () => {
  it("orders loops deterministically (outer boundary before the inner void)", () => {
    const model = boxWithInternalVoidModel(
      "void-box",
      [20, 20, 20],
      [6, 6, 6],
      [7, 7, 7],
    );
    const result = sectionModel(model, {
      point: [0, 0, 10],
      normal: [0, 0, 1],
    });
    expect(result.loops.loopCount).toBe(2);
    const [outer, inner] = result.loops.loops;
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();

    expect(outer!.closed).toBe(true);
    // 8, not 4: see the analogous note in the "plane cutting a box" test --
    // each wall's own triangulation diagonal is crossed too.
    expect(outer!.edgeCount).toBe(8);
    expect(outer!.perimeterMillimetres).toBe(80);
    expect(outer!.area.available).toBe(true);
    if (outer!.area.available) {
      expect(outer!.area.absoluteSquareMillimetres).toBe(400);
    }

    expect(inner!.closed).toBe(true);
    expect(inner!.edgeCount).toBe(8);
    expect(inner!.perimeterMillimetres).toBe(24);
    expect(inner!.area.available).toBe(true);
    if (inner!.area.available) {
      expect(inner!.area.absoluteSquareMillimetres).toBe(36);
    }

    // The outer loop's lexicographically-smallest canonical start point is
    // (0,0,10); the inner loop's is (7,7,10) -- outer sorts first.
    expect(outer!.pointsMillimetres[0]).toEqual([0, 0, 10]);
    expect(inner!.pointsMillimetres[0]).toEqual([7, 7, 10]);
  });
});

describe("sectionModel: a plane coincident with a face", () => {
  it("excludes the coincident triangles but still recovers the boundary from their neighbors", () => {
    const result = sectionModel(box, { point: [0, 0, 0], normal: [0, 0, 1] });
    expect(result.coincidentTriangleCount).toBe(2);
    expect(result.warnings).toEqual([
      {
        code: "section.plane-coincident-with-faces",
        severity: "warning",
        message: expect.stringContaining("2 triangle(s)"),
      },
    ]);
    expect(result.loops.loopCount).toBe(1);
    const [loop] = result.loops.loops;
    expect(loop!.closed).toBe(true);
    // 4, not 8: the recovered segments here are the side walls' real
    // (already on-plane) bottom edges, not diagonal crossings -- see
    // sectionModel's "Coincident-plane" documentation.
    expect(loop!.edgeCount).toBe(4);
    expect(loop!.perimeterMillimetres).toBe(8);
    expect(loop!.area).toEqual({
      available: true,
      signedSquareMillimetres: -4,
      absoluteSquareMillimetres: 4,
    });
  });
});

describe("sectionModel: a plane missing the model entirely", () => {
  it("returns an empty section, not an error", () => {
    const result = sectionModel(box, {
      point: [0, 0, 100],
      normal: [0, 0, 1],
    });
    expect(result.loops).toEqual({
      loops: [],
      loopCount: 0,
      loopsTruncated: false,
    });
    expect(result.coincidentTriangleCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});

describe("sectionModel: open (non-closed) chains", () => {
  it("reports a terminated chain honestly, with area unavailable", () => {
    const panel = coarsePanelModel("panel");
    const result = sectionModel(panel, {
      point: [0, 50, 0],
      normal: [0, 1, 0],
    });
    expect(result.loops.loopCount).toBe(1);
    const [loop] = result.loops.loops;
    expect(loop!.closed).toBe(false);
    expect(loop!.edgeCount).toBe(2);
    expect(loop!.perimeterMillimetres).toBe(100);
    expect(loop!.area).toEqual({ available: false, reason: "not-closed" });
    expect(loop!.pointsMillimetres).toEqual([
      [0, 50, 0],
      [50, 50, 0],
      [100, 50, 0],
    ]);
  });
});

describe("sectionModel: truncation flags", () => {
  it("sets loopsTruncated and reports the true loopCount when maxLoops is exceeded", () => {
    const model = boxWithInternalVoidModel(
      "void-box-trunc",
      [20, 20, 20],
      [6, 6, 6],
      [7, 7, 7],
    );
    const result = sectionModel(
      model,
      { point: [0, 0, 10], normal: [0, 0, 1] },
      { maxLoops: 1 },
    );
    expect(result.loops.loopCount).toBe(2);
    expect(result.loops.loops.length).toBe(1);
    expect(result.loops.loopsTruncated).toBe(true);
    expect(result.warnings.some((w) => w.code === "section.loop-limit")).toBe(
      true,
    );
  });

  it("truncates points but keeps edgeCount/perimeter/area exact", () => {
    const result = sectionModel(
      box,
      { point: [0, 0, 1], normal: [0, 0, 1] },
      { maxLoopPoints: 2 },
    );
    const [loop] = result.loops.loops;
    expect(loop!.pointsMillimetres.length).toBe(2);
    expect(loop!.pointsTruncated).toBe(true);
    expect(loop!.edgeCount).toBe(8);
    expect(loop!.perimeterMillimetres).toBe(8);
    expect(loop!.area).toEqual({
      available: true,
      signedSquareMillimetres: -4,
      absoluteSquareMillimetres: 4,
    });
  });
});

describe("sectionModel: determinism", () => {
  it("produces a deeply equal result for identical input", () => {
    const model = boxWithInternalVoidModel(
      "void-box-det",
      [20, 20, 20],
      [6, 6, 6],
      [7, 7, 7],
    );
    const plane: SectionPlane = { point: [0, 0, 10], normal: [0, 0, 1] };
    const first = sectionModel(model, plane);
    const second = sectionModel(model, plane);
    expect(first).toEqual(second);
  });
});

describe("sectionModel: resource limits and validation", () => {
  it("rejects a degenerate plane normal", () => {
    expect(() =>
      sectionModel(box, { point: [0, 0, 1], normal: [0, 0, 0] }),
    ).toThrow(SectionInputError);
  });

  it("rejects a non-finite plane point", () => {
    expect(() =>
      sectionModel(box, {
        point: [Number.NaN, 0, 1],
        normal: [0, 0, 1],
      }),
    ).toThrow(SectionInputError);
  });

  it("rejects an out-of-range maxLoops", () => {
    expect(() =>
      sectionModel(
        box,
        { point: [0, 0, 1], normal: [0, 0, 1] },
        { maxLoops: -1 },
      ),
    ).toThrow(RangeError);
  });

  it("throws SectionResourceLimitError when the memory budget is too small", () => {
    expect(() =>
      sectionModel(
        box,
        { point: [0, 0, 1], normal: [0, 0, 1] },
        { executionBudget: { maxMemoryBytes: 1 } },
      ),
    ).toThrow(SectionResourceLimitError);
  });

  it("fails closed with WorkBudgetExceeded when the work budget is too small", () => {
    expect(() =>
      sectionModel(
        box,
        { point: [0, 0, 1], normal: [0, 0, 1] },
        { executionBudget: { maxWorkUnits: 1 } },
      ),
    ).toThrow(/work budget|Analysis exhausted/i);
  });
});
