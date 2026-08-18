import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisResultSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type { NormalizedModel, Vec3 } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import {
  SAMPLE_SPACING_EDGE_FACTOR,
  analyzeModelPair,
  summarizeModelGeometry,
} from "../src/index.js";
import {
  boxWithInternalVoidModel,
  duplicatePerFaceVertexBoxModel,
  duplicatedFaceBoxModel,
  facetLocalBoxModel,
  facetLocalTripleJunctionModel,
  finePanelModel,
  flippedWindingBoxModel,
  ulpFragmentedFacetLocalSquareModel,
} from "./adversarial-fixtures.js";
import {
  boxModel,
  coarsePanelModel,
  facetLocalSquareModel,
  request,
  translation,
} from "./fixtures.js";
import {
  mulberry32,
  randomTriangleCloud,
  rotationZ,
  scaleTransform,
} from "./test-utils.js";

describe("adversarial: thin wall gap below tolerance", () => {
  it("pins the honest limitation: a real gap smaller than the tolerance is reported as no change, with the maximum-distance metric reflecting only reported regions, not raw proximity", () => {
    // Two coincident flat panels separated by a 0.0005mm gap along z, well
    // under the 0.01mm requested tolerance. This is not a bug: the method
    // contracts to report differences at or above the requested tolerance,
    // and a physically real sub-tolerance gap (e.g. a thin wall) is, by the
    // tolerance's own definition, indistinguishable from no gap at all.
    const gap = 0.0005;
    const tolerance = 0.01;
    const result = analyzeModelPair({
      request: request("surface-distance", {
        candidateTransform: translation(0, 0, gap),
        toleranceMillimetres: tolerance,
      }),
      baseline: coarsePanelModel("baseline"),
      candidate: coarsePanelModel("candidate"),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions).toEqual([]);
    // `surface.maximum-distance` is folded only from REPORTED regions (see
    // analyze.ts's `metrics` construction, which reduces over `ranked`).
    // With zero regions, that reduction's seed value (0) is what is
    // reported -- not the true ~0.0005mm sampled gap. A caller reading only
    // this metric, without also checking `regions.length`, could mistake
    // "0" for "measured and found to be exactly flush" rather than
    // "nothing crossed the tolerance, so nothing was measured into this
    // metric." This is the honest, if easy-to-misread, current behavior.
    expect(
      result.outcome.metrics.find(({ id }) => id === "surface.maximum-distance")
        ?.value,
    ).toBe(0);
  });
});

describe("adversarial: flipped triangle winding", () => {
  it("completes with zero regions and still validates the flipped mesh as closed and consistently oriented", () => {
    // Unsigned point-to-triangle distance does not depend on winding at
    // all, so a box compared against the identical box with every
    // triangle's winding reversed is, correctly, indistinguishable: zero
    // regions. This also documents what `consistentlyOriented` actually
    // checks: whether each edge's two incident triangles traverse it in
    // opposite directions relative to EACH OTHER (a local, per-edge
    // check) -- not whether the mesh's normals point outward by any global
    // convention. Reversing every triangle keeps every edge's relative
    // traversal direction consistent, so the flipped box still validates
    // as closed and consistently oriented: an honest report of what was
    // actually checked, not a claim about outward-normal correctness.
    const baseline = boxModel("baseline");
    const candidate = flippedWindingBoxModel("candidate");
    const result = analyzeModelPair({
      request: request("surface-distance"),
      baseline,
      candidate,
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions).toEqual([]);
    expect(result.outcome.validation).toEqual([
      expect.objectContaining({
        modelId: "baseline",
        closed: true,
        consistentlyOriented: true,
      }),
      expect.objectContaining({
        modelId: "candidate",
        closed: true,
        consistentlyOriented: true,
      }),
    ]);
  });
});

describe("adversarial: coincident surfaces", () => {
  it("reports zero regions for bit-identical candidate geometry", () => {
    const result = analyzeModelPair({
      request: request("surface-distance"),
      baseline: boxModel("baseline"),
      candidate: boxModel("candidate"),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions).toEqual([]);
  });

  it("reports zero regions against a duplicated-face variant, while honestly flagging it non-manifold in validation", () => {
    // Surface distance's own preconditions require only non-empty and
    // non-degenerate triangles (see `analyzeSurfaceDistance`'s `invalid`
    // filter); manifoldness is not gated. A candidate whose every triangle
    // is duplicated is therefore still compared, and since every duplicate
    // triangle sits exactly on top of an original one, every sampled
    // distance is still 0: zero regions. Validation evidence still
    // honestly flags the duplication as non-manifold and not closed, so a
    // caller inspecting `validation` (rather than only `regions`) is not
    // misled about the candidate's topology.
    const candidate = duplicatedFaceBoxModel("candidate");
    const result = analyzeModelPair({
      request: request("surface-distance"),
      baseline: boxModel("baseline"),
      candidate,
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions).toEqual([]);
    expect(result.outcome.validation[1]).toMatchObject({
      modelId: "candidate",
      closed: false,
      reasons: expect.arrayContaining(["non-manifold-edges"]),
    });
    expect(result.outcome.validation[1]?.nonManifoldEdgeCount).toBeGreaterThan(
      0,
    );
  });
});

describe("adversarial: facet-local (index-per-triangle) closed meshes are consistently classified", () => {
  it("keys MeshAssessment's edge census by exact vertex coordinate, so a watertight facet-local box validates as closed, matching summarizeModelGeometry", () => {
    // `assessGeometry` in analyze.ts (which produces `MeshAssessment`, the
    // `validation` evidence attached to every `AnalysisResult`) keys its
    // edge census by exact vertex COORDINATE (`pointKeyAt` /
    // `canonicalEdgeKey`), the same exact-coordinate approach used by
    // region connectivity (`exactEdgeKeyAt`, below) and by
    // `summarizeModelGeometry` in summary.ts (`pointKey`). Two triangle
    // corners connect if and only if their coordinates are bit-for-bit
    // identical -- no tolerance welding -- and index-level topology
    // (whether two triangles happen to share a vertex INDEX) is not what
    // either validator reports.
    //
    // A fully facet-local box -- 36 vertices (one private copy of every
    // triangle corner), 12 triangles, no two triangles sharing any vertex
    // index at all, the representation many importers (e.g. binary STL)
    // naturally produce -- is therefore recognized as watertight by BOTH
    // validators: `summarizeModelGeometry` (directly exercised by
    // "recognizes exact shared edges in facet-local closed geometry" in
    // summary.test.ts, which reports `volume.available: true` for exactly
    // this shape) and `assessGeometry`'s `MeshAssessment`, checked here. A
    // caller who checks only one of the two now draws the same conclusion
    // as one who checks the other.
    const facetLocalBox = facetLocalBoxModel("facet-local-box");
    const result = analyzeModelPair({
      request: request("surface-distance", { candidateId: "facet-local-box" }),
      baseline: boxModel("baseline"),
      candidate: facetLocalBox,
    });
    expect(result.outcome.validation[1]).toMatchObject({
      modelId: "facet-local-box",
      closed: true,
      consistentlyOriented: true,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
    });

    const summary = summarizeModelGeometry(facetLocalBox);
    expect(summary.volume).toMatchObject({
      available: true,
      topology: {
        boundaryEdgeCount: 0,
        nonManifoldEdgeCount: 0,
        inconsistentEdgeCount: 0,
      },
    });
  });
});

describe("adversarial: coordinate keying changes what counts as non-manifold", () => {
  it("flags a three-facet coordinate junction as non-manifold, which raw-index keying could never detect across facet-local copies", () => {
    // Coordinate keying doesn't only fix false negatives (facet-local
    // closed meshes reported open, above) -- it changes what non-manifold
    // detection can even see. Under the old raw-INDEX keying, two facets
    // could only be seen sharing an edge if they happened to reuse the
    // same vertex INDEX; three fully facet-local triangles (private vertex
    // copies, no index ever shared) meeting along one real coordinate edge
    // would each contribute a lone, unmatched "boundary" half-edge --
    // three separate boundary edges, zero non-manifold edges, an honestly
    // wrong read of a genuine three-facet junction. Under exact-coordinate
    // keying, the three facet-local copies of that shared edge collapse
    // into one edge entry with three incident triangles: a real
    // non-manifold edge, correctly detected for the first time. The
    // junction's six other edges (each triangle's two non-shared sides)
    // remain unique per triangle and still report as ordinary boundary
    // edges.
    const triple = facetLocalTripleJunctionModel("triple-junction");
    const result = analyzeModelPair({
      request: request("surface-distance", {
        candidateId: "triple-junction",
      }),
      baseline: boxModel("baseline"),
      candidate: triple,
    });
    expect(result.outcome.validation[1]).toMatchObject({
      modelId: "triple-junction",
      closed: false,
      nonManifoldEdgeCount: 1,
      boundaryEdgeCount: 6,
      reasons: expect.arrayContaining(["non-manifold-edges", "boundary-edges"]),
    });
  });
});

describe("adversarial: one-ULP vertex perturbation fragments exact-edge connectivity", () => {
  it("splits a geometrically-connected two-triangle change into two single-triangle regions on the perturbed side only", () => {
    // Region connectivity groups CHANGED triangles within one mesh via
    // `exactEdgeKeyAt`, which keys an edge by the exact (bit-for-bit)
    // string form of its two endpoint coordinates -- see analyze.ts. A
    // facet-local mesh (duplicate per-triangle vertex copies, as real
    // importers commonly emit) relies on those copies being bit-identical
    // at shared edges to be recognized as connected at all. Nudging just
    // one shared-vertex copy by a single ULP is geometrically
    // indistinguishable (many orders of magnitude below any sane
    // tolerance) but breaks the exact string match, so the two triangles
    // -- both still individually flagged "changed" by the (unaffected)
    // tolerance comparison -- are reported as two separate single-triangle
    // regions instead of one two-triangle region. This is a real,
    // documented limitation of exact-edge connectivity, not a
    // distance-accuracy defect: every individual triangle's reported
    // distance is still correct, only the grouping fragments.
    const translationAmount: [number, number, number] = [5, 0, 0];
    const baseline = facetLocalSquareModel("baseline");
    const candidate = ulpFragmentedFacetLocalSquareModel(
      "candidate",
      translationAmount,
    );
    const result = analyzeModelPair({
      request: request("surface-distance"),
      baseline,
      candidate,
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    const added = result.outcome.regions.filter(
      ({ category }) => category === "added",
    );
    const removed = result.outcome.regions.filter(
      ({ category }) => category === "removed",
    );
    // Baseline is untouched: its two triangles still connect into one
    // region through their own bit-identical facet-local copies.
    expect(removed).toHaveLength(1);
    expect(removed[0]?.geometry?.triangleIndices).toHaveLength(2);
    // Candidate's shared edge no longer bit-matches: fragmented into two
    // single-triangle regions.
    expect(added).toHaveLength(2);
    for (const region of added) {
      expect(region.geometry?.triangleIndices).toHaveLength(1);
    }
  });
});

describe("adversarial: internal void (closed box inside a closed box)", () => {
  it("reports the interior void's surface as pure added material under unsigned distance, not a subtracted volume", () => {
    // Surface distance has no boolean/solid semantics: it measures nearest
    // -surface distance only. A candidate that adds a second, fully
    // interior closed box (an internal void/cavity boundary) is therefore
    // reported as one "added" region covering exactly the inner box's
    // surface -- never as "removed" material, never as a void, and with no
    // signal at all that it is topologically enclosed. This is the honest,
    // documented behavior of an unsigned nearest-surface method: it cannot
    // distinguish "a cavity was cut into the solid" from "a disconnected
    // shell was placed inside it," because both add surface area with no
    // nearby baseline counterpart.
    const baseline = boxModel("baseline", [20, 20, 20]);
    const candidate = boxWithInternalVoidModel("candidate");
    const result = analyzeModelPair({
      request: request("surface-distance", { toleranceMillimetres: 0.01 }),
      baseline,
      candidate,
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    const removed = result.outcome.regions.filter(
      ({ category }) => category === "removed",
    );
    const added = result.outcome.regions.filter(
      ({ category }) => category === "added",
    );
    expect(removed).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]?.geometry?.triangleIndices).toHaveLength(12);
    // The outer box's 12 triangles are flattened first (see
    // `boxWithInternalVoidModel`'s instance order), so the surviving added
    // region -- referencing only the inner box -- indexes exclusively into
    // the trailing 12 triangles of the flattened candidate geometry.
    expect(
      added[0]?.geometry?.triangleIndices.every((index) => index >= 12),
    ).toBe(true);
  });
});

describe("adversarial: mixed tessellation of an identical flat surface", () => {
  it("reports zero regions but still flags sample-spacing uncertainty rather than a proven-equality claim", () => {
    // Both panels cover the exact same flat 100x100mm footprint (the
    // coarse two-triangle panel and its 32-triangle re-tessellation), so
    // every vertex and centroid sample on either side lands exactly on the
    // other's surface: zero regions is the geometrically correct result,
    // not an artifact. But the reported uncertainty is driven purely by
    // the coarsest analyzed triangle's edge length (baseline's ~141.42mm
    // hypotenuse), independent of whether any deviation was actually
    // found -- so the tool still raises
    // `analysis.surface-distance-undersampled` even though the two
    // surfaces genuinely match. "No regions found" is never silently
    // promoted to "proven identical" when the sample-spacing bound cannot
    // back that claim.
    const tolerance = 0.001;
    const result = analyzeModelPair({
      request: request("surface-distance", {
        toleranceMillimetres: tolerance,
      }),
      baseline: coarsePanelModel("baseline"),
      candidate: finePanelModel("candidate", 4),
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(result.outcome.regions).toEqual([]);

    const baselineLongestEdge = Math.hypot(100, 100);
    const expectedMaxSampleSpacing =
      baselineLongestEdge * SAMPLE_SPACING_EDGE_FACTOR;
    const undersampledWarning = result.warnings.find(
      ({ code }) => code === "analysis.surface-distance-undersampled",
    );
    expect(undersampledWarning).toBeDefined();
    expect(undersampledWarning?.details?.maxSampleSpacingMillimetres).toBe(
      expectedMaxSampleSpacing,
    );
    if (result.outcome.semantics === "approximate") {
      expect(result.outcome.uncertainty.parameters).toMatchObject({
        undersampled: true,
      });
    }
  });
});

describe("adversarial: exact axis-aligned-box adapter preconditions", () => {
  it("rejects a rotated box as indeterminate rather than approximating a bounding box", () => {
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate", [2, 2, 2], {
      meshToModel: rotationZ(Math.PI / 4),
    });
    const result = analyzeModelPair({
      request: request("axis-aligned-box-solid"),
      baseline,
      candidate,
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "solid-precondition-failed",
    });
  });

  it("rejects a duplicate-per-face-vertex box for its vertex/triangle count alone, even though coordinate-keyed validation now sees it as closed", () => {
    // The exact adapter's precondition check requires exactly 8 vertices
    // and 12 triangles (see `validatedAxisAlignedBox`) -- it validates the
    // indexed REPRESENTATION, not just the resulting shape. A box
    // re-tessellated with 4 duplicated vertices per face (24 vertices
    // total) is geometrically an identical, closed, consistently oriented
    // axis-aligned box, but is honestly rejected rather than silently
    // welded or reinterpreted into the canonical form.
    //
    // `assessGeometry`'s edge census (analyze.ts) now keys edges by exact
    // vertex COORDINATE, not by raw index -- see the dedicated
    // "facet-local closed meshes are consistently classified" test above.
    // This fixture gives each face its own private vertex block, so no two
    // faces share a vertex INDEX, but every one of the 12 true cube edges
    // where two faces meet is coordinate-identical on both sides. Under
    // coordinate keying those matching half-edges merge back into 12
    // correctly paired edges, so `MeshAssessment.closed` now comes back
    // `true`: the adapter's rejection here is driven purely by the
    // vertex/triangle-count precondition (24 vertices, not 8), not by a
    // false "not closed" report -- unlike before this change, when the two
    // reasons compounded.
    const baseline = boxModel("baseline");
    const candidate = duplicatePerFaceVertexBoxModel("candidate");
    const result = analyzeModelPair({
      request: request("axis-aligned-box-solid"),
      baseline,
      candidate,
    });
    expect(result.outcome).toMatchObject({
      state: "indeterminate",
      code: "solid-precondition-failed",
    });
    expect(result.outcome.validation[1]).toMatchObject({
      closed: true,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      consistentlyOriented: true,
      degenerateTriangleCount: 0,
    });
  });

  it("accepts a uniformly scaled box instance transform and reports its correct exact volume", () => {
    // `meshToModel` (an assembly-level instance transform) accepts a
    // general invertible affine transform, including scale -- unlike the
    // request-level `modelToComparison` binding, which the contract
    // restricts to a proper rigid transform only (see `rigidTransformSchema`
    // in packages/contracts/src/primitives.ts). A unit box scaled 2x via
    // its instance transform still resolves to a valid axis-aligned box
    // with 8 corners, so the exact adapter accepts it and reports the
    // correctly scaled volume rather than rejecting it the way a rotation
    // is rejected.
    const baseline = boxModel("baseline", [2, 2, 2]);
    const candidate = boxModel("candidate", [1, 1, 1], {
      meshToModel: scaleTransform(2, 2, 2),
    });
    const result = analyzeModelPair({
      request: request("axis-aligned-box-solid"),
      baseline,
      candidate,
    });
    expect(result.outcome.state).toBe("complete");
    if (result.outcome.state !== "complete") return;
    expect(
      result.outcome.metrics.find(({ id }) => id === "solid.candidate-volume")
        ?.value,
    ).toBe(8);
    expect(
      result.outcome.metrics.find(
        ({ id }) => id === "solid.symmetric-difference-volume",
      )?.value,
    ).toBe(0);
  });
});

describe("determinism sweep", () => {
  it("produces byte-identical serialized results across two independent runs of a moderately complex seeded comparison", () => {
    // A sizeable, irregular seeded triangle soup (not axis-aligned, not
    // index-shared) so the run exercises real spatial-index construction,
    // sampling, and region connectivity rather than a trivial case.
    const baselineTriangles = randomTriangleCloud(mulberry32(9001), 400, 40);
    const candidateTriangles = randomTriangleCloud(
      mulberry32(9002),
      400,
      40,
    ).map(
      ([a, b, c]) =>
        [
          [a[0] + 3, a[1], a[2]],
          [b[0] + 3, b[1], b[2]],
          [c[0] + 3, c[1], c[2]],
        ] as [Vec3, Vec3, Vec3],
    );
    const baseline = triangleSoupModel("baseline", baselineTriangles);
    const candidate = triangleSoupModel("candidate", candidateTriangles);
    const input = {
      request: request("surface-distance", {
        maxWorkUnits: 50_000_000,
        maxMemoryBytes: 256 * 1024 * 1024,
      }),
      baseline,
      candidate,
    };

    const first = analyzeModelPair(input);
    const second = analyzeModelPair(input);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(() => analysisResultSchema.parse(first)).not.toThrow();
  });
});

function triangleSoupModel(
  id: string,
  triangles: readonly (readonly [Vec3, Vec3, Vec3])[],
): NormalizedModel {
  const positions = new Float64Array(triangles.length * 9);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, index) => {
    triangle.forEach((vertex, corner) => {
      positions.set(vertex, (index * 3 + corner) * 3);
    });
    indices[index * 3] = index * 3;
    indices[index * 3 + 1] = index * 3 + 1;
    indices[index * 3 + 2] = index * 3 + 2;
  });
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [{ id: `${id}.mesh`, geometry: { positions, indices } }],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `${id}.instance`,
          meshId: `${id}.mesh`,
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "analysis-adversarial-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: ["Seeded random triangle soup for determinism testing."],
    },
  });
}
