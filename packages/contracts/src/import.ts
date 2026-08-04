import { z } from "zod";
import { normalizedModelSchema, warningSchema } from "./geometry.js";
import {
  entityIdSchema,
  modelIdSchema,
  resolvedSourceAxisSchema,
  resolvedSourceUnitSchema,
} from "./primitives.js";

export const formatIdSchema = entityIdSchema.brand<"FormatId">();
export type FormatId = z.infer<typeof formatIdSchema>;

export const importLimitsSchema = z.strictObject({
  inputBytes: z.number().int().safe().positive(),
  triangleCount: z.number().int().safe().positive(),
  archive: z
    .strictObject({
      entryCount: z.number().int().safe().positive(),
      entryBytes: z.number().int().safe().positive(),
      expandedBytes: z.number().int().safe().positive(),
      compressionRatio: z.number().finite().positive(),
    })
    .optional(),
});
export type ImportLimits = z.infer<typeof importLimitsSchema>;

export const importOptionsSchema = z
  .strictObject({
    declaredUnit: resolvedSourceUnitSchema.optional(),
    declaredAxis: resolvedSourceAxisSchema.optional(),
    userUnit: resolvedSourceUnitSchema.optional(),
    userAxis: resolvedSourceAxisSchema.optional(),
    limits: importLimitsSchema,
  })
  .superRefine((options, context) => {
    if (options.declaredUnit && options.userUnit)
      context.addIssue({
        code: "custom",
        path: ["userUnit"],
        message: "Unit resolution must have one request source",
      });
    if (options.declaredAxis && options.userAxis)
      context.addIssue({
        code: "custom",
        path: ["userAxis"],
        message: "Axis resolution must have one request source",
      });
  });
export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const importerDescriptorSchema = z.strictObject({
  id: entityIdSchema,
  version: z.string().min(1).max(128),
  formats: z.array(formatIdSchema).min(1).max(128),
  mediaTypes: z.array(z.string().min(1).max(255)).max(128),
  extensions: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u))
    .max(128),
  capabilities: z.strictObject({
    assemblies: z.boolean(),
    tessellationProvenance: z.boolean(),
    externalResources: z.boolean(),
  }),
});
export type ImporterDescriptor = z.infer<typeof importerDescriptorSchema>;

export const importRequestSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    targetModelId: modelIdSchema,
    format: formatIdSchema,
    sourceName: z.string().min(1).max(1_024),
    bytes: z
      .instanceof(Uint8Array)
      .refine(
        (bytes) =>
          bytes.buffer instanceof ArrayBuffer &&
          bytes.buffer.byteLength > 0 &&
          bytes.byteOffset === 0 &&
          bytes.byteLength === bytes.buffer.byteLength,
        "Input must own one complete transferable ArrayBuffer",
      ),
    options: importOptionsSchema,
  })
  .refine(
    (request) => request.bytes.byteLength <= request.options.limits.inputBytes,
    {
      path: ["bytes"],
      message: "Input exceeds the caller-provided byte limit",
    },
  );
export type ImportRequest = z.infer<typeof importRequestSchema>;

export const importFailureCodeSchema = z.enum([
  "invalid-input",
  "unsupported-input",
  "unsafe-archive",
  "resource-limit",
  "needs-input",
]);

export const importResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    contractVersion: z.literal(1),
    ok: z.literal(true),
    model: normalizedModelSchema,
  }),
  z.strictObject({
    contractVersion: z.literal(1),
    ok: z.literal(false),
    code: importFailureCodeSchema,
    message: z.string().min(1).max(2_000),
    warnings: z.array(warningSchema).max(10_000),
  }),
]);
export type ImportResult = z.infer<typeof importResultSchema>;

export const importExchangeSchema = z
  .strictObject({ request: importRequestSchema, result: importResultSchema })
  .superRefine(({ request, result }, context) => {
    if (!result.ok) return;
    if (result.model.id !== request.targetModelId) {
      context.addIssue({
        code: "custom",
        path: ["result", "model", "id"],
        message: "Imported model ID must match the request target",
      });
    }
    const provenance = result.model.provenance;
    if (
      provenance.formatId !== request.format ||
      provenance.sourceName !== request.sourceName
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "model", "provenance"],
        message: "Imported format and source name must match the request",
      });
    }
    const requestedUnitResolution = request.options.userUnit
      ? { origin: "user", value: request.options.userUnit }
      : request.options.declaredUnit
        ? { origin: "declared", value: request.options.declaredUnit }
        : { origin: "embedded", value: provenance.detectedSourceUnit };
    const requestedAxisResolution = request.options.userAxis
      ? { origin: "user", value: request.options.userAxis }
      : request.options.declaredAxis
        ? { origin: "declared", value: request.options.declaredAxis }
        : { origin: "embedded", value: provenance.detectedSourceAxis };
    if (
      requestedUnitResolution.origin !== provenance.sourceResolution.unit ||
      requestedUnitResolution.value !== provenance.sourceUnit
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "model", "provenance", "sourceUnit"],
        message: "Source unit must match its request resolution",
      });
    }
    if (
      requestedAxisResolution.origin !== provenance.sourceResolution.axis ||
      requestedAxisResolution.value !== provenance.sourceAxis
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "model", "provenance", "sourceAxis"],
        message: "Source axis must match its request resolution",
      });
    }
    let triangles = 0;
    for (const mesh of result.model.meshes) {
      triangles += mesh.geometry.indices.length / 3;
      if (triangles > request.options.limits.triangleCount) break;
    }
    if (triangles > request.options.limits.triangleCount) {
      context.addIssue({
        code: "custom",
        path: ["result", "model", "meshes"],
        message: "Imported geometry exceeds the caller-provided triangle limit",
      });
    }
  });
