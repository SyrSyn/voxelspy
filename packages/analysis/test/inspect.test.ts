import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type { NormalizedModel } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";

import { InspectionResourceLimitError, inspectModel } from "../src/index.js";
import {
  boxWithInternalVoidModel,
  facetLocalBoxModel,
  facetLocalTripleJunctionModel,
} from "./adversarial-fixtures.js";
import { boxModel, disconnectedFacetModel, triangleModel } from "./fixtures.js";

describe("inspectModel", () => {
  it("reports a watertight indexed box as closed with no topology findings", () => {
    const model = boxModel("indexed-box", [2, 3, 4]);
    const result = inspectModel(model);

    expect(result.modelId).toBe("indexed-box");
    expect(result.frame).toEqual(CANONICAL_FRAME);
    expect(result.provenance).toEqual(model.provenance);
    expect(result.watertightness).toEqual({ state: "closed" });
    expect(result.topologyFindings).toEqual([]);
    expect(result.summary.volume).toMatchObject({ available: true });
    expect(result.meshBreakdown).toEqual({
      meshes: [
        {
          meshId: "indexed-box.mesh",
          triangleCount: 12,
          vertexCount: 8,
        },
      ],
      truncated: false,
      totalMeshCount: 1,
    });
  });

  it("recognizes a facet-local (STL-style) box as closed via exact-coordinate keying", () => {
    // The package's topology keys edges by exact vertex COORDINATE, never
    // by raw vertex index (see README "Topology semantics"). A facet-local
    // mesh -- one private vertex copy per triangle corner, the shape binary
    // STL import commonly produces -- shares no vertex INDEX between
    // triangles, yet is still recognized as closed because its duplicated
    // corners coincide exactly.
    const model = facetLocalBoxModel("facet-local-box", [2, 2, 2]);
    const result = inspectModel(model);

    expect(result.summary.vertexCount).toBe(36);
    expect(result.summary.triangleCount).toBe(12);
    expect(result.watertightness).toEqual({ state: "closed" });
    expect(result.topologyFindings).toEqual([]);
  });

  it("reports boundary edges on an open surface as an info finding and a not-closed verdict", () => {
    const model = boxModel("open-box", [2, 2, 2], { open: true });
    const result = inspectModel(model);

    expect(result.watertightness).toEqual({
      state: "not-closed",
      reasons: ["boundary-edges"],
    });
    expect(result.topologyFindings).toHaveLength(1);
    const finding = result.topologyFindings[0]!;
    expect(finding).toMatchObject({
      id: "boundary-edges",
      kind: "boundary-edges",
      severity: "info",
      count: 4,
      examplesTruncated: false,
    });
    expect(finding.examples).toHaveLength(4);
    for (const example of finding.examples) {
      expect(example.positionMillimetres).toHaveLength(3);
      expect(example.triangleIndices.length).toBeGreaterThan(0);
    }
  });

  it("reports non-manifold and boundary findings together for a triple junction, with a not-closed verdict naming both", () => {
    const model = facetLocalTripleJunctionModel("triple-junction");
    const result = inspectModel(model);

    expect(result.watertightness).toEqual({
      state: "not-closed",
      reasons: ["boundary-edges", "non-manifold-edges"],
    });
    const kinds = result.topologyFindings.map((finding) => finding.kind);
    // Deterministic, fixed kind order regardless of which count is larger.
    expect(kinds).toEqual(["boundary-edges", "non-manifold-edges"]);

    const boundary = result.topologyFindings.find(
      (finding) => finding.kind === "boundary-edges",
    )!;
    expect(boundary).toMatchObject({ severity: "info", count: 6 });

    const nonManifold = result.topologyFindings.find(
      (finding) => finding.kind === "non-manifold-edges",
    )!;
    expect(nonManifold).toMatchObject({ severity: "warning", count: 1 });
    expect(nonManifold.examples).toHaveLength(1);
    // The one non-manifold edge is shared by all three triangles.
    expect(nonManifold.examples[0]!.triangleIndices.slice().sort()).toEqual([
      0, 1, 2,
    ]);
  });

  it("reports degenerate triangles as a warning finding with a centroid example", () => {
    const model = triangleModel("degenerate");
    // Collapse vertex 1 onto vertex 0, matching how analyze.test.ts builds
    // its degenerate fixture: zero area, still finite coordinates.
    model.meshes[0]!.geometry.positions[3] = 0;
    model.meshes[0]!.geometry.positions[4] = 0;

    const result = inspectModel(model);
    const finding = result.topologyFindings.find(
      (candidate) => candidate.kind === "degenerate-triangles",
    );
    expect(finding).toMatchObject({
      severity: "warning",
      count: 1,
      examplesTruncated: false,
    });
    expect(finding!.examples).toHaveLength(1);
    expect(finding!.examples[0]!.triangleIndices).toEqual([0]);
    expect(finding!.examples[0]!.positionMillimetres).toHaveLength(3);
  });

  it("rejects empty geometry via contract-schema validation", () => {
    // The contracts mesh-buffer schema requires positions and indices to
    // each own a nonzero-byte-length transferable buffer, so a truly empty
    // (zero-triangle) mesh cannot pass `normalizedModelSchema.parse` --
    // `inspectModel` calls that validation before anything else, so this
    // fails closed as a schema rejection rather than reaching topology
    // logic at all. `WatertightnessVerdict`'s `indeterminate` state (see
    // src/inspect.ts) documents the "empty-geometry" reason defensively,
    // consistent with `ModelPresentationSummary`'s existing
    // `VolumeUnavailableReason`, even though schema validation already
    // rules the case out for any input that reaches this far.
    // Built as a plain object rather than through `normalizedModelSchema.parse`
    // -- the schema rejection under test is `inspectModel`'s own validation
    // call, so this fixture must reach `inspectModel` unvalidated.
    const model = {
      contractVersion: 1,
      id: "empty",
      frame: CANONICAL_FRAME,
      meshes: [
        {
          id: "empty.mesh",
          geometry: {
            positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            indices: new Uint32Array([]),
          },
        },
      ],
      placement: {
        kind: "flat",
        instances: [
          {
            id: "empty.instance",
            meshId: "empty.mesh",
            meshToModel: IDENTITY_MAT4,
          },
        ],
      },
      warnings: [],
      provenance: {
        formatId: "generated-fixture",
        importerId: "inspect-test-fixture",
        importerVersion: "1.0.0",
        sourceName: "empty.generated",
        detectedSourceUnit: "millimetre",
        detectedSourceAxis: "right-handed-z-up",
        sourceUnit: "millimetre",
        sourceAxis: "right-handed-z-up",
        sourceResolution: { unit: "embedded", axis: "embedded" },
        appliedSourceToModel: IDENTITY_MAT4,
        notes: ["Vertices present, but zero triangles."],
      },
    } as unknown as NormalizedModel;

    expect(() => inspectModel(model)).toThrow(/indices/u);
  });

  it("reports a per-mesh breakdown for a multi-mesh, multi-instance model", () => {
    const model = boxWithInternalVoidModel(
      "with-void",
      [20, 20, 20],
      [6, 6, 6],
      [7, 7, 7],
    );
    const result = inspectModel(model);

    expect(result.summary.meshCount).toBe(2);
    expect(result.summary.instanceCount).toBe(2);
    expect(result.meshBreakdown).toEqual({
      meshes: [
        { meshId: "with-void.outer", triangleCount: 12, vertexCount: 8 },
        { meshId: "with-void.inner", triangleCount: 12, vertexCount: 8 },
      ],
      truncated: false,
      totalMeshCount: 2,
    });
    // Two disjoint closed shells: still topologically closed overall, since
    // watertightness only depends on boundary/non-manifold edge counts, not
    // on being a single connected component.
    expect(result.summary.componentCount).toBe(2);
    expect(result.watertightness).toEqual({ state: "closed" });
  });

  it("truncates topology examples deterministically and records truncation", () => {
    // Five fully disconnected triangles: every one of their 15 edges is its
    // own boundary edge (no sharing), so boundaryEdgeCount = 15.
    const model = disconnectedFacetModel("disconnected", 5);

    const result = inspectModel(model, { maxTopologyExamples: 3 });
    const finding = result.topologyFindings.find(
      (candidate) => candidate.kind === "boundary-edges",
    )!;
    expect(finding.count).toBe(15);
    expect(finding.examples).toHaveLength(3);
    expect(finding.examplesTruncated).toBe(true);

    // Requesting zero examples still reports the full count.
    const noExamples = inspectModel(model, { maxTopologyExamples: 0 });
    const noExamplesFinding = noExamples.topologyFindings.find(
      (candidate) => candidate.kind === "boundary-edges",
    )!;
    expect(noExamplesFinding.count).toBe(15);
    expect(noExamplesFinding.examples).toEqual([]);
    expect(noExamplesFinding.examplesTruncated).toBe(true);
  });

  it("truncates the mesh breakdown deterministically and records truncation", () => {
    const model = boxWithInternalVoidModel("with-void-truncated");
    const result = inspectModel(model, { maxMeshBreakdownEntries: 1 });

    expect(result.meshBreakdown.meshes).toHaveLength(1);
    expect(result.meshBreakdown.meshes[0]!.meshId).toBe(
      "with-void-truncated.outer",
    );
    expect(result.meshBreakdown.truncated).toBe(true);
    expect(result.meshBreakdown.totalMeshCount).toBe(2);
  });

  it("is deterministic: identical input produces a deeply equal result", () => {
    const model = facetLocalTripleJunctionModel("determinism");
    const first = inspectModel(model);
    const second = inspectModel(model);
    expect(first).toEqual(second);

    // A structurally identical, separately constructed model produces the
    // same result too -- determinism does not depend on object identity.
    const rebuilt = facetLocalTripleJunctionModel("determinism");
    expect(inspectModel(rebuilt)).toEqual(first);
  });

  it("rejects invalid option bounds instead of silently clamping them", () => {
    const model = boxModel("bounds", [1, 1, 1]);
    expect(() => inspectModel(model, { maxTopologyExamples: -1 })).toThrow(
      RangeError,
    );
    expect(() => inspectModel(model, { maxTopologyExamples: 51 })).toThrow(
      RangeError,
    );
    expect(() => inspectModel(model, { maxMeshBreakdownEntries: 1.5 })).toThrow(
      RangeError,
    );
  });

  it("fails closed with a typed resource-limit error on hostile triangle counts, before any topology work runs", () => {
    // A mesh with just 3 vertices but an indices array cycling those same
    // three vertex indices far past the documented triangle ceiling --
    // cheap to construct (a small typed array), but a hostile input this
    // package must reject before doing any O(triangles) topology work.
    const triangleCount = 1_000_001;
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array(triangleCount * 3);
    for (let index = 0; index < indices.length; index += 1) {
      indices[index] = index % 3;
    }
    const model = normalizedModelSchema.parse({
      contractVersion: 1,
      id: "hostile",
      frame: CANONICAL_FRAME,
      meshes: [{ id: "hostile.mesh", geometry: { positions, indices } }],
      placement: {
        kind: "flat",
        instances: [
          {
            id: "hostile.instance",
            meshId: "hostile.mesh",
            meshToModel: IDENTITY_MAT4,
          },
        ],
      },
      warnings: [],
      provenance: {
        formatId: "generated-fixture",
        importerId: "inspect-test-fixture",
        importerVersion: "1.0.0",
        sourceName: "hostile.generated",
        detectedSourceUnit: "millimetre",
        detectedSourceAxis: "right-handed-z-up",
        sourceUnit: "millimetre",
        sourceAxis: "right-handed-z-up",
        sourceResolution: { unit: "embedded", axis: "embedded" },
        appliedSourceToModel: IDENTITY_MAT4,
        notes: ["One triangle definition repeated past the triangle ceiling."],
      },
    });

    expect(() => inspectModel(model)).toThrow(InspectionResourceLimitError);
    expect(() => inspectModel(model)).toThrow(/1000001 triangles/u);
  });

  it("rejects a model that fails contract-schema validation", () => {
    const invalid = { not: "a model" };
    expect(() => inspectModel(invalid as unknown as NormalizedModel)).toThrow();
  });
});
