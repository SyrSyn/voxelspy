import { IDENTITY_MAT4, rigidTransformSchema } from "@voxelspy/contracts";
import type {
  Mat4,
  NormalizedModel,
  RigidTransform,
} from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_INTERFERING_TRIANGLE_PAIRS,
  checkClearance,
} from "../src/index.js";
import type { CheckClearanceInput, ClearancePlacement } from "../src/index.js";
import {
  boxModel,
  coarsePanelModel,
  disconnectedFacetModel,
  squareChannelModel,
  translation,
} from "./fixtures.js";
import { rotationZ } from "./test-utils.js";

function rigid(matrix: Mat4): RigidTransform {
  return rigidTransformSchema.parse(matrix);
}

function place(
  model: NormalizedModel,
  transform: Mat4 = IDENTITY_MAT4,
): ClearancePlacement {
  return { model, modelToComparison: rigid(transform) };
}

describe("checkClearance: separated boxes", () => {
  it("reports a clear state with the exact minimum distance and a measurable closest-point pair", () => {
    const gap = 5;
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0, 0, 2 + gap)),
      desiredClearanceMillimetres: 1,
    };
    const result = checkClearance(input);
    expect(result.state).toBe("clear");
    if (result.state === "indeterminate") return;
    expect(result.minimumDistanceMillimetres).toBe(gap);
    expect(result.closestPoints.first[2]).toBe(2);
    expect(result.closestPoints.second[2]).toBe(2 + gap);
    expect(result.tightRegions.regions).toEqual([]);
    expect(result.interference.trianglePairs).toEqual([]);
    expect(result.interference.detectedPairCount).toBe(0);
    expect(result.interference.volume).toEqual({
      available: false,
      reason: expect.any(String),
    });
    expect(result.semantics).toBe("approximate");
  });

  it("reports a tight state with a ranked tight region when the gap is below the desired clearance", () => {
    const gap = 0.5;
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0, 0, 2 + gap)),
      desiredClearanceMillimetres: 1,
    };
    const result = checkClearance(input);
    expect(result.state).toBe("tight");
    if (result.state === "indeterminate") return;
    expect(result.minimumDistanceMillimetres).toBe(gap);
    expect(result.tightRegions.regions.length).toBeGreaterThan(0);
    expect(result.tightRegions.detectedRegionCount).toBe(
      result.tightRegions.regions.length,
    );
    expect(result.tightRegions.truncated).toBe(false);
    for (const region of result.tightRegions.regions) {
      expect(region.minimumDistanceMillimetres).toBeLessThan(1);
      expect(region.minimumDistanceMillimetres).toBeGreaterThanOrEqual(0);
      expect(["first", "second"]).toContain(region.part);
      expect(region.triangleIndices.length).toBeGreaterThan(0);
    }
    // The two faces facing each other are exactly `gap` apart; that must be
    // the tightest reported region.
    expect(result.tightRegions.regions[0]!.minimumDistanceMillimetres).toBe(
      gap,
    );
    expect(result.interference.trianglePairs).toEqual([]);
  });
});

describe("checkClearance: interference", () => {
  it("reports an interfering state with intersecting triangle pairs for overlapping boxes", () => {
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(1, 1, 1)),
      desiredClearanceMillimetres: 1,
    };
    const result = checkClearance(input);
    expect(result.state).toBe("interfering");
    if (result.state === "indeterminate") return;
    // The two solids genuinely interpenetrate, but the sampled surface
    // points never happen to land exactly on the opposite surface here, so
    // the sampled minimum distance is a small positive number, not zero --
    // this is exactly why `interference.trianglePairs` (an exact geometric
    // test, not a sample) is the authoritative interference signal, not
    // `minimumDistanceMillimetres === 0`.
    expect(result.minimumDistanceMillimetres).toBeGreaterThan(0);
    expect(result.interference.detectedPairCount).toBeGreaterThan(0);
    expect(result.interference.trianglePairs.length).toBeGreaterThan(0);
    for (const pair of result.interference.trianglePairs) {
      expect(pair.firstTriangleIndex).toBeGreaterThanOrEqual(0);
      expect(pair.secondTriangleIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports an interfering state for face-to-face coincident boxes", () => {
    // The second box's bottom face is placed exactly on the first box's top
    // face: zero gap, coincident (not crossing) surfaces.
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0, 0, 2)),
      desiredClearanceMillimetres: 1,
    };
    const result = checkClearance(input);
    expect(result.state).toBe("interfering");
    if (result.state === "indeterminate") return;
    expect(result.minimumDistanceMillimetres).toBe(0);
    // The coincident top/bottom faces are coplanar and overlapping, so the
    // exact triangle-triangle test must detect them independent of sampling.
    expect(result.interference.detectedPairCount).toBeGreaterThan(0);
  });

  it("truncates reported triangle pairs while keeping an honest detected count", () => {
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(1, 1, 1)),
      desiredClearanceMillimetres: 1,
    };
    const full = checkClearance(input);
    expect(full.state).toBe("interfering");
    if (full.state === "indeterminate") return;
    expect(full.interference.detectedPairCount).toBeGreaterThan(1);

    const truncated = checkClearance(input, {
      maxInterferingTrianglePairs: 1,
    });
    if (truncated.state === "indeterminate")
      throw new Error("expected complete result");
    expect(truncated.interference.trianglePairs.length).toBe(1);
    expect(truncated.interference.detectedPairCount).toBe(
      full.interference.detectedPairCount,
    );
    expect(truncated.interference.truncated).toBe(true);
    expect(truncated.warnings.map((warning) => warning.code)).toContain(
      "clearance.interference-pair-limit",
    );
  });
});

