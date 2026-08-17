import { z } from "zod";
import {
  canonicalInstantSchema,
  portableResourcePathSchema,
  reportSchema,
} from "./report.js";
import {
  modelIdSchema,
  reportIdSchema,
  sha256DigestSchema,
} from "./primitives.js";

const mediaTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu);
const resourceShape = {
  bytes: z.number().int().safe().positive(),
  digest: sha256DigestSchema,
};

export const sessionEntrySchema = z.discriminatedUnion("role", [
  z.strictObject({
    ...resourceShape,
    role: z.literal("report"),
    path: z.literal("report.json"),
    mediaType: z.literal("application/json"),
  }),
  z.strictObject({
    ...resourceShape,
    role: z.literal("source-model"),
    modelId: modelIdSchema,
    modelRole: z.enum(["baseline", "candidate"]),
    path: portableResourcePathSchema.refine(
      (path) => path.startsWith("models/"),
      "Source models must use the models/ resource namespace",
    ),
    mediaType: mediaTypeSchema,
  }),
]);
export type SessionEntry = z.infer<typeof sessionEntrySchema>;

export const sessionManifestSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    reportId: reportIdSchema,
    kind: z.literal("voxelspy-session"),
    contentPolicy: z.literal("self-contained-source-models"),
    createdAt: canonicalInstantSchema,
    reportPath: z.literal("report.json"),
    entries: z.array(sessionEntrySchema).length(3),
  })
  .superRefine((manifest, context) => {
    const paths = manifest.entries.map(({ path }) => path);
    if (new Set(paths).size !== paths.length)
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Session entry paths must be unique",
      });
    if (paths.some((path) => path === "manifest.json"))
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "The manifest cannot list itself as a payload entry",
      });
    if (paths.some((path, index) => index > 0 && paths[index - 1]! >= path))
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message:
          "Session entries must use strictly sorted canonical path order",
      });
    const reports = manifest.entries.filter(({ role }) => role === "report");
    if (
      reports.length !== 1 ||
      reports[0]?.path !== manifest.reportPath ||
      reports[0]?.mediaType !== "application/json"
    )
      context.addIssue({
        code: "custom",
        path: ["reportPath"],
        message: "Session manifest must identify one JSON report entry",
      });
    const sourceEntries = manifest.entries.flatMap((entry) =>
      entry.role === "source-model" ? [entry] : [],
    );
    if (
      sourceEntries.length !== 2 ||
      new Set(sourceEntries.map(({ modelId }) => modelId)).size !== 2 ||
      new Set(sourceEntries.map(({ modelRole }) => modelRole)).size !== 2
    )
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Session manifest requires one source for each model role",
      });
  });
export type SessionManifest = z.infer<typeof sessionManifestSchema>;

export const sessionBundleSchema = z
  .strictObject({
    manifest: sessionManifestSchema,
    manifestDigest: sha256DigestSchema,
    reportDigest: sha256DigestSchema,
    report: reportSchema,
  })
  .superRefine(({ manifest, reportDigest, report }, context) => {
    if (manifest.reportId !== report.id)
      context.addIssue({
        code: "custom",
        path: ["manifest", "reportId"],
        message: "Session report ID must match its manifest",
      });
    const entries = new Map(
      manifest.entries.map((entry) => [entry.path, entry]),
    );
    const reportEntry = entries.get(manifest.reportPath);
    if (
      !reportEntry ||
      reportEntry.role !== "report" ||
      reportEntry.digest.value !== reportDigest.value
    )
      context.addIssue({
        code: "custom",
        path: ["reportDigest"],
        message:
          "Parsed report provenance must match the manifest report digest",
      });
    report.models.forEach((model, index) => {
      const entry = entries.get(model.sourcePath);
      if (
        !entry ||
        entry.role !== "source-model" ||
        entry.modelId !== model.modelId ||
        entry.modelRole !== model.role ||
        entry.mediaType !== model.sourceMediaType ||
        entry.digest.value !== model.sourceDigest.value
      )
        context.addIssue({
          code: "custom",
          path: ["report", "models", index, "sourcePath"],
          message: "Report source model must match a manifest entry",
        });
    });
    const modelPaths = new Set(
      report.models.map(({ sourcePath }) => sourcePath),
    );
    manifest.entries.forEach((entry, index) => {
      if (entry.role === "source-model" && !modelPaths.has(entry.path))
        context.addIssue({
          code: "custom",
          path: ["manifest", "entries", index],
          message: "Typed manifest entries must be referenced by the report",
        });
    });
  });
export type SessionBundle = z.infer<typeof sessionBundleSchema>;

