import { z } from "zod";
import { importFailureCodeSchema, importOptionsSchema } from "./import.js";
import {
  entityIdSchema,
  isPortableJson,
  modelIdSchema,
  resolvedSourceAxisSchema,
  resolvedSourceUnitSchema,
  sha256DigestSchema,
} from "./primitives.js";

const unsafeTextCharacters =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const safeString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, "Text must be trimmed")
    .refine(
      (value) => isPortableJson(value) && !unsafeTextCharacters.test(value),
      "Text contains an unsupported Unicode or control character",
    );
const safeVersion = safeString(128);
const safeLabel = safeString(240);
const safeHttpsUrl = safeString(2_048)
  .pipe(z.url())
  .refine((value) => value.startsWith("https://"), "Source URL must use HTTPS");
const safeCount = z.number().int().safe().nonnegative();
const positiveCount = z.number().int().safe().positive();

export const repositoryResourcePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u,
    "Repository paths must be normalized and relative",
  )
  .refine(
    (path) =>
      path
        .split("/")
        .every((component) => component !== "." && component !== ".."),
    "Repository paths cannot contain dot segments",
  );

const mediaTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);

function sanitizeReason(value: string): string {
  let output = "";
  for (let index = 0; index < value.length && output.length < 500; index += 1) {
    const unit = value.charCodeAt(index);
    if (unsafeTextCharacters.test(value[index] ?? "")) {
      output += "?";
      continue;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff && output.length <= 497) {
        output += value[index] ?? "";
        output += value[index + 1] ?? "";
        index += 1;
      } else output += "?";
    } else if (unit >= 0xdc00 && unit <= 0xdfff) output += "?";
    else output += value[index] ?? "";
  }
  return output;
}

export const documentReferenceSchema = z.strictObject({
  path: repositoryResourcePathSchema,
  digest: sha256DigestSchema,
});
export type DocumentReference = z.infer<typeof documentReferenceSchema>;

export const adapterReferenceSchema = z.strictObject({
  id: entityIdSchema,
  version: safeVersion,
});
export type AdapterReference = z.infer<typeof adapterReferenceSchema>;

const formatSupportSchema = z
  .strictObject({
    formatId: entityIdSchema,
    mediaTypes: z.array(mediaTypeSchema).max(64),
    extensions: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u))
      .max(64),
  })
  .superRefine((format, context) => {
    for (const [key, values] of [
      ["mediaTypes", format.mediaTypes],
      ["extensions", format.extensions],
    ] as const) {
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Format hints must be unique",
        });
    }
  });

export const adapterCapabilitiesSchema = z.strictObject({
  sourceUnits: z.enum([
    "embedded",
    "declaration-required",
    "user-resolution-supported",
  ]),
  sourceAxes: z.enum([
    "embedded",
    "declaration-required",
    "user-resolution-supported",
  ]),
  assemblies: z.enum([
    "preserve",
    "flatten-with-warning",
    "reject",
    "not-applicable",
  ]),
  tessellationProvenance: z.enum(["preserve", "produce", "not-applicable"]),
  externalResources: z.enum(["reject", "embedded-only", "resolve"]),
  archiveCompression: z.enum([
    "not-applicable",
    "stored-only",
    "bounded-compressed-evidence-required",
  ]),
  nativeStep: z.enum(["unavailable", "release-evidence-required"]),
});
export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>;

