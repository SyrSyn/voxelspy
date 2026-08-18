import { ANALYSIS_LIMITS } from "@voxelspy/analysis";
import { describe, expect, it } from "vitest";
import { sourceCapability, sourceSelectionForFile } from "./ComparisonFlow";
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
