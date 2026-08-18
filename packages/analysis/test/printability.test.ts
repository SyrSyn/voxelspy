import { describe, expect, it } from "vitest";

import {
  PrintabilityInputError,
  PrintabilityResourceLimitError,
  assessPrintability,
} from "../src/index.js";
import {
  boxModel,
  coarsePanelModel,
  disconnectedFacetModel,
  tiltedPanelModel,
  twoDisjointBoxesModel,
} from "./fixtures.js";

describe("assessPrintability: wall thickness", () => {
  it("reports a known thin plate's thickness within tolerance", () => {
    const plate = boxModel("thin-plate", [50, 50, 0.6]);
    const result = assessPrintability(plate);
    expect(result.wallThickness.semantics).toBe(
      "approximate-directional-probe",
    );
    expect(result.wallThickness.findings.length).toBeGreaterThan(0);
    for (const finding of result.wallThickness.findings) {
      expect(finding.thicknessMillimetres).toBeCloseTo(0.6, 6);
    }
    // The plate's top and bottom faces (2 triangles each) are the only thin
    // findings; the four side walls probe to ~50mm, well above the default
    // threshold.
    expect(result.wallThickness.findingCount).toBe(4);
  });

  it("reports no thin findings for a thick box at a small threshold", () => {
    const box = boxModel("thick-box", [20, 20, 20]);
    const result = assessPrintability(box, {
      wallThickness: { thinThresholdMillimetres: 0.5 },
    });
    expect(result.wallThickness.findings).toEqual([]);
    expect(result.wallThickness.findingCount).toBe(0);
  });

  it("truncates findings by maxFindings while still reporting the true findingCount", () => {
    const plate = boxModel("thin-plate-truncated", [50, 50, 0.6]);
    const result = assessPrintability(plate, {
      wallThickness: { maxFindings: 1 },
    });
    expect(result.wallThickness.findingCount).toBe(4);
    expect(result.wallThickness.findings.length).toBe(1);
    expect(result.wallThickness.truncated).toBe(true);
    expect(
      result.warnings.some(
        (warning) =>
          warning.code === "printability.wall-thickness-finding-limit",
      ),
    ).toBe(true);
  });

  it("reports a coarse mesh's own sample-spacing upper bound, acknowledging a thin feature between samples could be missed", () => {
    const panel = coarsePanelModel("coarse-panel");
    const result = assessPrintability(panel);
    // Two triangles, budget covers both: full coverage, but the bound
    // itself is large because the tessellation is coarse (hypotenuse
    // ~141.42mm).
    expect(result.wallThickness.sampledTriangleCount).toBe(2);
    expect(result.wallThickness.totalTriangleCount).toBe(2);
    expect(result.wallThickness.unsampledTriangleCount).toBe(0);
    expect(result.wallThickness.sampleSpacingUpperBoundMillimetres).toBeCloseTo(
      (2 / 3) * Math.hypot(100, 100),
      6,
    );
  });

  it("reports unsampled triangles and warns when the sample budget is smaller than the mesh", () => {
    const many = disconnectedFacetModel("many-facets", 200);
    const result = assessPrintability(many, {
      wallThickness: { maxSampleTriangles: 10 },
    });
    expect(result.wallThickness.sampledTriangleCount).toBe(10);
    expect(result.wallThickness.totalTriangleCount).toBe(200);
    expect(result.wallThickness.unsampledTriangleCount).toBe(190);
    expect(
      result.warnings.some(
        (warning) =>
          warning.code === "printability.wall-thickness-undersampled",
      ),
    ).toBe(true);
  });
});