export const importerAdapterDescriptorSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: entityIdSchema,
    version: safeVersion,
    inputContractVersion: z.literal(1),
    inputTransport: z.literal("owned-byte-buffer"),
    runtimeKinds: z
      .array(z.enum(["browser-worker", "node-worker"]))
      .min(1)
      .max(2),
    formats: z.array(formatSupportSchema).min(1).max(128),
    capabilities: adapterCapabilitiesSchema,
    dependencyInventory: documentReferenceSchema,
  })
  .superRefine((adapter, context) => {
    if (new Set(adapter.runtimeKinds).size !== adapter.runtimeKinds.length)
      context.addIssue({
        code: "custom",
        path: ["runtimeKinds"],
        message: "Runtime kinds must be unique",
      });
    const formatIds = adapter.formats.map(({ formatId }) => formatId);
    if (new Set(formatIds).size !== formatIds.length)
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "Adapter format IDs must be unique",
      });
    if (
      formatIds.map(String).includes("step") &&
      adapter.capabilities.nativeStep !== "release-evidence-required"
    )
      context.addIssue({
        code: "custom",
        path: ["capabilities", "nativeStep"],
        message: "Native STEP requires explicit release evidence",
      });
    if (
      formatIds.map(String).includes("3mf") &&
      adapter.capabilities.archiveCompression === "not-applicable"
    )
      context.addIssue({
        code: "custom",
        path: ["capabilities", "archiveCompression"],
        message: "3MF must declare stored-only or gated compressed archives",
      });
  });
export type ImporterAdapterDescriptor = z.infer<
  typeof importerAdapterDescriptorSchema
>;

export const importerRegistrySchema = z
  .strictObject({
    contractVersion: z.literal(1),
    registryVersion: safeVersion,
    adapters: z.array(importerAdapterDescriptorSchema).max(256),
  })
  .superRefine((registry, context) => {
    const keys = registry.adapters.map(
      ({ id, version }) => `${String(id)}@${version}`,
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["adapters"],
        message: "Registry adapter identities must be unique",
      });
  });
export type ImporterRegistry = z.infer<typeof importerRegistrySchema>;

export const dependencyComponentSchema = z.strictObject({
  id: entityIdSchema,
  name: safeLabel,
  version: safeVersion,
  role: z.enum(["runtime", "wasm", "native"]),
  artifactDigests: z.array(sha256DigestSchema).min(1).max(64),
  licenseExpression: safeLabel,
  licenseTextPaths: z.array(repositoryResourcePathSchema).min(1).max(16),
  noticePaths: z.array(repositoryResourcePathSchema).max(16),
  sourceUrl: safeHttpsUrl.optional(),
  review: z.strictObject({
    status: z.enum(["approved", "pending", "blocked"]),
    reference: repositoryResourcePathSchema,
  }),
});

export const dependencyInventorySchema = z
  .strictObject({
    contractVersion: z.literal(1),
    adapter: adapterReferenceSchema,
    components: z.array(dependencyComponentSchema).max(10_000),
  })
  .superRefine((inventory, context) => {
    const componentIds = inventory.components.map(({ id }) => id);
    if (new Set(componentIds).size !== componentIds.length)
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "Dependency component IDs must be unique",
      });
  });
export type DependencyInventory = z.infer<typeof dependencyInventorySchema>;

const reviewedLicenseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("project-generated"),
    generator: z.strictObject({
      id: entityIdSchema,
      version: safeVersion,
      parametersDigest: sha256DigestSchema,
    }),
    licensePath: repositoryResourcePathSchema,
  }),
  z.strictObject({
    kind: z.literal("third-party"),
    sourceUrl: safeHttpsUrl,
    licenseExpression: safeLabel,
    licenseTextPaths: z.array(repositoryResourcePathSchema).min(1).max(16),
    noticePaths: z.array(repositoryResourcePathSchema).max(16),
    redistributionReview: z.strictObject({
      status: z.enum(["approved", "pending", "blocked"]),
      reference: repositoryResourcePathSchema,
    }),
  }),
]);

export const fixtureAssetSchema = z.strictObject({
  id: entityIdSchema,
  path: repositoryResourcePathSchema,
  formatId: entityIdSchema,
  mediaType: mediaTypeSchema,
  bytes: positiveCount,
  digest: sha256DigestSchema,
  provenance: reviewedLicenseSchema,
});

const fixtureSuccessSchema = z.strictObject({
  kind: z.literal("success"),
  outputDigest: sha256DigestSchema,
  detectedSourceUnit: z.enum([
    "unknown",
    "micrometre",
    "millimetre",
    "centimetre",
    "metre",
    "inch",
    "foot",
  ]),
  detectedSourceAxis: z.enum([
    "unknown",
    "right-handed-z-up",
    "right-handed-y-up",
  ]),
  sourceUnit: resolvedSourceUnitSchema,
  sourceAxis: resolvedSourceAxisSchema,
  warningCodes: z.array(entityIdSchema).max(1_000),
  meshes: positiveCount,
  vertices: positiveCount,
  triangles: positiveCount,
  assemblyNodes: safeCount,
});

