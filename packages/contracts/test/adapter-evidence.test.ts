import { describe, expect, it } from "vitest";
import {
  benchmarkManifestSchema,
  dependencyInventorySchema,
  evaluateRelease,
  fixtureManifestSchema,
  importerRegistrySchema,
  releaseEvaluationInputSchema,
  releaseEvaluationSchema,
  releasePolicySchema,
} from "../src/adapter-evidence.js";

const digest = (value: string) => ({
  algorithm: "sha256" as const,
  value: value.repeat(64),
});
const reference = (path: string, value: string) => ({
  path,
  digest: digest(value),
});
const adapter = { id: "mesh.reference", version: "1.0.0" };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function registry() {
  return {
    contractVersion: 1,
    registryVersion: "1.0.0",
    adapters: [
      {
        contractVersion: 1,
        ...adapter,
        inputContractVersion: 1,
        inputTransport: "owned-byte-buffer",
        runtimeKinds: ["browser-worker", "node-worker"],
        formats: [
          {
            formatId: "stl",
            mediaTypes: ["model/stl"],
            extensions: ["stl"],
          },
        ],
        capabilities: {
          sourceUnits: "declaration-required",
          sourceAxes: "declaration-required",
          assemblies: "reject",
          tessellationProvenance: "not-applicable",
          externalResources: "reject",
          archiveCompression: "not-applicable",
          nativeStep: "unavailable",
        },
        dependencyInventory: reference("evidence/dependencies.json", "d"),
      },
    ],
  };
}

function dependencies() {
  return {
    contractVersion: 1,
    adapter,
    components: [
      {
        id: "mesh-parser",
        name: "Mesh parser",
        version: "1.0.0",
        role: "runtime",
        artifactDigests: [digest("1")],
        licenseExpression: "MIT",
        licenseTextPaths: ["licenses/mit.txt"],
        noticePaths: [],
        sourceUrl: "https://example.invalid/mesh-parser",
        review: {
          status: "approved",
          reference: "evidence/reviews/mesh-parser.md",
        },
      },
    ],
  };
}

const success = {
  kind: "success",
  outputDigest: digest("0"),
  detectedSourceUnit: "unknown",
  detectedSourceAxis: "unknown",
  sourceUnit: "millimetre",
  sourceAxis: "right-handed-z-up",
  warningCodes: [],
  meshes: 1,
  vertices: 4,
  triangles: 4,
  assemblyNodes: 0,
};

function fixtures() {
  return {
    contractVersion: 1,
    id: "import-fixtures",
    version: "1.0.0",
    assets: [
      {
        id: "generated-tetrahedron",
        path: "fixtures/import/generated/tetrahedron.stl",
        formatId: "stl",
        mediaType: "model/stl",
        bytes: 284,
        digest: digest("a"),
        provenance: {
          kind: "project-generated",
          generator: {
            id: "tetrahedron-generator",
            version: "1.0.0",
            parametersDigest: digest("2"),
          },
          licensePath: "LICENSE",
        },
      },
    ],
    cases: [
      {
        id: "stl-declared-frame",
        assetId: "generated-tetrahedron",
        adapter,
        targetModelId: "model.fixture",
        formatId: "stl",
        sourceName: "tetrahedron.stl",
        options: {
          declaredUnit: "millimetre",
          declaredAxis: "right-handed-z-up",
          limits: { inputBytes: 1_024, triangleCount: 100 },
        },
        expectation: success,
      },
    ],
  };
}

function benchmarks() {
  return {
    contractVersion: 1,
    id: "import-benchmarks",
    version: "1.0.0",
    environments: [
      {
        id: "browser-standard",
        runtime: { kind: "browser", name: "standards-browser", version: "1" },
        osFamily: "linux",
        architecture: "x64",
        logicalCores: 4,
        memoryBytes: 4_000_000_000,
        hardwareClass: "standard-desktop",
      },
    ],
    tiers: [
      {
        id: "release-small",
        classification: "release",
        workload: {
          inputBytes: 1_024,
          meshes: 1,
          instances: 1,
          nodes: 0,
          vertices: 1_000,
          triangles: 2_000,
        },
        repetitions: { warmup: 1, measured: 3 },
        metrics: [
          {
            id: "import-time",
            unit: "microsecond",
            aggregation: "max",
            comparator: "less-than-or-equal",
            threshold: 100,
          },
        ],
      },
    ],
  };
}

