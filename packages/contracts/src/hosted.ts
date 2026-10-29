import { z } from "zod";
import { geometryProvenanceSchema } from "./geometry.js";
import {
  resolvedSourceAxisSchema,
  resolvedSourceUnitSchema,
} from "./primitives.js";

/** Optional same-origin parent bridge. This carries no authentication authority. */
export const hostedToolSchema = z.enum([
  "compare",
  "inspect",
  "mesh-health",
  "measure-section",
  "clearance-fit",
  "printability",
  "file-forensics",
  "convert",
]);
export type HostedTool = z.infer<typeof hostedToolSchema>;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !/[\\/\u0000-\u001f\u007f]/u.test(value),
    "Expected a portable file name",
  );
const buffer = (maximum: number) =>
  z
    .instanceof(ArrayBuffer)
    .refine(
      (bytes) => bytes.byteLength > 0 && bytes.byteLength <= maximum,
      "Buffer exceeds its bounded domain",
    );
export const HOSTED_LIMITS = {
  sourceBytes: 32 * 1024 * 1024,
  evidenceBytes: 8 * 1024 * 1024,
  reportBytes: 32 * 1024 * 1024,
  convertedBytes: 32 * 1024 * 1024,
  sessionBytes: 192 * 1024 * 1024,
} as const;
export const hostedSourceSchema = z
  .strictObject({
    revisionId: identifier,
    digest,
    name,
    bytes: buffer(HOSTED_LIMITS.sourceBytes),
    provenance: geometryProvenanceSchema,
  })
  .superRefine((source, context) => {
    if (
      source.provenance.sourceName !== source.name ||
      source.provenance.sourceDigest?.value !== source.digest
    )
      context.addIssue({
        code: "custom",
        message:
          "Revision bytes and recorded provenance must identify the same source",
      });
  });
export const hostedLoadSchema = z
  .strictObject({
    type: z.literal("voxelspy:load"),
    version: z.literal(1),
    requestId: identifier,
    sources: z.array(hostedSourceSchema).min(1).max(2),
    session: buffer(HOSTED_LIMITS.sessionBytes).optional(),
  })
  .superRefine((load, context) => {
    if (
      new Set(load.sources.map((source) => source.revisionId)).size !==
      load.sources.length
    )
      context.addIssue({
        code: "custom",
        message: "Revision identities must be unique",
      });
  });
export type HostedLoad = z.infer<typeof hostedLoadSchema>;
export const hostedReadySchema = z.strictObject({
  type: z.literal("voxelspy:ready"),
  version: z.literal(1),
});
export const hostedExportSchema = z.strictObject({
  format: z.enum(["stl-binary", "stl-ascii", "obj", "gltf", "glb", "3mf"]),
  targetUnit: resolvedSourceUnitSchema,
  targetAxis: resolvedSourceAxisSchema,
});
export const hostedArtifactSchema = z
  .strictObject({
    type: z.literal("voxelspy:artifact"),
    version: z.literal(1),
    requestId: identifier,
    artifactId: identifier,
    tool: hostedToolSchema,
    kind: z.enum([
      "evidence-json",
      "comparison-session",
      "report-html",
      "converted-model",
    ]),
    name,
    mime: z.string().min(1).max(127),
    bytes: buffer(HOSTED_LIMITS.sessionBytes),
    revisionIds: z.array(identifier).min(1).max(2),
    metadata: z.strictObject({ export: hostedExportSchema }).optional(),
  })
  .superRefine((artifact, context) => {
    const limit =
      artifact.kind === "comparison-session"
        ? HOSTED_LIMITS.sessionBytes
        : artifact.kind === "converted-model"
          ? HOSTED_LIMITS.convertedBytes
          : artifact.kind === "report-html"
            ? HOSTED_LIMITS.reportBytes
            : HOSTED_LIMITS.evidenceBytes;
    const validMime =
      artifact.kind === "evidence-json"
        ? artifact.mime === "application/json"
        : artifact.kind === "comparison-session"
          ? artifact.mime === "application/zip"
          : artifact.kind === "report-html"
            ? artifact.mime === "text/html"
            : [
                "model/stl",
                "model/obj",
                "text/plain",
                "model/gltf+json",
                "model/gltf-binary",
                "model/3mf",
                "application/octet-stream",
              ].includes(artifact.mime);
    if (
      artifact.bytes.byteLength > limit ||
      !validMime ||
      (artifact.kind === "converted-model") !==
        (artifact.metadata !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Artifact bytes, media type or metadata do not match its kind",
      });
    if (new Set(artifact.revisionIds).size !== artifact.revisionIds.length)
      context.addIssue({
        code: "custom",
        message: "Revision identities must be unique",
      });
    if (
      ((artifact.kind === "comparison-session" ||
        artifact.kind === "report-html") &&
        artifact.tool !== "compare") ||
      (artifact.kind === "converted-model" && artifact.tool !== "convert")
    )
      context.addIssue({
        code: "custom",
        message: "Artifact kind is not supported by this tool",
      });
  });
export type HostedArtifact = z.infer<typeof hostedArtifactSchema>;

/** Hosted evidence keeps its native payload but binds the exact loaded revision sources. */
export const hostedEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("tool-evidence"),
  tool: hostedToolSchema,
  sources: z
    .array(
      z.strictObject({ name, digest, provenance: geometryProvenanceSchema }),
    )
    .min(1)
    .max(2),
  evidence: z.record(z.string(), z.unknown()),
});
export type HostedEvidence = z.infer<typeof hostedEvidenceSchema>;