const fixtureFailureSchema = z.strictObject({
  kind: z.literal("failure"),
  code: importFailureCodeSchema,
  warningCodes: z.array(entityIdSchema).max(1_000),
});

export const fixtureOutcomeSchema = z.discriminatedUnion("kind", [
  fixtureSuccessSchema,
  fixtureFailureSchema,
]);
export type FixtureOutcome = z.infer<typeof fixtureOutcomeSchema>;

export const fixtureCaseSchema = z.strictObject({
  id: entityIdSchema,
  assetId: entityIdSchema,
  adapter: adapterReferenceSchema,
  targetModelId: modelIdSchema,
  formatId: entityIdSchema,
  sourceName: z.string().min(1).max(1_024),
  options: importOptionsSchema,
  expectation: fixtureOutcomeSchema,
});

export const fixtureManifestSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: entityIdSchema,
    version: safeVersion,
    assets: z.array(fixtureAssetSchema).max(10_000),
    cases: z.array(fixtureCaseSchema).max(100_000),
  })
  .superRefine((manifest, context) => {
    const assetIds = manifest.assets.map(({ id }) => id);
    const assetPaths = manifest.assets.map(({ path }) => path);
    const caseIds = manifest.cases.map(({ id }) => id);
    for (const [path, values] of [
      ["assets", assetIds],
      ["assets", assetPaths],
      ["cases", caseIds],
    ] as const) {
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          path: [path],
          message: "Fixture identities and paths must be unique",
        });
    }
    const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    manifest.cases.forEach((fixture, index) => {
      const asset = assets.get(fixture.assetId);
      if (!asset || asset.formatId !== fixture.formatId)
        context.addIssue({
          code: "custom",
          path: ["cases", index, "assetId"],
          message: "Fixture case must reference an asset with the same format",
        });
    });
  });
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

export const benchmarkEnvironmentSchema = z.strictObject({
  id: entityIdSchema,
  runtime: z.strictObject({
    kind: z.enum(["browser", "node"]),
    name: safeLabel,
    version: safeVersion,
  }),
  osFamily: z.enum(["linux", "macos", "windows", "android", "ios", "other"]),
  architecture: z.enum(["x64", "arm64", "other"]),
  logicalCores: positiveCount,
  memoryBytes: positiveCount,
  hardwareClass: entityIdSchema,
});

export const benchmarkMetricPolicySchema = z.strictObject({
  id: entityIdSchema,
  unit: z.enum(["microsecond", "byte", "count"]),
  aggregation: z.enum(["max", "median", "nearest-rank-p95"]),
  comparator: z.enum(["less-than-or-equal", "greater-than-or-equal"]),
  threshold: safeCount,
});

export const benchmarkTierSchema = z
  .strictObject({
    id: entityIdSchema,
    classification: z.enum(["research", "release"]),
    workload: z.strictObject({
      inputBytes: positiveCount,
      expandedBytes: positiveCount.optional(),
      meshes: positiveCount,
      instances: positiveCount,
      nodes: safeCount,
      vertices: positiveCount,
      triangles: positiveCount,
    }),
    repetitions: z.strictObject({
      warmup: safeCount.max(10_000),
      measured: positiveCount.max(10_000),
    }),
    metrics: z.array(benchmarkMetricPolicySchema).min(1).max(128),
  })
  .superRefine((tier, context) => {
    const metricIds = tier.metrics.map(({ id }) => id);
    if (new Set(metricIds).size !== metricIds.length)
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "Benchmark metric IDs must be unique",
      });
  });

export const benchmarkManifestSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: entityIdSchema,
    version: safeVersion,
    environments: z.array(benchmarkEnvironmentSchema).max(128),
    tiers: z.array(benchmarkTierSchema).max(128),
  })
  .superRefine((manifest, context) => {
    for (const [key, values] of [
      ["environments", manifest.environments.map(({ id }) => id)],
      ["tiers", manifest.tiers.map(({ id }) => id)],
    ] as const) {
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Benchmark document IDs must be unique",
        });
    }
  });
