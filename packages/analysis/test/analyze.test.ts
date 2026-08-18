import { analysisResultSchema } from "@voxelspy/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_LIMITS,
  SAMPLE_SPACING_EDGE_FACTOR,
  analyzeModelPair,
  supportedAnalysisMethods,
} from "../src/index.js";
import {
  NumericRangeExceededError,
  TriangleSpatialIndex,
} from "../src/spatial-index.js";
import {
  boxModel,
  coarsePanelModel,
  disconnectedFacetModel,
  facetLocalSquareModel,
  panelWithInteriorHoleModel,
  request,
  translation,
  triangleModel,
} from "./fixtures.js";

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
    expect(first.outcome.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "added",
          geometry: expect.objectContaining({
            kind: "triangle-set",
            model: "candidate",
            triangleIndices: expect.any(Array),
          }),
        }),
        expect.objectContaining({
          category: "removed",
          geometry: expect.objectContaining({
            kind: "triangle-set",
            model: "baseline",
            triangleIndices: expect.any(Array),
          }),
        }),
      ]),
    );
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

  it("connects STL-style facet-local vertices through exact shared edges", () => {
    const result = analyzeModelPair({
      request: request("surface-distance", {
        candidateTransform: translation(0, 0, 1),
      }),
      baseline: facetLocalSquareModel("baseline"),
      candidate: facetLocalSquareModel("candidate"),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions.map(({ category }) => category)).toEqual([
      "added",
      "removed",
    ]);
    expect(
      result.outcome.metrics
        .filter(({ id }) => id.endsWith(".triangle-count"))
        .map(({ value }) => value),
    ).toEqual([2, 2]);
  });

  it("retains explicit detected and reported counts when regions truncate", () => {
    const result = analyzeModelPair({
      // A tolerance above these triangles' ~0.94mm sample-spacing bound
      // (two-thirds of their ~1.41mm longest edge) keeps this assertion
      // scoped to region-limit truncation: it is unaffected either way by
      // the ~9-39mm differences under test, but without it an
      // `analysis.surface-distance-undersampled` warning would also appear
      // below and break the exact single-warning assertion.
      request: request("surface-distance", {
        parameters: { maxRegions: 2 },
        toleranceMillimetres: 1.5,
      }),
      baseline: disconnectedFacetModel("baseline", 5),
      candidate: disconnectedFacetModel("candidate", 1),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions).toHaveLength(2);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "analysis.region-limit",
        details: { detectedRegionCount: 4, reportedRegionCount: 2 },
      }),
    ]);
    expect(
      Object.fromEntries(
        result.outcome.metrics
          .filter(({ id }) =>
            [
              "surface.changed-region-count",
              "surface.reported-region-count",
            ].includes(id),
          )
          .map(({ id, value }) => [id, value]),
      ),
    ).toEqual({
      "surface.changed-region-count": 4,
      "surface.reported-region-count": 2,
    });
    if (result.outcome.semantics === "approximate") {
      expect(result.outcome.uncertainty.parameters).toMatchObject({
        omittedRegionCount: 2,
      });
    }
  });

  it("reports a true miss honestly: a hole confined to a coarse triangle's interior is undetected but flagged undersampled", () => {
    // baseline: one large flat panel with no gap, tessellated into just two
    // huge triangles (longest edge ~141.42mm). candidate: the same
    // footprint finely gridded, with one interior 25x25mm cell entirely
    // omitted -- a genuine hole -- but that cell's four corners remain
    // referenced by neighboring cells, so the hole introduces no vertex or
    // centroid sample anywhere near its own boundary or center that isn't
    // already coincident with the (gapless) baseline plane. Every one of
    // baseline's six samples (four corners plus two triangle centroids)
    // lands outside the hole footprint, and every one of candidate's own
    // samples lands on baseline's full coverage, so both directional passes
    // report zero changed triangles even though the hole is real and far
    // larger than the requested tolerance -- exactly the false negative the
    // uncertainty bound exists to disclose.
    const tolerance = 0.001;
    const result = analyzeModelPair({
      request: request("surface-distance", { toleranceMillimetres: tolerance }),
      baseline: coarsePanelModel("baseline"),
      candidate: panelWithInteriorHoleModel("candidate"),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions).toEqual([]);
    expect(result.outcome.orderedRegionIds).toEqual([]);

    const baselineLongestEdge = Math.hypot(100, 100);
    const expectedMaxSampleSpacing =
      baselineLongestEdge * SAMPLE_SPACING_EDGE_FACTOR;
    expect(expectedMaxSampleSpacing).toBeGreaterThan(tolerance);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "analysis.surface-distance-undersampled",
          severity: "warning",
          details: expect.objectContaining({
            toleranceMillimetres: tolerance,
          }),
        }),
      ]),
    );
    const undersampledWarning = result.warnings.find(
      ({ code }) => code === "analysis.surface-distance-undersampled",
    );
    expect(undersampledWarning?.details?.maxSampleSpacingMillimetres).toBe(
      expectedMaxSampleSpacing,
    );

    if (result.outcome.semantics === "approximate") {
      expect(result.outcome.uncertainty.parameters).toMatchObject({
        undersampled: true,
        toleranceMillimetres: tolerance,
        maxSampleSpacingMillimetres: expectedMaxSampleSpacing,
      });
      expect(result.outcome.uncertainty.description).toMatch(
        /two-thirds of that triangle's longest edge/u,
      );
    }
  });

  it("does not warn or flag undersampling when the tolerance covers the sample spacing", () => {
    const baselineLongestEdge = Math.hypot(100, 100);
    const wellSampledTolerance =
      baselineLongestEdge * SAMPLE_SPACING_EDGE_FACTOR + 1;
    const result = analyzeModelPair({
      request: request("surface-distance", {
        toleranceMillimetres: wellSampledTolerance,
      }),
      baseline: coarsePanelModel("baseline"),
      candidate: panelWithInteriorHoleModel("candidate"),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(
      result.warnings.some(
        ({ code }) => code === "analysis.surface-distance-undersampled",
      ),
    ).toBe(false);
    if (result.outcome.semantics === "approximate") {
      expect(result.outcome.uncertainty.parameters).toMatchObject({
        undersampled: false,
      });
    }
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

  it("fails closed before O(vertices + triangles) preprocessing work runs on a large pair", () => {
    // A tiny box (used above) can't distinguish "the budget is checked
    // before preprocessing" from "the budget is checked before sampling":
    // both fail immediately either way. Use a model large enough that
    // flattening and the manifold edge census would be real, measurable
    // work if they ran unguarded, and assert directly on the charged-work
    // accounting -- not on timing -- that zero units were charged before
    // the budget failed. That proves no O(vertices + triangles) work ran.
    const triangleCount = 200_000;
    const result = analyzeModelPair({
      request: request("surface-distance", {
        maxWorkUnits: 1,
        maxMemoryBytes: 256 * 1024 * 1024,
      }),
      baseline: disconnectedFacetModel("baseline", triangleCount),
      candidate: disconnectedFacetModel("candidate", triangleCount),
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "resource-budget-exceeded",
    });
    if (result.outcome.state !== "indeterminate") return;
    expect(result.outcome.reasons[0]).toMatch(/after 0 charged units/u);
  });

  it("accelerates a pair that exceeds the former full-scan work estimate", () => {
    const triangleCount = 600;
    expect(triangleCount * triangleCount * 8).toBeGreaterThan(2_000_000);
    const input = {
      request: request("surface-distance", {
        candidateTransform: translation(0.5),
      }),
      baseline: disconnectedFacetModel("baseline", triangleCount),
      candidate: disconnectedFacetModel("candidate", triangleCount),
    };

    const first = analyzeModelPair(input);
    const second = analyzeModelPair(input);

    expect(first.outcome.state).toBe("complete");
    expect(second).toEqual(first);
    if (first.outcome.state !== "complete") return;
    expect(first.outcome.orderedRegionIds).toEqual(
      first.outcome.regions.map(({ id }) => id),
    );
    expect(first.outcome.orderedRegionIds.length).toBeGreaterThan(0);
  });

  it("stops accelerated search when its charged work budget is exhausted", () => {
    const triangleCount = 600;
    const result = analyzeModelPair({
      request: request("surface-distance", {
        candidateTransform: translation(0.5),
        maxWorkUnits: 30_000,
      }),
      baseline: disconnectedFacetModel("baseline", triangleCount),
      candidate: disconnectedFacetModel("candidate", triangleCount),
    });

    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "resource-budget-exceeded",
      reasons: [expect.stringMatching(/exhausted the active budget/u)],
    });
  });

  it("accepts ordinary facet-local models above the former vertex ceiling", () => {
    const result = analyzeModelPair({
      request: request("surface-distance", {
        maxWorkUnits: 1,
        maxMemoryBytes: 128 * 1024 * 1024,
      }),
      baseline: disconnectedFacetModel("baseline", 75_655),
      candidate: triangleModel("candidate"),
    });

    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "resource-budget-exceeded",
      reasons: [expect.stringMatching(/exhausted the active budget/u)],
    });
    if (result.outcome.state === "indeterminate") {
      expect(result.outcome.reasons.join(" ")).not.toMatch(/vertex/u);
    }
  });

  it("admits the documented worst-case memory combination (facet-local geometry at the vertex and triangle ceilings) under the default memory budget", () => {
    // Regression guard for the memory-estimate recalibration documented on
    // BYTES_PER_VERTEX/BYTES_PER_TRIANGLE in src/analyze.ts: a facet-local
    // pair sitting exactly at both documented expansion ceilings at once
    // (3,000,000 combined vertices, 1,000,000 combined triangles -- the
    // worst-case ratio those constants' safety margin was chosen around)
    // must still pass checkResourceBudget's memory check under the default
    // 768 MiB budget. `maxWorkUnits: 1` stops the run immediately after
    // that check (see the "after 0 charged units" pattern used by the
    // tests above), so this stays fast without running a full analysis
    // over a million triangles.
    const result = analyzeModelPair({
      request: request("surface-distance", {
        maxWorkUnits: 1,
        maxMemoryBytes: ANALYSIS_LIMITS.maxMemoryBytes,
      }),
      baseline: disconnectedFacetModel("baseline", 500_000),
      candidate: disconnectedFacetModel("candidate", 500_000),
    });

    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "resource-budget-exceeded",
    });
    if (result.outcome.state === "indeterminate") {
      expect(result.outcome.reasons[0]).toMatch(/after 0 charged units/u);
      expect(result.outcome.reasons.join(" ")).not.toMatch(
        /vertices|triangles; the implementation ceiling|Estimated analysis memory/u,
      );
    }
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

