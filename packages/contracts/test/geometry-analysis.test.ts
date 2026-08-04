import { describe, expect, it } from "vitest";
import {
  analysisExchangeSchema,
  analysisRequestSchema,
  analysisResultSchema,
} from "../src/analysis.js";
import { normalizedModelSchema } from "../src/geometry.js";
import {
  importExchangeSchema,
  importRequestSchema,
  importResultSchema,
} from "../src/import.js";
import { CANONICAL_FRAME, IDENTITY_MAT4 } from "../src/primitives.js";

const digest = { algorithm: "sha256" as const, value: "a".repeat(64) };
const limits = {
  inputBytes: 1_024,
  triangleCount: 100,
  archive: {
    entryCount: 10,
    entryBytes: 1_024,
    expandedBytes: 2_048,
    compressionRatio: 20,
  },
};

function triangle() {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: "model.baseline",
    frame: CANONICAL_FRAME,
    meshes: [{ id: "mesh.body", geometry: triangle() }],
    placement: {
      kind: "flat",
      instances: [
        {
          id: "instance.body",
          meshId: "mesh.body",
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "stl",
      importerId: "stl.reference",
      importerVersion: "1.0.0",
      sourceName: "generated.stl",
      sourceDigest: digest,
      detectedSourceUnit: "unknown",
      detectedSourceAxis: "unknown",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "declared", axis: "declared" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [],
    },
    ...overrides,
  };
}

describe("geometry and import contracts", () => {
  it("accepts full-span transferable buffers and keeps placement authoritative", () => {
    const parsed = normalizedModelSchema.parse(model());
    expect(parsed.meshes[0]?.geometry.positions.byteOffset).toBe(0);
    expect(parsed.provenance.appliedSourceToModel).toEqual(IDENTITY_MAT4);
    expect(parsed.placement.kind).toBe("flat");
  });

  it("rejects offset, shared, malformed, and misindexed buffers", () => {
    const offsetStorage = new ArrayBuffer(80);
    const offsetPositions = new Float64Array(offsetStorage, 8, 9);
    offsetPositions.set(triangle().positions);
    expect(() =>
      normalizedModelSchema.parse(
        model({
          meshes: [
            {
              id: "mesh.body",
              geometry: {
                positions: offsetPositions,
                indices: new Uint32Array([0, 1, 2]),
              },
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          provenance: {
            ...model().provenance,
            sourceResolution: { unit: "embedded", axis: "declared" },
          },
        }),
      ),
    ).toThrow();
    if (typeof SharedArrayBuffer !== "undefined") {
      expect(() =>
        normalizedModelSchema.parse(
          model({
            meshes: [
              {
                id: "mesh.body",
                geometry: {
                  positions: new Float64Array(new SharedArrayBuffer(72)),
                  indices: new Uint32Array([0, 1, 2]),
                },
              },
            ],
          }),
        ),
      ).toThrow();
    }
    const reusedBuffer = new ArrayBuffer(72);
    expect(() =>
      normalizedModelSchema.parse(
        model({
          meshes: [
            {
              id: "mesh.body",
              geometry: {
                positions: new Float64Array(reusedBuffer),
                indices: new Uint32Array(reusedBuffer),
              },
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          meshes: [
            {
              id: "mesh.body",
              geometry: {
                positions: new Float64Array([0, 0]),
                indices: new Uint32Array([0, 1, 2]),
              },
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          meshes: [
            {
              id: "mesh.body",
              geometry: {
                positions: new Float64Array([
                  0,
                  0,
                  Number.NaN,
                  1,
                  0,
                  0,
                  0,
                  1,
                  0,
                ]),
                indices: new Uint32Array([0, 1, 2]),
              },
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          meshes: [
            {
              id: "mesh.body",
              geometry: { ...triangle(), indices: new Uint32Array([0, 1, 3]) },
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("requires resolved source frames and category-safe references", () => {
    expect(() =>
      normalizedModelSchema.parse(
        model({ provenance: { ...model().provenance, sourceUnit: "unknown" } }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          provenance: {
            ...model().provenance,
            sourceUnit: "inch",
            appliedSourceToModel: IDENTITY_MAT4,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          placement: {
            kind: "flat",
            instances: [
              {
                id: "mesh.body",
                meshId: "mesh.body",
                meshToModel: IDENTITY_MAT4,
              },
            ],
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          placement: {
            kind: "flat",
            instances: [
              {
                id: "instance.body",
                meshId: "mesh.missing",
                meshToModel: IDENTITY_MAT4,
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it("enforces one rooted tree and one attachment per hierarchical instance", () => {
    const hierarchy = {
      kind: "hierarchy",
      instances: [
        { id: "instance.body", meshId: "mesh.body", meshToNode: IDENTITY_MAT4 },
      ],
      rootIds: ["node.root"],
      nodes: [
        {
          id: "node.root",
          childIds: ["node.child"],
          instanceIds: [],
          localToParent: IDENTITY_MAT4,
        },
        {
          id: "node.child",
          childIds: [],
          instanceIds: ["instance.body"],
          localToParent: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1],
        },
      ],
    };
    expect(
      normalizedModelSchema.parse(model({ placement: hierarchy })),
    ).toBeTruthy();
    const childTransform = hierarchy.nodes[1]!.localToParent;
    expect([
      childTransform[0]! * 1 +
        childTransform[4]! * 2 +
        childTransform[8]! * 3 +
        childTransform[12]!,
      childTransform[1]! * 1 +
        childTransform[5]! * 2 +
        childTransform[9]! * 3 +
        childTransform[13]!,
      childTransform[2]! * 1 +
        childTransform[6]! * 2 +
        childTransform[10]! * 3 +
        childTransform[14]!,
    ]).toEqual([11, 22, 33]);
    expect(() =>
      normalizedModelSchema.parse(
        model({
          placement: { ...hierarchy, rootIds: ["node.root", "node.root"] },
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          placement: {
            ...hierarchy,
            nodes: hierarchy.nodes.map((node) => ({
              ...node,
              instanceIds: ["instance.body"],
            })),
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      normalizedModelSchema.parse(
        model({
          placement: {
            ...hierarchy,
            nodes: [
              { ...hierarchy.nodes[0], childIds: ["node.child", "node.child"] },
              hierarchy.nodes[1],
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it("validates deep hierarchies without recursive stack growth", () => {
    const depth = 20_000;
    const nodes = Array.from({ length: depth }, (_, index) => ({
      id: `node.${index}`,
      childIds: index + 1 < depth ? [`node.${index + 1}`] : [],
      instanceIds: index + 1 === depth ? ["instance.body"] : [],
      localToParent: IDENTITY_MAT4,
    }));
    expect(() =>
      normalizedModelSchema.safeParse(
        model({
          placement: {
            kind: "hierarchy",
            instances: [
              {
                id: "instance.body",
                meshId: "mesh.body",
                meshToNode: IDENTITY_MAT4,
              },
            ],
            rootIds: ["node.0"],
            nodes,
          },
        }),
      ),
    ).not.toThrow();
    expect(
      normalizedModelSchema.safeParse(
        model({
          placement: {
            kind: "hierarchy",
            instances: [
              {
                id: "instance.body",
                meshId: "mesh.body",
                meshToNode: IDENTITY_MAT4,
              },
            ],
            rootIds: ["node.0"],
            nodes,
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("bounds import bytes, rejects unknown versions/keys, and keeps lifecycle failures separate", () => {
    const request = {
      contractVersion: 1,
      targetModelId: "model.baseline",
      format: "stl",
      sourceName: "generated.stl",
      bytes: new Uint8Array([1, 2, 3]),
      options: {
        declaredUnit: "millimetre",
        declaredAxis: "right-handed-z-up",
        limits,
      },
    };
    expect(importRequestSchema.parse(request)).toBeTruthy();
    expect(() =>
      importRequestSchema.parse({ ...request, contractVersion: 2 }),
    ).toThrow();
    expect(() =>
      importRequestSchema.parse({ ...request, extra: true }),
    ).toThrow();
    expect(() =>
      importRequestSchema.parse({
        ...request,
        options: { ...request.options, declaredUnit: "unknown" },
      }),
    ).toThrow();
    expect(() =>
      importRequestSchema.parse({
        ...request,
        options: {
          ...request.options,
          userUnit: "millimetre",
        },
      }),
    ).toThrow();
    expect(() =>
      importRequestSchema.parse({
        ...request,
        bytes: new Uint8Array(new ArrayBuffer(8), 1, 3),
      }),
    ).toThrow();
    expect(() =>
      importRequestSchema.parse({
        ...request,
        options: { ...request.options, limits: { ...limits, inputBytes: 2 } },
      }),
    ).toThrow();
    expect(
      importResultSchema.parse({
        contractVersion: 1,
        ok: false,
        code: "needs-input",
        message: "Source unit is unresolved",
        warnings: [],
      }),
    ).toBeTruthy();
    expect(() =>
      importResultSchema.parse({
        contractVersion: 1,
        ok: false,
        code: "cancelled",
        message: "Cancelled",
        warnings: [],
      }),
    ).toThrow();
    const success = importResultSchema.parse({
      contractVersion: 1,
      ok: true,
      model: model(),
    });
    expect(
      importExchangeSchema.parse({ request, result: success }),
    ).toBeTruthy();
    expect(() =>
      importExchangeSchema.parse({
        request: { ...request, targetModelId: "model.other" },
        result: success,
      }),
    ).toThrow();
    expect(
      importExchangeSchema.parse({
        request: {
          ...request,
          options: {
            ...request.options,
            declaredUnit: undefined,
            declaredAxis: undefined,
            userUnit: "millimetre",
            userAxis: "right-handed-z-up",
          },
        },
        result: {
          contractVersion: 1,
          ok: true,
          model: model({
            provenance: {
              ...model().provenance,
              sourceResolution: { unit: "user", axis: "user" },
            },
          }),
        },
      }),
    ).toBeTruthy();
    expect(() =>
      importExchangeSchema.parse({
        request: {
          ...request,
          options: {
            ...request.options,
            declaredUnit: undefined,
            declaredAxis: undefined,
            userUnit: "inch",
            userAxis: "right-handed-y-up",
          },
        },
        result: {
          contractVersion: 1,
          ok: true,
          model: model({
            provenance: {
              ...model().provenance,
              detectedSourceUnit: "millimetre",
              detectedSourceAxis: "right-handed-z-up",
              sourceResolution: { unit: "embedded", axis: "embedded" },
            },
          }),
        },
      }),
    ).toThrow();
    expect(
      importExchangeSchema.parse({
        request: {
          ...request,
          options: {
            limits,
          },
        },
        result: {
          contractVersion: 1,
          ok: true,
          model: model({
            provenance: {
              ...model().provenance,
              detectedSourceUnit: "millimetre",
              detectedSourceAxis: "right-handed-z-up",
              sourceResolution: { unit: "embedded", axis: "embedded" },
            },
          }),
        },
      }),
    ).toBeTruthy();
    expect(() =>
      importExchangeSchema.parse({
        request: { ...request, sourceName: "renamed.stl" },
        result: success,
      }),
    ).toThrow();
    expect(() =>
      importExchangeSchema.parse({
        request: {
          ...request,
          options: { ...request.options, declaredUnit: "inch" },
        },
        result: success,
      }),
    ).toThrow();
    expect(() =>
      importExchangeSchema.parse({
        request: {
          ...request,
          options: {
            ...request.options,
            limits: { ...limits, triangleCount: 1 },
          },
        },
        result: {
          contractVersion: 1,
          ok: true,
          model: model({
            meshes: [
              {
                id: "mesh.body",
                geometry: {
                  ...triangle(),
                  indices: new Uint32Array([0, 1, 2, 0, 2, 1]),
                },
              },
            ],
          }),
        },
      }),
    ).toThrow();
    expect(() =>
      importExchangeSchema.parse({
        request: {
          ...request,
          options: {
            ...request.options,
            declaredUnit: "inch",
          },
        },
        result: {
          contractVersion: 1,
          ok: true,
          model: model({
            provenance: {
              ...model().provenance,
              sourceUnit: "inch",
              appliedSourceToModel: IDENTITY_MAT4,
            },
          }),
        },
      }),
    ).toThrow();
  });
});

describe("analysis contracts", () => {
  const method = {
    id: "surface-distance",
    version: "1.0.0",
    parameters: { sampling: "vertices-and-centroids" },
  };
  const binding = (modelId: string) => ({
    modelId,
    modelToComparison: IDENTITY_MAT4,
  });
  const tolerance = { distanceMillimetres: 0.01 };
  const request = {
    contractVersion: 1,
    requestId: "analysis.1",
    baseline: binding("model.baseline"),
    candidate: binding("model.candidate"),
    method,
    tolerance,
    executionBudget: { maxWorkUnits: 10_000, maxMemoryBytes: 1_000_000 },
  };
  const assessment = (modelId: string) => ({
    modelId,
    closed: true,
    consistentlyOriented: true,
    boundaryEdgeCount: 0,
    nonManifoldEdgeCount: 0,
    degenerateTriangleCount: 0,
    reasons: [],
    preconditions: [{ id: "closed-solid", passed: true, details: {} }],
  });

  it("validates explicit requests and rejects direction/version ambiguity", () => {
    expect(analysisRequestSchema.parse(request)).toBeTruthy();
    expect(() =>
      analysisRequestSchema.parse({ ...request, candidate: request.baseline }),
    ).toThrow();
    expect(() =>
      analysisRequestSchema.parse({ ...request, contractVersion: 2 }),
    ).toThrow();
    expect(() =>
      analysisRequestSchema.parse({ ...request, tolerance: {} }),
    ).toThrow();
  });

  it("represents unsupported preconditions as indeterminate without metrics", () => {
    const result = analysisResultSchema.parse({
      contractVersion: 1,
      requestId: request.requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings: [],
      outcome: {
        state: "indeterminate",
        code: "open-geometry",
        reasons: ["The requested method requires closed geometry"],
        requestedMethod: method,
        requestedTolerance: tolerance,
        validation: [],
      },
    });
    expect(result.outcome.state).toBe("indeterminate");
    expect(() =>
      analysisResultSchema.parse({
        ...result,
        outcome: { ...result.outcome, metrics: [] },
      }),
    ).toThrow();
  });

  it("requires approximate uncertainty and exact two-model precondition evidence", () => {
    const base = {
      state: "complete",
      requestedMethod: method,
      effectiveMethod: {
        ...method,
        parameters: { ...method.parameters, sampleCount: 12 },
      },
      requestedTolerance: tolerance,
      effectiveTolerance: tolerance,
      validation: [assessment("model.baseline"), assessment("model.candidate")],
      metrics: [{ id: "metric.distance", value: 0.2, unit: "millimetre" }],
      regions: [
        {
          id: "region.1",
          frame: "comparison",
          category: "deviation",
          bounds: { min: [0, 0, 0], max: [1, 1, 1] },
          anchor: [0.5, 0.5, 0.5],
          metricIds: ["metric.distance"],
          warningCodes: [],
        },
      ],
      orderedRegionIds: ["region.1"],
      adjustments: [
        {
          field: "parameters",
          reason: "Effective parameters include the resolved sample count",
        },
      ],
    };
    const envelope = (outcome: unknown) => ({
      contractVersion: 1,
      requestId: request.requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings: [],
      outcome,
    });
    const approximateResult = analysisResultSchema.parse(
      envelope({
        ...base,
        semantics: "approximate",
        uncertainty: {
          description: "Finite surface samples",
          parameters: { sampleCount: 12 },
        },
      }),
    );
    expect(
      analysisExchangeSchema.parse({ request, result: approximateResult }),
    ).toBeTruthy();
    expect(() =>
      analysisExchangeSchema.parse({
        request,
        result: { ...approximateResult, requestId: "analysis.other" },
      }),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({ ...base, semantics: "approximate" }),
      ),
    ).toThrow();
    const exact = {
      ...base,
      semantics: "exact-within-validated-preconditions",
      validatedDomain: {
        id: "validated-box",
        description: "Axis-aligned closed boxes",
        preconditionIds: ["closed-solid"],
      },
    };
    expect(analysisResultSchema.parse(envelope(exact))).toBeTruthy();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          validation: [
            { ...assessment("model.baseline"), boundaryEdgeCount: 1 },
            assessment("model.candidate"),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          metrics: [{ id: "metric.count", value: -1.5, unit: "count" }],
          regions: [],
          orderedRegionIds: [],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          regions: [
            {
              ...base.regions[0],
              warningCodes: ["warning.mesh", "warning.mesh"],
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse({
        ...envelope(exact),
        warnings: [
          { code: "warning.mesh", severity: "warning", message: "First" },
          { code: "warning.mesh", severity: "warning", message: "Second" },
        ],
      }),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          validation: [
            assessment("model.baseline"),
            assessment("model.baseline"),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({ ...exact, effectiveMethod: { ...method, id: "occupancy" } }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({ ...exact, metrics: [...base.metrics, ...base.metrics] }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(envelope({ ...exact, orderedRegionIds: [] })),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(envelope({ ...exact, adjustments: [] })),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          effectiveMethod: method,
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          adjustments: [...base.adjustments, ...base.adjustments],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          validation: [
            assessment("model.baseline"),
            { ...assessment("model.candidate"), preconditions: [] },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          metrics: [{ id: "model.baseline", value: 0.2, unit: "millimetre" }],
          regions: [],
          orderedRegionIds: [],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          validatedDomain: {
            ...exact.validatedDomain,
            preconditionIds: ["closed-solid", "closed-solid"],
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          regions: [{ ...base.regions[0], id: "metric.distance" }],
          orderedRegionIds: ["metric.distance"],
        }),
      ),
    ).toThrow();
    expect(() =>
      analysisResultSchema.parse(
        envelope({
          ...exact,
          regions: [
            {
              ...base.regions[0],
              metricIds: ["metric.distance", "metric.distance"],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("limits indeterminate validation to unique requested models", () => {
    const indeterminate = {
      state: "indeterminate",
      code: "open-geometry",
      reasons: ["The requested method requires closed geometry"],
      requestedMethod: method,
      requestedTolerance: tolerance,
      validation: [assessment("model.other"), assessment("model.other")],
    };
    expect(() =>
      analysisResultSchema.parse({
        contractVersion: 1,
        requestId: request.requestId,
        baseline: request.baseline,
        candidate: request.candidate,
        warnings: [],
        outcome: indeterminate,
      }),
    ).toThrow();
  });
});