export type BenchmarkManifest = z.infer<typeof benchmarkManifestSchema>;

const gateBase = {
  id: entityIdSchema,
  required: z.boolean(),
};

export const releaseGateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...gateBase,
    kind: z.literal("fixture-cases"),
    caseIds: z.array(entityIdSchema).min(1).max(100_000),
  }),
  z.strictObject({
    ...gateBase,
    kind: z.literal("deterministic-replay"),
    caseId: entityIdSchema,
    minimumRuns: z.number().int().safe().min(2).max(100),
  }),
  z.strictObject({
    ...gateBase,
    kind: z.literal("capability-evidence"),
    capability: z.enum([
      "bounded-compressed-3mf",
      "native-step",
      "external-resource-resolution",
    ]),
  }),
  z.strictObject({
    ...gateBase,
    kind: z.literal("fixture-licenses"),
    assetIds: z.array(entityIdSchema).min(1).max(10_000),
  }),
  z.strictObject({
    ...gateBase,
    kind: z.literal("dependency-licenses"),
    componentIds: z.array(entityIdSchema).min(1).max(10_000),
  }),
  z.strictObject({
    ...gateBase,
    kind: z.literal("benchmark"),
    tierId: entityIdSchema,
    environmentId: entityIdSchema,
    metricId: entityIdSchema,
  }),
  z.strictObject({
    ...gateBase,
    kind: z.literal("network-isolation"),
    maximumRequests: safeCount,
  }),
  z.strictObject({
    ...gateBase,
    kind: z.literal("security-audit"),
    maximumAdvisories: z.strictObject({
      critical: safeCount,
      high: safeCount,
      moderate: safeCount,
      low: safeCount,
    }),
  }),
]);
export type ReleaseGate = z.infer<typeof releaseGateSchema>;

export const releasePolicySchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: entityIdSchema,
    version: safeVersion,
    subject: z.strictObject({
      adapter: adapterReferenceSchema,
      artifactDigest: sha256DigestSchema,
    }),
    registry: documentReferenceSchema,
    fixtures: documentReferenceSchema,
    benchmarks: documentReferenceSchema,
    dependencies: documentReferenceSchema,
    gates: z.array(releaseGateSchema).min(1).max(1_000),
  })
  .superRefine((policy, context) => {
    const gateIds = policy.gates.map(({ id }) => id);
    if (new Set(gateIds).size !== gateIds.length)
      context.addIssue({
        code: "custom",
        path: ["gates"],
        message: "Release gate IDs must be unique",
      });
  });
export type ReleasePolicy = z.infer<typeof releasePolicySchema>;

const observationBase = { gateId: entityIdSchema };
const fixtureCaseObservationSchema = z.strictObject({
  caseId: entityIdSchema,
  assetDigest: sha256DigestSchema,
  outcome: fixtureOutcomeSchema,
});

export const releaseObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...observationBase,
    kind: z.literal("fixture-cases"),
    cases: z.array(fixtureCaseObservationSchema).max(100_000),
  }),
  z.strictObject({
    ...observationBase,
    kind: z.literal("deterministic-replay"),
    caseId: entityIdSchema,
    runDigests: z.array(sha256DigestSchema).min(2).max(100),
  }),
  z.strictObject({
    ...observationBase,
    kind: z.literal("capability-evidence"),
    capability: z.enum([
      "bounded-compressed-3mf",
      "native-step",
      "external-resource-resolution",
    ]),
    passed: z.boolean(),
    evidenceDigest: sha256DigestSchema,
  }),
  z.strictObject({
    ...observationBase,
    kind: z.literal("fixture-licenses"),
    reviewedAssetIds: z.array(entityIdSchema).max(10_000),
  }),
  z.strictObject({
    ...observationBase,
    kind: z.literal("dependency-licenses"),
    reviewedComponentIds: z.array(entityIdSchema).max(10_000),
  }),
  z.strictObject({
    ...observationBase,
    kind: z.literal("benchmark"),
    tierId: entityIdSchema,
    environmentId: entityIdSchema,
    metricId: entityIdSchema,
    samples: z.array(safeCount).min(1).max(10_000),
  }),
  z.strictObject({
    ...observationBase,
    kind: z.literal("network-isolation"),
    requests: safeCount,
  }),
  z.strictObject({
    ...observationBase,
    kind: z.literal("security-audit"),
    advisoryDatabaseDigest: sha256DigestSchema,
    advisories: z.strictObject({
      critical: safeCount,
      high: safeCount,
      moderate: safeCount,
      low: safeCount,
    }),
  }),
]);
export type ReleaseObservation = z.infer<typeof releaseObservationSchema>;

