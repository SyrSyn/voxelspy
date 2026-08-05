import { describe, expect, it } from "vitest";
import { sourceCapability, sourceSelectionForFile } from "./ComparisonFlow";

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
});