function policy() {
  return {
    contractVersion: 1,
    id: "mesh-release",
    version: "1.0.0",
    subject: { adapter, artifactDigest: digest("e") },
    registry: reference("evidence/registry.json", "3"),
    fixtures: reference("evidence/fixtures.json", "f"),
    benchmarks: reference("evidence/benchmarks.json", "b"),
    dependencies: reference("evidence/dependencies.json", "d"),
    gates: [
      {
        id: "fixtures",
        required: true,
        kind: "fixture-cases",
        caseIds: ["stl-declared-frame"],
      },
      {
        id: "replay",
        required: true,
        kind: "deterministic-replay",
        caseId: "stl-declared-frame",
        minimumRuns: 3,
      },
      {
        id: "fixture-licenses",
        required: true,
        kind: "fixture-licenses",
        assetIds: ["generated-tetrahedron"],
      },
      {
        id: "dependency-licenses",
        required: true,
        kind: "dependency-licenses",
        componentIds: ["mesh-parser"],
      },
      {
        id: "performance",
        required: true,
        kind: "benchmark",
        tierId: "release-small",
        environmentId: "browser-standard",
        metricId: "import-time",
      },
      {
        id: "local-only",
        required: true,
        kind: "network-isolation",
        maximumRequests: 0,
      },
      {
        id: "security",
        required: true,
        kind: "security-audit",
        maximumAdvisories: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    ],
  };
}

function evidence() {
  return {
    contractVersion: 1,
    policy: reference("evidence/policy.json", "4"),
    subject: { adapter, artifactDigest: digest("e") },
    registry: reference("evidence/registry.json", "3"),
    fixtures: reference("evidence/fixtures.json", "f"),
    benchmarks: reference("evidence/benchmarks.json", "b"),
    dependencies: reference("evidence/dependencies.json", "d"),
    harness: {
      id: "release-harness",
      version: "1.0.0",
      sourceRevision: "1".repeat(40),
    },
    observations: [
      {
        gateId: "fixtures",
        kind: "fixture-cases",
        cases: [
          {
            caseId: "stl-declared-frame",
            assetDigest: digest("a"),
            outcome: success,
          },
        ],
      },
      {
        gateId: "replay",
        kind: "deterministic-replay",
        caseId: "stl-declared-frame",
        runDigests: [digest("0"), digest("0"), digest("0")],
      },
      {
        gateId: "fixture-licenses",
        kind: "fixture-licenses",
        reviewedAssetIds: ["generated-tetrahedron"],
      },
      {
        gateId: "dependency-licenses",
        kind: "dependency-licenses",
        reviewedComponentIds: ["mesh-parser"],
      },
      {
        gateId: "performance",
        kind: "benchmark",
        tierId: "release-small",
        environmentId: "browser-standard",
        metricId: "import-time",
        samples: [90, 100, 95],
      },
      {
        gateId: "local-only",
        kind: "network-isolation",
        requests: 0,
      },
      {
        gateId: "security",
        kind: "security-audit",
        advisoryDatabaseDigest: digest("f"),
        advisories: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    ],
  };
}

function input() {
  return {
    policyReference: reference("evidence/policy.json", "4"),
    policy: policy(),
    evidence: evidence(),
    registryReference: reference("evidence/registry.json", "3"),
    registry: registry(),
    fixtureReference: reference("evidence/fixtures.json", "f"),
    fixtures: fixtures(),
    benchmarkReference: reference("evidence/benchmarks.json", "b"),
    benchmarks: benchmarks(),
    dependencyReference: reference("evidence/dependencies.json", "d"),
    dependencies: dependencies(),
  };
}

describe("adapter and fixture evidence contracts", () => {
  it("accepts serialized registry, fixture, dependency, and benchmark documents", () => {
    expect(importerRegistrySchema.parse(registry())).toBeTruthy();
    expect(fixtureManifestSchema.parse(fixtures())).toBeTruthy();
    expect(dependencyInventorySchema.parse(dependencies())).toBeTruthy();
    expect(benchmarkManifestSchema.parse(benchmarks())).toBeTruthy();
    expect(releasePolicySchema.parse(policy())).toBeTruthy();
    expect(releaseEvaluationInputSchema.parse(input())).toBeTruthy();
  });

  it("rejects unsafe asset paths, mismatched formats, and unresolved licenses", () => {
    const unsafe = clone(fixtures());
    unsafe.assets[0]!.path = "../private/model.stl";
    expect(() => fixtureManifestSchema.parse(unsafe)).toThrow();

    const wrongFormat = clone(fixtures());
    wrongFormat.cases[0]!.formatId = "obj";
    expect(() => fixtureManifestSchema.parse(wrongFormat)).toThrow();

    const unsafeMetadata = clone(registry());
    unsafeMetadata.adapters[0]!.version = "bad\u0000version";
    expect(() => importerRegistrySchema.parse(unsafeMetadata)).toThrow();

    const unsafeUrl = clone(dependencies());
    unsafeUrl.components[0]!.sourceUrl = "http://example.invalid/parser";
    expect(() => dependencyInventorySchema.parse(unsafeUrl)).toThrow();

    const candidate = input();
    candidate.dependencies.components[0]!.review.status = "pending";
    const result = evaluateRelease(candidate);
    expect(result.status).toBe("fail");
    expect(result.gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "dependency-licenses",
        reasons: ["dependency-license-not-approved"],
      }),
    );
  });

  it("correlates fixture assets, limits, and source-frame resolution", () => {
    const oversizedInput = fixtures();
    oversizedInput.cases[0]!.options.limits.inputBytes = 1;
    expect(() => fixtureManifestSchema.parse(oversizedInput)).toThrow();

    const oversizedOutput = fixtures();
    oversizedOutput.cases[0]!.options.limits.triangleCount = 3;
    expect(() => fixtureManifestSchema.parse(oversizedOutput)).toThrow();

    const wrongUnit = clone(fixtures());
    wrongUnit.cases[0]!.expectation.sourceUnit = "inch";
    expect(() => fixtureManifestSchema.parse(wrongUnit)).toThrow();

    const wrongAxis = clone(fixtures());
    wrongAxis.cases[0]!.expectation.sourceAxis = "right-handed-y-up";
    expect(() => fixtureManifestSchema.parse(wrongAxis)).toThrow();
  });

  it("keeps native STEP and compressed 3MF behind explicit evidence", () => {
    const nativeStep = clone(registry());
    nativeStep.adapters[0]!.formats = [
      { formatId: "step", mediaTypes: ["model/step"], extensions: ["step"] },
    ];
    expect(() => importerRegistrySchema.parse(nativeStep)).toThrow();

    nativeStep.adapters[0]!.capabilities.nativeStep =
      "release-evidence-required";
    const nativeStepInput = input();
    nativeStepInput.registry = nativeStep;
    expect(evaluateRelease(nativeStepInput).inputReasons).toContain(
      "missing-native-step-gate",
    );
    const alternateNativeStep = input();
    alternateNativeStep.registry.adapters[0]!.capabilities.nativeStep =
      "release-evidence-required";
    expect(evaluateRelease(alternateNativeStep).inputReasons).toContain(
      "missing-native-step-gate",
    );

    const compressed = input();
    compressed.registry.adapters[0]!.formats.push({
      formatId: "3mf",
      mediaTypes: ["model/3mf"],
      extensions: ["3mf"],
    });
    expect(evaluateRelease(compressed).status).toBe("fail");
    compressed.registry.adapters[0]!.capabilities.archiveCompression =
      "bounded-compressed-evidence-required";
    expect(evaluateRelease(compressed).inputReasons).toContain(
      "missing-bounded-archive-compression-gate",
    );
    const alternateCompressed = input();
    alternateCompressed.registry.adapters[0]!.capabilities.archiveCompression =
      "bounded-compressed-evidence-required";
    expect(evaluateRelease(alternateCompressed).inputReasons).toContain(
      "missing-bounded-archive-compression-gate",
    );

    compressed.registry.adapters[0]!.capabilities.archiveCompression =
      "stored-only";

    compressed.policy.gates.push({
      id: "compressed-3mf",
      required: true,
      kind: "capability-evidence",
      capability: "bounded-archive-compression",
    } as never);
    compressed.evidence.observations.push({
      gateId: "compressed-3mf",
      kind: "capability-evidence",
      capability: "bounded-archive-compression",
      passed: true,
      evidenceDigest: digest("e"),
    } as never);
    const unsupported = evaluateRelease(compressed);
    expect(unsupported.status).toBe("fail");
    expect(unsupported.gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "compressed-3mf",
        reasons: ["capability-not-declared"],
      }),
    );

    compressed.registry.adapters[0]!.capabilities.archiveCompression =
      "bounded-compressed-evidence-required";
    expect(evaluateRelease(compressed).status).toBe("pass");

    const external = input();
    external.registry.adapters[0]!.capabilities.externalResources = "resolve";
    expect(evaluateRelease(external).inputReasons).toContain(
      "missing-external-resource-gate",
    );
  });
});