describe("checkClearance: peg-in-hole with a uniform gap", () => {
  it("measures the same minimum distance regardless of which wall is nearest, proving the gap is uniform", () => {
    // A 10x10x20mm peg centered inside a 16x16mm-opening, 20mm-tall square
    // channel: by construction the gap from every one of the peg's side
    // faces to its nearest wall is (16 - 10) / 2 = 3mm.
    const halfOpening = 8;
    const height = 20;
    const peg = place(
      boxModel("peg", [10, 10, height]),
      translation(-5, -5, 0),
    );
    const socket = place(squareChannelModel("socket", halfOpening, height));

    const clear = checkClearance({
      first: peg,
      second: socket,
      desiredClearanceMillimetres: 2,
    });
    expect(clear.state).toBe("clear");
    if (clear.state === "indeterminate") return;
    expect(clear.minimumDistanceMillimetres).toBe(3);

    const tight = checkClearance({
      first: peg,
      second: socket,
      desiredClearanceMillimetres: 3.5,
    });
    expect(tight.state).toBe("tight");
    if (tight.state === "indeterminate") return;
    expect(tight.minimumDistanceMillimetres).toBe(3);
    expect(tight.tightRegions.regions.length).toBeGreaterThan(0);
    // Every reported tight region shares the exact same minimum distance --
    // the uniform-gap claim, not just a single closest point.
    for (const region of tight.tightRegions.regions) {
      expect(region.minimumDistanceMillimetres).toBe(3);
    }
  });
});

describe("checkClearance: rotated placement transforms", () => {
  it("honors each part's independently supplied rotation rather than ignoring it", () => {
    // Rotating the first box 90 degrees about Z moves it from spanning
    // x:[0,2] to spanning x:[-2,0] (y:[0,2] unchanged). The second box is
    // placed with a pure translation of 0.5mm along x, from x:[0,2] to
    // x:[0.5,2.5]. If the rotation were silently ignored, the two boxes
    // would both occupy x:[0,2]-ish and heavily overlap (interfering); with
    // the rotation honored, they are genuinely 0.5mm apart.
    const input: CheckClearanceInput = {
      first: place(boxModel("first"), rotationZ(Math.PI / 2)),
      second: place(boxModel("second"), translation(0.5, 0, 0)),
      desiredClearanceMillimetres: 0.2,
    };
    const result = checkClearance(input);
    expect(result.state).toBe("clear");
    if (result.state === "indeterminate") return;
    expect(result.minimumDistanceMillimetres).toBeCloseTo(0.5, 9);
  });

  it("still reports the exact zero-gap coincident case correctly under a shared rotation", () => {
    const rotation = rotationZ(Math.PI / 5);
    const input: CheckClearanceInput = {
      first: place(boxModel("first"), rotation),
      second: place(boxModel("second"), rotation),
      desiredClearanceMillimetres: 0.1,
    };
    const result = checkClearance(input);
    // Identically rotated, unseparated boxes at the same placement overlap entirely.
    expect(result.state).toBe("interfering");
  });
});

