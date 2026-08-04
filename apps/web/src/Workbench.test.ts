import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { toRenderPositions } from "./Workbench";

describe("workbench rendering coordinates", () => {
  it("preserves small differences at large world offsets", () => {
    const positions = toRenderPositions(
      new Float64Array([1_000_000_000, 2, 3, 1_000_000_000.5, 2, 3]),
      new Matrix4(),
      new Vector3(1_000_000_000, 0, 0),
    );
    expect([...positions]).toEqual([0, 2, 3, 0.5, 2, 3]);
  });
});