describe("assessPrintability: overhangs", () => {
  it("flags an overhang above the threshold with exact area", () => {
    const panel = tiltedPanelModel("overhang-60", 60, 10);
    const result = assessPrintability(panel);
    expect(result.overhangs.semantics).toBe("exact-for-tessellated-surface");
    expect(result.overhangs.detectedRegionCount).toBe(1);
    expect(result.overhangs.regions.length).toBe(1);
    expect(
      result.overhangs.regions[0]!.maxAngleFromVerticalDegrees,
    ).toBeCloseTo(60, 6);
    expect(result.overhangs.overhangAreaSquareMillimetres).toBeCloseTo(100, 6);
    expect(result.overhangs.totalSurfaceAreaSquareMillimetres).toBeCloseTo(
      100,
      6,
    );
    expect(result.overhangs.overhangAreaFraction).toBeCloseTo(1, 6);
  });

  it("does not flag a face below the threshold", () => {
    const panel = tiltedPanelModel("overhang-30", 30, 10);
    const result = assessPrintability(panel);
    expect(result.overhangs.detectedRegionCount).toBe(0);
    expect(result.overhangs.regions).toEqual([]);
    expect(result.overhangs.overhangAreaSquareMillimetres).toBe(0);
    expect(result.overhangs.overhangAreaFraction).toBe(0);
  });

  it("does not flag a face exactly at the threshold (strictly-greater rule)", () => {
    const panel = tiltedPanelModel("overhang-45", 45, 10);
    const result = assessPrintability(panel, {
      overhang: { thresholdDegreesFromVertical: 45 },
    });
    expect(result.overhangs.detectedRegionCount).toBe(0);
  });

  it("truncates regions by maxRegions while still reporting detectedRegionCount", () => {
    // Every disconnected facet is its own overhang region when the build
    // direction is reversed against their shared +Z normal.
    const many = disconnectedFacetModel("many-overhangs", 20);
    const result = assessPrintability(many, {
      overhang: { buildDirection: [0, 0, -1], maxRegions: 3 },
    });
    expect(result.overhangs.detectedRegionCount).toBe(20);
    expect(result.overhangs.regions.length).toBe(3);
    expect(result.overhangs.truncated).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.code === "printability.overhang-region-limit",
      ),
    ).toBe(true);
  });
});

describe("assessPrintability: islands", () => {
  it("reports both islands of a two-component model", () => {
    const model = twoDisjointBoxesModel(
      "two-boxes",
      [10, 10, 10],
      [4, 4, 4],
      [100, 0, 0],
    );
    const result = assessPrintability(model);
    expect(result.islands.semantics).toBe("exact-connectivity");
    expect(result.islands.componentCount).toBe(2);
    expect(result.islands.components.length).toBe(2);
    const [first, second] = result.islands.components;
    expect(first!.triangleCount).toBe(12);
    expect(second!.triangleCount).toBe(12);
    expect(first!.volume.available).toBe(true);
    expect(second!.volume.available).toBe(true);
    if (first!.volume.available && second!.volume.available) {
      const volumes = [
        first!.volume.cubicMillimetres,
        second!.volume.cubicMillimetres,
      ].sort((a, b) => a - b);
      expect(volumes[0]).toBeCloseTo(64, 6);
      expect(volumes[1]).toBeCloseTo(1000, 6);
    }
  });

  it("truncates components by maxComponents while still reporting componentCount", () => {
    const many = disconnectedFacetModel("many-islands", 50);
    const result = assessPrintability(many, {
      islands: { maxComponents: 3 },
    });
    expect(result.islands.componentCount).toBe(50);
    expect(result.islands.components.length).toBe(3);
    expect(result.islands.truncated).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.code === "printability.island-limit",
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.code === "printability.multiple-islands",
      ),
    ).toBe(true);
  });
});

describe("assessPrintability: build volume", () => {
  it("reports not-configured when no build volume is supplied", () => {
    const box = boxModel("no-build-volume", [10, 10, 10]);
    const result = assessPrintability(box);
    expect(result.buildVolume.semantics).toBe("not-configured");
  });

  it("reports a fit as given", () => {
    const box = boxModel("fits-as-given", [5, 5, 5]);
    const result = assessPrintability(box, {
      buildVolume: { dimensionsMillimetres: [10, 10, 10] },
    });
    expect(result.buildVolume.semantics).toBe("exact-axis-aligned-fit");
    if (result.buildVolume.semantics === "exact-axis-aligned-fit") {
      expect(result.buildVolume.fitsAsGiven).toBe(true);
      expect(result.buildVolume.fitsInAnyOrientation).toBe(true);
    }
  });

  it("reports a fit only via an axis permutation", () => {
    const box = boxModel("fits-only-reoriented", [5, 20, 5]);
    const result = assessPrintability(box, {
      buildVolume: { dimensionsMillimetres: [10, 10, 30] },
    });
    expect(result.buildVolume.semantics).toBe("exact-axis-aligned-fit");
    if (result.buildVolume.semantics === "exact-axis-aligned-fit") {
      expect(result.buildVolume.fitsAsGiven).toBe(false);
      expect(result.buildVolume.fitsInAnyOrientation).toBe(true);
      expect(result.buildVolume.orientations.some((o) => o.fits)).toBe(true);
    }
    expect(
      result.warnings.some(
        (warning) => warning.code === "printability.fits-only-when-reoriented",
      ),
    ).toBe(true);
  });

  it("reports a non-fit in any orientation, with the excess per axis", () => {
    const box = boxModel("does-not-fit", [50, 50, 50]);
    const result = assessPrintability(box, {
      buildVolume: { dimensionsMillimetres: [10, 10, 10] },
    });
    expect(result.buildVolume.semantics).toBe("exact-axis-aligned-fit");
    if (result.buildVolume.semantics === "exact-axis-aligned-fit") {
      expect(result.buildVolume.fitsAsGiven).toBe(false);
      expect(result.buildVolume.fitsInAnyOrientation).toBe(false);
      for (const orientation of result.buildVolume.orientations) {
        expect(orientation.fits).toBe(false);
        for (const excess of orientation.exceedsByMillimetres) {
          expect(excess).toBeCloseTo(40, 6);
        }
      }
    }
    expect(
      result.warnings.some(
        (warning) => warning.code === "printability.exceeds-build-volume",
      ),
    ).toBe(true);
  });
});