export const releaseEvidenceSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    policy: documentReferenceSchema,
    subject: z.strictObject({
      adapter: adapterReferenceSchema,
      artifactDigest: sha256DigestSchema,
    }),
    registry: documentReferenceSchema,
    fixtures: documentReferenceSchema,
    benchmarks: documentReferenceSchema,
    dependencies: documentReferenceSchema,
    harness: z.strictObject({
      id: entityIdSchema,
      version: safeVersion,
      sourceRevision: safeString(128),
    }),
    observations: z.array(releaseObservationSchema).max(1_000),
  })
  .superRefine((evidence, context) => {
    const gateIds = evidence.observations.map(({ gateId }) => gateId);
    if (new Set(gateIds).size !== gateIds.length)
      context.addIssue({
        code: "custom",
        path: ["observations"],
        message: "Evidence may contain at most one observation per gate",
      });
  });
export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>;

export const releaseEvaluationInputSchema = z.strictObject({
  policyReference: documentReferenceSchema,
  policy: releasePolicySchema,
  evidence: releaseEvidenceSchema,
  registryReference: documentReferenceSchema,
  registry: importerRegistrySchema,
  fixtureReference: documentReferenceSchema,
  fixtures: fixtureManifestSchema,
  benchmarkReference: documentReferenceSchema,
  benchmarks: benchmarkManifestSchema,
  dependencyReference: documentReferenceSchema,
  dependencies: dependencyInventorySchema,
});
export type ReleaseEvaluationInput = z.infer<
  typeof releaseEvaluationInputSchema
>;

export const releaseGateResultSchema = z.strictObject({
  gateId: entityIdSchema,
  required: z.boolean(),
  passed: z.boolean(),
  reasons: z.array(z.string().min(1).max(200)).max(64),
});
export type ReleaseGateResult = z.infer<typeof releaseGateResultSchema>;

export const releaseEvaluationSchema = z.strictObject({
  contractVersion: z.literal(1),
  status: z.enum(["pass", "fail"]),
  inputReasons: z.array(z.string().min(1).max(500)).max(1_000),
  gateResults: z.array(releaseGateResultSchema).max(1_000),
});
export type ReleaseEvaluation = z.infer<typeof releaseEvaluationSchema>;

function referenceEqual(
  left: DocumentReference,
  right: DocumentReference,
): boolean {
  return left.path === right.path && left.digest.value === right.digest.value;
}

function adapterEqual(
  left: AdapterReference,
  right: AdapterReference,
): boolean {
  return left.id === right.id && left.version === right.version;
}

function stableEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => stableEqual(value, right[index]))
    );
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          stableEqual(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return false;
}

function aggregate(
  samples: readonly number[],
  method: z.infer<typeof benchmarkMetricPolicySchema>["aggregation"],
): number {
  const ordered = [...samples].sort((left, right) => left - right);
  if (method === "max") return ordered.at(-1) ?? Number.NaN;
  if (method === "nearest-rank-p95")
    return (
      ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? Number.NaN
    );
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? Number.NaN);
}