describe("surface-distance error classification", () => {
  it("distinguishes a genuine numeric-range failure from other spatial-index errors by class", () => {
    // `NumericRangeExceededError` is what `analyzeSurfaceDistance`'s catch
    // uses to decide a failure is a genuine, code-detected numeric-range
    // problem (mapped to `numeric-range-exceeded`). Any other error --
    // including the defensive "Cannot index an empty surface" guard, which
    // the public `analyzeModelPair` entry point should never itself
    // reach, since the empty-geometry precondition check already rejects
    // that case earlier -- must remain a plain `Error` so it is not
    // misattributed to numeric range and instead surfaces as
    // `internal-error`.
    const emptyGeometry = {
      positions: new Float64Array(0),
      indices: new Uint32Array(0),
      vertexCount: 0,
      triangleCount: 0,
    };
    let caught: unknown;
    try {
      new TriangleSpatialIndex(emptyGeometry, { charge: () => undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(NumericRangeExceededError);
  });

  it("maps an unexpected exception during surface-distance analysis to internal-error, not numeric-range-exceeded", () => {
    const distanceSpy = vi
      .spyOn(TriangleSpatialIndex.prototype, "distance")
      .mockImplementationOnce(() => {
        throw new Error("Simulated unexpected defect, not a range failure.");
      });
    try {
      const result = analyzeModelPair({
        request: request("surface-distance"),
        baseline: boxModel("baseline"),
        candidate: boxModel("candidate"),
      });
      expect(result.outcome).toMatchObject({
        state: "indeterminate",
        code: "internal-error",
        reasons: [expect.stringMatching(/Simulated unexpected defect/u)],
      });
    } finally {
      distanceSpy.mockRestore();
    }
  });

  it("still maps a real numeric-range failure to numeric-range-exceeded, not internal-error", () => {
    const distanceSpy = vi
      .spyOn(TriangleSpatialIndex.prototype, "distance")
      .mockImplementationOnce(() => {
        throw new NumericRangeExceededError(
          "Surface distance exceeded the supported numeric range.",
        );
      });
    try {
      const result = analyzeModelPair({
        request: request("surface-distance"),
        baseline: boxModel("baseline"),
        candidate: boxModel("candidate"),
      });
      expect(result.outcome).toMatchObject({
        state: "indeterminate",
        code: "numeric-range-exceeded",
      });
    } finally {
      distanceSpy.mockRestore();
    }
  });
});