export const sessionArchiveLimitsSchema = z
  .strictObject({
    maxArchiveBytes: z.number().int().safe().positive(),
    maxEntries: z.number().int().safe().positive(),
    maxEntryBytes: z.number().int().safe().positive(),
    maxTotalExpandedBytes: z.number().int().safe().positive(),
    maxCompressionRatio: z.number().finite().positive(),
    maxManifestBytes: z.number().int().safe().positive(),
    maxReportBytes: z.number().int().safe().positive(),
  })
  .refine(
    (limits) =>
      limits.maxManifestBytes <= limits.maxEntryBytes &&
      limits.maxReportBytes <= limits.maxEntryBytes,
    "Structured entry limits cannot exceed the general entry limit",
  );
export type SessionArchiveLimits = z.infer<typeof sessionArchiveLimitsSchema>;

export const sessionArchivePreflightSchema = z.strictObject({
  archiveBytes: z.number().int().safe().nonnegative(),
  entries: z
    .array(
      z.strictObject({
        path: portableResourcePathSchema,
        compressedBytes: z.number().int().safe().nonnegative(),
        expandedBytes: z.number().int().safe().nonnegative(),
        compression: z.enum(["stored", "deflate"]),
        encrypted: z.literal(false),
      }),
    )
    .max(10_000),
});

export const sessionResourceVerificationSchema = z.strictObject({
  path: portableResourcePathSchema,
  bytes: z.number().int().safe().positive(),
  digest: sha256DigestSchema,
});

export const sessionLoadRequestSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    bytes: z
      .instanceof(Uint8Array)
      .refine(
        (bytes) =>
          bytes.buffer instanceof ArrayBuffer &&
          bytes.buffer.byteLength > 0 &&
          bytes.byteOffset === 0 &&
          bytes.byteLength === bytes.buffer.byteLength,
        "Session input must own one complete transferable ArrayBuffer",
      ),
    limits: sessionArchiveLimitsSchema,
  })
  .superRefine(({ bytes, limits }, context) => {
    if (bytes.byteLength > limits.maxArchiveBytes)
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "Session input exceeds its compressed-byte limit",
      });
  });

export const sessionPreflightExchangeSchema = z
  .strictObject({
    limits: sessionArchiveLimitsSchema,
    preflight: sessionArchivePreflightSchema,
  })
  .superRefine(({ limits, preflight }, context) => {
    if (preflight.archiveBytes > limits.maxArchiveBytes)
      context.addIssue({
        code: "custom",
        path: ["preflight", "archiveBytes"],
        message: "Session archive exceeds its compressed-byte limit",
      });
    if (preflight.entries.length > limits.maxEntries)
      context.addIssue({
        code: "custom",
        path: ["preflight", "entries"],
        message: "Session archive exceeds its entry-count limit",
      });
    const paths = preflight.entries.map(({ path }) => path);
    if (new Set(paths).size !== paths.length)
      context.addIssue({
        code: "custom",
        path: ["preflight", "entries"],
        message: "Archive preflight paths must be unique",
      });
    if (
      preflight.entries.filter(({ path }) => path === "manifest.json")
        .length !== 1
    )
      context.addIssue({
        code: "custom",
        path: ["preflight", "entries"],
        message: "Session archive must contain exactly one manifest.json entry",
      });
    let totalCompressed = 0;
    let totalExpanded = 0;
    preflight.entries.forEach((entry, index) => {
      totalCompressed += entry.compressedBytes;
      totalExpanded += entry.expandedBytes;
      if (
        entry.compression === "stored" &&
        entry.compressedBytes !== entry.expandedBytes
      )
        context.addIssue({
          code: "custom",
          path: ["preflight", "entries", index],
          message:
            "Stored entries must have equal compressed and expanded sizes",
        });
      if (entry.expandedBytes > 0 && entry.compressedBytes === 0)
        context.addIssue({
          code: "custom",
          path: ["preflight", "entries", index, "compressedBytes"],
          message: "A nonempty entry cannot have zero compressed bytes",
        });
      if (entry.expandedBytes > limits.maxEntryBytes)
        context.addIssue({
          code: "custom",
          path: ["preflight", "entries", index, "expandedBytes"],
          message: "Session entry exceeds its expanded-byte limit",
        });
      if (
        entry.expandedBytes / Math.max(1, entry.compressedBytes) >
        limits.maxCompressionRatio
      )
        context.addIssue({
          code: "custom",
          path: ["preflight", "entries", index],
          message: "Session entry exceeds its compression-ratio limit",
        });
      const namedLimit =
        entry.path === "manifest.json"
          ? limits.maxManifestBytes
          : entry.path === "report.json"
            ? limits.maxReportBytes
            : undefined;
      if (namedLimit !== undefined && entry.expandedBytes > namedLimit)
        context.addIssue({
          code: "custom",
          path: ["preflight", "entries", index, "expandedBytes"],
          message: "Structured session entry exceeds its dedicated limit",
        });
    });
    if (
      !Number.isSafeInteger(totalExpanded) ||
      totalExpanded > limits.maxTotalExpandedBytes
    )
      context.addIssue({
        code: "custom",
        path: ["preflight", "entries"],
        message: "Session archive exceeds its total expanded-byte limit",
      });
    if (
      !Number.isSafeInteger(totalCompressed) ||
      totalCompressed > preflight.archiveBytes
    )
      context.addIssue({
        code: "custom",
        path: ["preflight", "entries"],
        message: "Compressed entry bytes cannot exceed the archive size",
      });
  });