describe("assessPrintability: scale plausibility", () => {
  it("does not flag a common desktop-printer-scale model", () => {
    const box = boxModel("plausible-scale", [50, 50, 50]);
    const result = assessPrintability(box);
    expect(result.scale.implausible).toBe(false);
    expect(result.scale.implausibleReason).toBeUndefined();
  });

  it("flags an implausibly small model", () => {
    const box = boxModel("implausibly-small", [0.01, 0.01, 0.01]);
    const result = assessPrintability(box);
    expect(result.scale.implausible).toBe(true);
    expect(result.scale.implausibleReason).toBe(
      "smaller-than-typical-print-scale",
    );
  });

  it("flags an implausibly large model", () => {
    const box = boxModel("implausibly-large", [5000, 5000, 5000]);
    const result = assessPrintability(box);
    expect(result.scale.implausible).toBe(true);
    expect(result.scale.implausibleReason).toBe(
      "larger-than-typical-build-volume",
    );
  });

  it("echoes the model's own import-resolved unit, never guessing", () => {
    const box = boxModel("unit-echo", [10, 10, 10]);
    const result = assessPrintability(box);
    expect(result.scale.sourceUnit).toBe(box.provenance.sourceUnit);
    expect(result.scale.detectedSourceUnit).toBe(
      box.provenance.detectedSourceUnit,
    );
  });
});

describe("assessPrintability: framing and determinism", () => {
  it("always carries the printability disclaimer", () => {
    const box = boxModel("disclaimer-box", [10, 10, 10]);
    const result = assessPrintability(box);
    expect(result.disclaimer.length).toBeGreaterThan(0);
    expect(result.disclaimer).toMatch(/not a printability verdict/i);
  });

  it("produces a deeply equal result for identical input", () => {
    const box = boxModel("determinism-box", [10, 10, 0.6]);
    const options = {
      buildVolume: {
        dimensionsMillimetres: [50, 50, 50] as [number, number, number],
      },
    };
    const first = assessPrintability(box, options);
    const second = assessPrintability(box, options);
    expect(first).toEqual(second);
  });
});

describe("assessPrintability: resource limits and validation", () => {
  it("throws on schema-invalid model input", () => {
    expect(() => assessPrintability({} as never)).toThrow();
  });

  it("throws PrintabilityResourceLimitError when the memory budget is too small", () => {
    const box = boxModel("tiny-memory-budget", [10, 10, 10]);
    expect(() =>
      assessPrintability(box, {
        executionBudget: { maxMemoryBytes: 1 },
      }),
    ).toThrow(PrintabilityResourceLimitError);
  });

  it("fails closed with a work-budget error when the work budget is too small", () => {
    const box = boxModel("tiny-work-budget", [10, 10, 10]);
    expect(() =>
      assessPrintability(box, {
        executionBudget: { maxWorkUnits: 1 },
      }),
    ).toThrow(/work budget|Analysis exhausted/i);
  });

  it("throws RangeError for an out-of-range option bound", () => {
    const box = boxModel("bad-bound", [10, 10, 10]);
    expect(() =>
      assessPrintability(box, {
        wallThickness: { thinThresholdMillimetres: -1 },
      }),
    ).toThrow(RangeError);
  });

  it("throws PrintabilityInputError for a degenerate build direction", () => {
    const box = boxModel("bad-build-direction", [10, 10, 10]);
    expect(() =>
      assessPrintability(box, {
        overhang: { buildDirection: [0, 0, 0] },
      }),
    ).toThrow(PrintabilityInputError);
  });

  it("throws PrintabilityInputError for non-positive build volume dimensions", () => {
    const box = boxModel("bad-build-volume", [10, 10, 10]);
    expect(() =>
      assessPrintability(box, {
        buildVolume: { dimensionsMillimetres: [10, 0, 10] },
      }),
    ).toThrow(PrintabilityInputError);
  });
});