describe("checkClearance: sampling honesty", () => {
  it("discloses an undersampled bound instead of overclaiming precision for coarse tessellation", () => {
    // `coarsePanelModel` is a single flat 100x100mm panel split into just
    // two triangles (the same fixture `surface-distance`'s sample-spacing
    // tests use); its ~141.42mm hypotenuse longest edge gives a sample
    // spacing bound of roughly 94.28mm -- far larger than a modest desired
    // clearance, so any feature confined to the interior of one of these two
    // huge triangles could be missed. The check must say so explicitly.
    const gap = 20;
    const desiredClearance = 5;
    const input: CheckClearanceInput = {
      first: place(coarsePanelModel("first")),
      second: place(coarsePanelModel("second"), translation(0, 0, gap)),
      desiredClearanceMillimetres: desiredClearance,
    };
    const result = checkClearance(input);
    expect(result.state).toBe("clear");
    if (result.state === "indeterminate") return;
    expect(result.minimumDistanceMillimetres).toBe(gap);
    const uncertainty = result.uncertainty.parameters as Record<
      string,
      unknown
    >;
    expect(uncertainty.undersampled).toBe(true);
    expect(uncertainty.maxSampleSpacingMillimetres).toBeGreaterThan(
      desiredClearance,
    );
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "clearance.undersampled",
    );
    // The bound is real, not a guess: it must not pretend the answer is exact.
    expect(result.semantics).toBe("approximate");
  });

  it("does not warn when the sample spacing is within the desired clearance", () => {
    // A default box's longest edge is a face diagonal (2*sqrt(2) mm), giving
    // a sample-spacing bound of (2/3)*2*sqrt(2) ~= 1.886mm; a desired
    // clearance comfortably above that bound must not be flagged undersampled.
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0, 0, 10)),
      desiredClearanceMillimetres: 2.5,
    };
    const result = checkClearance(input);
    if (result.state === "indeterminate")
      throw new Error("expected complete result");
    expect(
      (result.uncertainty.parameters as Record<string, unknown>).undersampled,
    ).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "clearance.undersampled",
    );
  });
});

describe("checkClearance: tight-region truncation", () => {
  it("truncates reported tight regions while keeping an honest detected count", () => {
    const triangleCount = 6;
    const gap = 0.5;
    const input: CheckClearanceInput = {
      first: place(disconnectedFacetModel("first", triangleCount)),
      second: place(
        disconnectedFacetModel("second", triangleCount),
        translation(0, 0, gap),
      ),
      desiredClearanceMillimetres: 1,
    };
    const full = checkClearance(input);
    if (full.state === "indeterminate")
      throw new Error("expected complete result");
    expect(full.tightRegions.detectedRegionCount).toBeGreaterThan(2);

    const truncated = checkClearance(input, { maxTightRegions: 2 });
    if (truncated.state === "indeterminate")
      throw new Error("expected complete result");
    expect(truncated.tightRegions.regions.length).toBe(2);
    expect(truncated.tightRegions.detectedRegionCount).toBe(
      full.tightRegions.detectedRegionCount,
    );
    expect(truncated.tightRegions.truncated).toBe(true);
    expect(truncated.warnings.map((warning) => warning.code)).toContain(
      "clearance.region-limit",
    );
  });
});

describe("checkClearance: determinism", () => {
  it("produces a deeply equal result across two independent calls", () => {
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0.3, -0.4, 2.2)),
      desiredClearanceMillimetres: 0.5,
    };
    const first = checkClearance(input);
    const second = checkClearance(input);
    expect(first).toEqual(second);
  });
});

describe("checkClearance: resource limits and validation", () => {
  it("fails closed with resource-budget-exceeded when the work budget is too small", () => {
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0, 0, 5)),
      desiredClearanceMillimetres: 1,
    };
    const result = checkClearance(input, {
      executionBudget: { maxWorkUnits: 1 },
    });
    expect(result.state).toBe("indeterminate");
    if (result.state !== "indeterminate") return;
    expect(result.code).toBe("resource-budget-exceeded");
  });

  it("rejects a non-finite or negative desired clearance", () => {
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0, 0, 5)),
      desiredClearanceMillimetres: -1,
    };
    const result = checkClearance(input);
    expect(result.state).toBe("indeterminate");
    if (result.state !== "indeterminate") return;
    expect(result.code).toBe("invalid-desired-clearance");
  });

  it("rejects an out-of-range maxTightRegions option", () => {
    const input: CheckClearanceInput = {
      first: place(boxModel("first")),
      second: place(boxModel("second"), translation(0, 0, 5)),
      desiredClearanceMillimetres: 1,
    };
    expect(() => checkClearance(input, { maxTightRegions: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      checkClearance(input, { maxInterferingTrianglePairs: 1.5 }),
    ).toThrow(RangeError);
  });

  it("advertises a sane default interfering-pair ceiling", () => {
    expect(DEFAULT_MAX_INTERFERING_TRIANGLE_PAIRS).toBeGreaterThan(0);
  });
});