export const sessionArchiveExchangeSchema = z
  .strictObject({
    request: sessionLoadRequestSchema,
    preflight: sessionArchivePreflightSchema,
    bundle: sessionBundleSchema,
    verifiedResources: z
      .array(sessionResourceVerificationSchema)
      .min(1)
      .max(10_000),
  })
  .superRefine(({ request, preflight, bundle, verifiedResources }, context) => {
    const policyResult = sessionPreflightExchangeSchema.safeParse({
      limits: request.limits,
      preflight,
    });
    if (!policyResult.success)
      context.addIssue({
        code: "custom",
        path: ["preflight"],
        message: "Archive preflight does not satisfy the caller limits",
      });
    if (request.bytes.byteLength !== preflight.archiveBytes)
      context.addIssue({
        code: "custom",
        path: ["preflight", "archiveBytes"],
        message: "Observed archive bytes must match the transferred input",
      });
    const expectedPaths = new Set([
      "manifest.json",
      ...bundle.manifest.entries.map(({ path }) => path),
    ]);
    const observedPaths = new Set(preflight.entries.map(({ path }) => path));
    if (
      expectedPaths.size !== observedPaths.size ||
      [...expectedPaths].some((path) => !observedPaths.has(path))
    )
      context.addIssue({
        code: "custom",
        path: ["preflight", "entries"],
        message:
          "Archive contents must exactly match manifest.json and its entries",
      });
    const verifiedPaths = verifiedResources.map(({ path }) => path);
    if (
      new Set(verifiedPaths).size !== verifiedPaths.length ||
      expectedPaths.size !== verifiedPaths.length ||
      verifiedPaths.some((path) => !expectedPaths.has(path))
    )
      context.addIssue({
        code: "custom",
        path: ["verifiedResources"],
        message: "Verified resources must exactly cover the archive contents",
      });
    // Keep the first match per path (matching the .find() semantics this
    // replaces) in case duplicate paths ever reach this refinement.
    const preflightByPath = new Map<
      string,
      (typeof preflight.entries)[number]
    >();
    for (const entry of preflight.entries)
      if (!preflightByPath.has(entry.path))
        preflightByPath.set(entry.path, entry);
    const verifiedByPath = new Map<
      string,
      (typeof verifiedResources)[number]
    >();
    for (const verified of verifiedResources)
      if (!verifiedByPath.has(verified.path))
        verifiedByPath.set(verified.path, verified);
    verifiedResources.forEach((verified, index) => {
      const observed = preflightByPath.get(verified.path);
      if (!observed || observed.expandedBytes !== verified.bytes)
        context.addIssue({
          code: "custom",
          path: ["verifiedResources", index, "bytes"],
          message: "Verified resource bytes must match archive observations",
        });
    });
    const verifiedManifest = verifiedByPath.get("manifest.json");
    if (
      !verifiedManifest ||
      verifiedManifest.digest.value !== bundle.manifestDigest.value
    )
      context.addIssue({
        code: "custom",
        path: ["bundle", "manifestDigest"],
        message:
          "Parsed manifest provenance must match verified manifest bytes",
      });
    bundle.manifest.entries.forEach((entry, index) => {
      const observed = preflightByPath.get(entry.path);
      if (!observed || observed.expandedBytes !== entry.bytes)
        context.addIssue({
          code: "custom",
          path: ["bundle", "manifest", "entries", index, "bytes"],
          message: "Manifest byte counts must match archive observations",
        });
      const verified = verifiedByPath.get(entry.path);
      if (
        !verified ||
        verified.bytes !== entry.bytes ||
        verified.digest.value !== entry.digest.value
      )
        context.addIssue({
          code: "custom",
          path: ["verifiedResources"],
          message: "Verified payload sizes and digests must match the manifest",
        });
    });
  });