function capabilityPermitted(
  adapter: ImporterAdapterDescriptor,
  capability: Extract<
    ReleaseGate,
    { kind: "capability-evidence" }
  >["capability"],
): boolean {
  if (capability === "native-step")
    return adapter.capabilities.nativeStep === "release-evidence-required";
  if (capability === "bounded-compressed-3mf")
    return (
      adapter.capabilities.archiveCompression ===
      "bounded-compressed-evidence-required"
    );
  return adapter.capabilities.externalResources === "resolve";
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function evaluateGate(
  gate: ReleaseGate,
  observation: ReleaseObservation | undefined,
  input: ReleaseEvaluationInput,
  adapter: ImporterAdapterDescriptor | undefined,
): ReleaseGateResult {
  const reasons: string[] = [];
  if (!observation) reasons.push("missing-observation");
  else if (observation.kind !== gate.kind)
    reasons.push("observation-kind-mismatch");
  else if (gate.kind === "fixture-cases" && observation.kind === gate.kind) {
    const expectedIds = gate.caseIds.map(String);
    const observedIds = observation.cases.map(({ caseId }) => String(caseId));
    if (!uniqueStrings(expectedIds) || !uniqueStrings(observedIds))
      reasons.push("duplicate-fixture-case");
    if (
      expectedIds.length !== observedIds.length ||
      expectedIds.some((id) => !observedIds.includes(id))
    )
      reasons.push("fixture-case-set-mismatch");
    for (const expectedId of expectedIds) {
      const fixture = input.fixtures.cases.find(
        ({ id }) => String(id) === expectedId,
      );
      const actual = observation.cases.find(
        ({ caseId }) => String(caseId) === expectedId,
      );
      const asset = fixture
        ? input.fixtures.assets.find(({ id }) => id === fixture.assetId)
        : undefined;
      if (!fixture || !actual || !asset) reasons.push("unknown-fixture-case");
      else {
        if (asset.digest.value !== actual.assetDigest.value)
          reasons.push("fixture-asset-digest-mismatch");
        if (!stableEqual(fixture.expectation, actual.outcome))
          reasons.push("fixture-outcome-mismatch");
        if (!adapterEqual(fixture.adapter, input.policy.subject.adapter))
          reasons.push("fixture-adapter-mismatch");
        if (
          !adapter?.formats.some(
            ({ formatId }) => formatId === fixture.formatId,
          )
        )
          reasons.push("fixture-format-not-registered");
      }
    }
  } else if (
    gate.kind === "deterministic-replay" &&
    observation.kind === gate.kind
  ) {
    if (observation.caseId !== gate.caseId)
      reasons.push("replay-case-mismatch");
    if (observation.runDigests.length < gate.minimumRuns)
      reasons.push("insufficient-replay-runs");
    if (new Set(observation.runDigests.map(({ value }) => value)).size !== 1)
      reasons.push("nondeterministic-replay");
  } else if (
    gate.kind === "capability-evidence" &&
    observation.kind === gate.kind
  ) {
    if (observation.capability !== gate.capability)
      reasons.push("capability-mismatch");
    if (!adapter || !capabilityPermitted(adapter, gate.capability))
      reasons.push("capability-not-declared");
    if (!observation.passed) reasons.push("capability-evidence-failed");
  } else if (
    gate.kind === "fixture-licenses" &&
    observation.kind === gate.kind
  ) {
    const expectedIds = gate.assetIds.map(String);
    const reviewedIds = observation.reviewedAssetIds.map(String);
    if (!uniqueStrings(expectedIds) || !uniqueStrings(reviewedIds))
      reasons.push("duplicate-license-asset");
    if (
      expectedIds.length !== reviewedIds.length ||
      expectedIds.some((id) => !reviewedIds.includes(id))
    )
      reasons.push("license-asset-set-mismatch");
    for (const id of expectedIds) {
      const asset = input.fixtures.assets.find(
        ({ id: assetId }) => assetId === id,
      );
      if (!asset) reasons.push("unknown-license-asset");
      else if (
        asset.provenance.kind === "third-party" &&
        asset.provenance.redistributionReview.status !== "approved"
      )
        reasons.push("fixture-license-not-approved");
    }
  } else if (
    gate.kind === "dependency-licenses" &&
    observation.kind === gate.kind
  ) {
    const expectedIds = gate.componentIds.map(String);
    const reviewedIds = observation.reviewedComponentIds.map(String);
    if (!uniqueStrings(expectedIds) || !uniqueStrings(reviewedIds))
      reasons.push("duplicate-license-component");
    if (
      expectedIds.length !== reviewedIds.length ||
      expectedIds.some((id) => !reviewedIds.includes(id))
    )
      reasons.push("license-component-set-mismatch");
    for (const id of expectedIds) {
      const component = input.dependencies.components.find(
        ({ id: componentId }) => componentId === id,
      );
      if (!component) reasons.push("unknown-license-component");
      else if (component.review.status !== "approved")
        reasons.push("dependency-license-not-approved");
    }
  } else if (gate.kind === "benchmark" && observation.kind === gate.kind) {
    const tier = input.benchmarks.tiers.find(({ id }) => id === gate.tierId);
    const environment = input.benchmarks.environments.find(
      ({ id }) => id === gate.environmentId,
    );
    const metric = tier?.metrics.find(({ id }) => id === gate.metricId);
    if (
      observation.tierId !== gate.tierId ||
      observation.environmentId !== gate.environmentId ||
      observation.metricId !== gate.metricId
    )
      reasons.push("benchmark-reference-mismatch");
    if (!tier || !environment || !metric)
      reasons.push("unknown-benchmark-input");
    else {
      if (tier.classification !== "release")
        reasons.push("research-tier-cannot-release");
      if (observation.samples.length !== tier.repetitions.measured)
        reasons.push("benchmark-sample-count-mismatch");
      const value = aggregate(observation.samples, metric.aggregation);
      const passed =
        metric.comparator === "less-than-or-equal"
          ? value <= metric.threshold
          : value >= metric.threshold;
      if (!passed) reasons.push("benchmark-threshold-failed");
    }
  } else if (
    gate.kind === "network-isolation" &&
    observation.kind === gate.kind
  ) {
    if (observation.requests > gate.maximumRequests)
      reasons.push("network-request-limit-exceeded");
  } else if (gate.kind === "security-audit" && observation.kind === gate.kind) {
    for (const severity of ["critical", "high", "moderate", "low"] as const)
      if (observation.advisories[severity] > gate.maximumAdvisories[severity])
        reasons.push(`security-${severity}-limit-exceeded`);
  }
  const stableReasons = [...new Set(reasons)].sort();
  return {
    gateId: gate.id,
    required: gate.required,
    passed: stableReasons.length === 0,
    reasons: stableReasons,
  };
}

/** Derives a stable verdict; malformed or stale evidence always fails closed. */
export function evaluateRelease(value: unknown): ReleaseEvaluation {
  const parsed = releaseEvaluationInputSchema.safeParse(value);
  if (!parsed.success)
    return {
      contractVersion: 1,
      status: "fail",
      inputReasons: [
        ...new Set(
          parsed.error.issues.map((issue) =>
            sanitizeReason(
              `${issue.path.map(String).join(".") || "input"}:${issue.message}`,
            ),
          ),
        ),
      ]
        .sort()
        .slice(0, 1_000),
      gateResults: [],
    };

  const input = parsed.data;
  const inputReasons: string[] = [];
  if (!referenceEqual(input.policyReference, input.evidence.policy))
    inputReasons.push("policy-reference-mismatch");
  if (
    !referenceEqual(input.registryReference, input.policy.registry) ||
    !referenceEqual(input.registryReference, input.evidence.registry)
  )
    inputReasons.push("registry-reference-mismatch");
  if (
    !referenceEqual(input.fixtureReference, input.policy.fixtures) ||
    !referenceEqual(input.fixtureReference, input.evidence.fixtures)
  )
    inputReasons.push("fixture-reference-mismatch");
  if (
    !referenceEqual(input.benchmarkReference, input.policy.benchmarks) ||
    !referenceEqual(input.benchmarkReference, input.evidence.benchmarks)
  )
    inputReasons.push("benchmark-reference-mismatch");
  if (
    !referenceEqual(input.dependencyReference, input.policy.dependencies) ||
    !referenceEqual(input.dependencyReference, input.evidence.dependencies)
  )
    inputReasons.push("dependency-reference-mismatch");
  if (
    !adapterEqual(
      input.policy.subject.adapter,
      input.evidence.subject.adapter,
    ) ||
    input.policy.subject.artifactDigest.value !==
      input.evidence.subject.artifactDigest.value
  )
    inputReasons.push("release-subject-mismatch");

  const adapter = input.registry.adapters.find((candidate) =>
    adapterEqual(candidate, input.policy.subject.adapter),
  );
  if (!adapter) inputReasons.push("release-adapter-not-registered");
  if (!adapterEqual(input.dependencies.adapter, input.policy.subject.adapter))
    inputReasons.push("dependency-adapter-mismatch");
  if (
    adapter &&
    !referenceEqual(adapter.dependencyInventory, input.policy.dependencies)
  )
    inputReasons.push("dependency-inventory-reference-mismatch");
  if (adapter) {
    const formatIds = adapter.formats.map(({ formatId }) => String(formatId));
    const hasRequiredCapabilityGate = (
      capability: Extract<
        ReleaseGate,
        { kind: "capability-evidence" }
      >["capability"],
    ) =>
      input.policy.gates.some(
        (gate) =>
          gate.kind === "capability-evidence" &&
          gate.required &&
          gate.capability === capability,
      );
    if (formatIds.includes("step") && !hasRequiredCapabilityGate("native-step"))
      inputReasons.push("missing-native-step-gate");
    if (
      formatIds.includes("3mf") &&
      adapter.capabilities.archiveCompression ===
        "bounded-compressed-evidence-required" &&
      !hasRequiredCapabilityGate("bounded-compressed-3mf")
    )
      inputReasons.push("missing-compressed-3mf-gate");
    if (
      adapter.capabilities.externalResources === "resolve" &&
      !hasRequiredCapabilityGate("external-resource-resolution")
    )
      inputReasons.push("missing-external-resource-gate");
  }

  const requiredFixtureCaseIds = input.policy.gates.flatMap((gate) =>
    gate.kind === "fixture-cases" && gate.required ? gate.caseIds : [],
  );
  const requiredFixtureAssetIds = new Set(
    requiredFixtureCaseIds.flatMap((caseId) => {
      const fixture = input.fixtures.cases.find(({ id }) => id === caseId);
      return fixture ? [fixture.assetId] : [];
    }),
  );
  const licensedFixtureAssetIds = new Set(
    input.policy.gates.flatMap((gate) =>
      gate.kind === "fixture-licenses" && gate.required ? gate.assetIds : [],
    ),
  );
  if (
    [...requiredFixtureAssetIds].some(
      (assetId) => !licensedFixtureAssetIds.has(assetId),
    )
  )
    inputReasons.push("fixture-license-gate-incomplete");

  const componentIds = new Set(
    input.dependencies.components.map(({ id }) => id),
  );
  const licensedComponentIds = new Set(
    input.policy.gates.flatMap((gate) =>
      gate.kind === "dependency-licenses" && gate.required
        ? gate.componentIds
        : [],
    ),
  );
  if (
    componentIds.size !== licensedComponentIds.size ||
    [...componentIds].some(
      (componentId) => !licensedComponentIds.has(componentId),
    )
  )
    inputReasons.push("dependency-license-gate-incomplete");

  const gateIds = new Set(input.policy.gates.map(({ id }) => id));
  if (input.evidence.observations.some(({ gateId }) => !gateIds.has(gateId)))
    inputReasons.push("unknown-gate-observation");

  const gateResults = [...input.policy.gates]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((gate) =>
      evaluateGate(
        gate,
        input.evidence.observations.find(({ gateId }) => gateId === gate.id),
        input,
        adapter,
      ),
    );
  const stableInputReasons = [...new Set(inputReasons)].sort();
  const failedRequired = gateResults.some(
    (gate) => gate.required && !gate.passed,
  );
  return {
    contractVersion: 1,
    status:
      stableInputReasons.length === 0 && !failedRequired ? "pass" : "fail",
    inputReasons: stableInputReasons,
    gateResults,
  };
}