describe("release evaluation", () => {
  it("derives a stable passing verdict and sorted gate results", () => {
    const first = evaluateRelease(input());
    const second = evaluateRelease(input());
    expect(first).toEqual(second);
    expect(first.status).toBe("pass");
    expect(first.inputReasons).toEqual([]);
    expect(first.gateResults.map(({ gateId }) => gateId)).toEqual(
      [...first.gateResults.map(({ gateId }) => gateId)].sort(),
    );
    expect(releaseEvaluationSchema.parse(first)).toEqual(first);
  });

  it("fails closed on stale documents, missing gates, and forged outcomes", () => {
    const stale = input();
    stale.evidence.fixtures = reference("evidence/fixtures.json", "9");
    expect(evaluateRelease(stale).inputReasons).toContain(
      "fixture-reference-mismatch",
    );

    const forgedDocument = input();
    forgedDocument.fixtureReference = reference("evidence/fixtures.json", "8");
    expect(evaluateRelease(forgedDocument).inputReasons).toContain(
      "fixture-reference-mismatch",
    );

    for (const [key, reason] of [
      ["registryReference", "registry-reference-mismatch"],
      ["benchmarkReference", "benchmark-reference-mismatch"],
      ["dependencyReference", "dependency-reference-mismatch"],
    ] as const) {
      const forgedReference = input();
      forgedReference[key] = reference(
        forgedReference[key].path,
        key === "registryReference"
          ? "5"
          : key === "benchmarkReference"
            ? "6"
            : "7",
      );
      expect(evaluateRelease(forgedReference).inputReasons).toContain(reason);
    }

    const missing = input();
    missing.evidence.observations = missing.evidence.observations.filter(
      ({ gateId }) => gateId !== "security",
    );
    expect(evaluateRelease(missing).gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "security",
        reasons: ["missing-observation"],
      }),
    );

    const forged = input();
    const fixtureObservation = forged.evidence.observations[0]! as {
      kind: "fixture-cases";
      cases: Array<{ outcome: typeof success }>;
    };
    if (fixtureObservation.kind !== "fixture-cases") throw new Error("fixture");
    fixtureObservation.cases[0]!.outcome = {
      ...fixtureObservation.cases[0]!.outcome,
      triangles: 5,
    };
    expect(evaluateRelease(forged).gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "fixtures",
        reasons: ["fixture-outcome-mismatch"],
      }),
    );
  });

  it("requires release gates to cover fixture and dependency licenses", () => {
    const fixtureCoverage = input();
    fixtureCoverage.policy.gates = fixtureCoverage.policy.gates.filter(
      ({ id }) => id !== "fixture-licenses",
    );
    expect(evaluateRelease(fixtureCoverage).inputReasons).toContain(
      "fixture-license-gate-incomplete",
    );

    const dependencyCoverage = input();
    dependencyCoverage.dependencies.components.push({
      ...clone(dependencyCoverage.dependencies.components[0]!),
      id: "mesh-runtime",
      name: "Mesh runtime",
      artifactDigests: [digest("2")],
      review: {
        status: "approved",
        reference: "evidence/reviews/mesh-runtime.md",
      },
    });
    expect(evaluateRelease(dependencyCoverage).inputReasons).toContain(
      "dependency-license-gate-incomplete",
    );
  });

  it("detects nondeterminism and benchmark threshold failures", () => {
    const candidate = input();
    const replay = candidate.evidence.observations.find(
      ({ gateId }) => gateId === "replay",
    ) as {
      kind: "deterministic-replay";
      runDigests: ReturnType<typeof digest>[];
    };
    if (replay?.kind !== "deterministic-replay") throw new Error("replay");
    replay.runDigests[2] = digest("b");
    const benchmark = candidate.evidence.observations.find(
      ({ gateId }) => gateId === "performance",
    );
    if (benchmark?.kind !== "benchmark") throw new Error("benchmark");
    benchmark.samples = [90, 101, 95];
    const result = evaluateRelease(candidate);
    expect(result.status).toBe("fail");
    expect(result.gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "replay",
        reasons: expect.arrayContaining(["nondeterministic-replay"]),
      }),
    );
    expect(result.gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "performance",
        reasons: ["benchmark-threshold-failed"],
      }),
    );
  });

  it("binds deterministic replay to a known fixture output", () => {
    const unknown = input();
    const unknownGate = unknown.policy.gates.find(({ id }) => id === "replay");
    const unknownObservation = unknown.evidence.observations.find(
      ({ gateId }) => gateId === "replay",
    );
    if (
      unknownGate?.kind !== "deterministic-replay" ||
      unknownObservation?.kind !== "deterministic-replay"
    )
      throw new Error("replay");
    unknownGate.caseId = "case.unknown";
    unknownObservation.caseId = "case.unknown";
    expect(evaluateRelease(unknown).gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "replay",
        reasons: ["unknown-replay-case"],
      }),
    );

    const forged = input();
    const forgedObservation = forged.evidence.observations.find(
      ({ gateId }) => gateId === "replay",
    );
    if (forgedObservation?.kind !== "deterministic-replay")
      throw new Error("replay");
    forgedObservation.runDigests = [digest("b"), digest("b"), digest("b")];
    expect(evaluateRelease(forged).gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "replay",
        reasons: ["replay-output-mismatch"],
      }),
    );
  });

  it("rejects research tiers and recomputes nearest-rank p95", () => {
    const candidate = input();
    const tier = candidate.benchmarks.tiers[0]!;
    tier.classification = "research";
    tier.metrics[0]!.aggregation = "nearest-rank-p95";
    const benchmark = candidate.evidence.observations.find(
      ({ gateId }) => gateId === "performance",
    );
    if (benchmark?.kind !== "benchmark") throw new Error("benchmark");
    benchmark.samples = [99, 100, 100];
    expect(evaluateRelease(candidate).gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "performance",
        reasons: ["research-tier-cannot-release"],
      }),
    );

    tier.classification = "release";
    benchmark.samples = [99, 100, 101];
    expect(evaluateRelease(candidate).gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "performance",
        reasons: ["benchmark-threshold-failed"],
      }),
    );

    tier.metrics[0]!.aggregation = "median";
    tier.metrics[0]!.threshold = Number.MAX_SAFE_INTEGER - 1;
    tier.repetitions.measured = 2;
    benchmark.samples = [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
    expect(evaluateRelease(candidate).gateResults).toContainEqual(
      expect.objectContaining({
        gateId: "performance",
        reasons: ["benchmark-threshold-failed"],
      }),
    );
  });

  it("returns reproducible failures for malformed input", () => {
    const malformed = {
      ...input(),
      extra: true,
      ["bad\u0000\ud800key"]: true,
    };
    const first = evaluateRelease(malformed);
    expect(first).toEqual(evaluateRelease(malformed));
    expect(first.status).toBe("fail");
    expect(first.gateResults).toEqual([]);
    expect(
      first.inputReasons.some((reason) => reason.includes("Unrecognized key")),
    ).toBe(true);
    expect(first.inputReasons.every((reason) => reason.length <= 500)).toBe(
      true,
    );
    expect(first.inputReasons.join("").includes("\u0000")).toBe(false);
    expect(first.inputReasons.join("").includes("\ud800")).toBe(false);
  });

  it("rejects unsafe metadata and sanitizes hostile failure paths", () => {
    for (const value of [
      "1.0.0\nforged",
      "1.0.0\u0085forged",
      "1.0.0\u2028forged",
      "1.0.0\u202eforged",
      " 1.0.0",
    ]) {
      const unsafeRegistry = registry();
      unsafeRegistry.registryVersion = value;
      expect(() => importerRegistrySchema.parse(unsafeRegistry)).toThrow();
    }
    const unsafeFixture = fixtures();
    unsafeFixture.cases[0]!.sourceName = "part\n\u202eforged.stl";
    expect(() => fixtureManifestSchema.parse(unsafeFixture)).toThrow();

    const maliciousKey = "extra\n\u202eforged";
    const result = evaluateRelease({ ...input(), [maliciousKey]: true });
    expect(result.status).toBe("fail");
    expect(result.inputReasons.join(" ")).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
    expect(releaseEvaluationSchema.parse(result)).toEqual(result);
    expect(() =>
      releaseEvaluationSchema.parse({
        contractVersion: 1,
        status: "fail",
        inputReasons: ["unsafe\u2028reason"],
        gateResults: [],
      }),
    ).toThrow();
    expect(() =>
      releaseEvaluationSchema.parse({
        contractVersion: 1,
        status: "pass",
        inputReasons: [],
        gateResults: [
          {
            gateId: "required-gate",
            required: true,
            passed: false,
            reasons: ["missing-observation"],
          },
        ],
      }),
    ).toThrow();
  });
});
