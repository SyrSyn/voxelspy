import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  importExchangeSchema,
  importRequestSchema,
  importResultSchema,
  importerDescriptorSchema,
  instanceIdSchema,
  meshIdSchema,
  normalizedModelSchema,
  warningSchema,
  type ContractWarning,
  type ImportRequest,
  type ImportResult,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { UnsupportedInputError } from "./errors.js";
import {
  normalizePositions,
  countDegenerateTriangles,
  sourceToModelTransform,
  type ResolvedSourceAxis,
  type ResolvedSourceUnit,
} from "./normalize.js";
import { parseObj } from "./obj.js";
import type { ParsedMesh } from "./parse.js";
import { parseStl } from "./stl.js";

export {
  exportModel,
  formatNumber,
  EXPORTER_SAFETY_LIMITS,
  type ExportFormat,
  type ExportGeometryCounts,
  type ExportOptions,
  type ExportResult,
} from "./export.js";
export {
  ExportInputError,
  ExportResourceLimitError,
  ExportUnsupportedTargetError,
  UnsupportedInputError,
} from "./errors.js";

export const IMPORTER_SAFETY_LIMITS = Object.freeze({
  inputBytes: 32 * 1024 * 1024,
  triangleCount: 500_000,
  vertexCount: 1_500_000,
});

export const importerDescriptor = importerDescriptorSchema.parse({
  id: "voxelspy.mesh",
  version: "0.1.0",
  formats: ["stl", "obj"],
  mediaTypes: ["model/stl", "application/sla", "model/obj", "text/plain"],
  extensions: ["stl", "obj"],
  capabilities: {
    assemblies: false,
    tessellationProvenance: false,
    externalResources: false,
  },
});

interface ResolvedFrame {
  readonly unit: ResolvedSourceUnit;
  readonly axis: ResolvedSourceAxis;
  readonly unitOrigin: "declared" | "user";
  readonly axisOrigin: "declared" | "user";
}

type ImportFailureCode =
  | "invalid-input"
  | "unsupported-input"
  | "unsafe-archive"
  | "resource-limit"
  | "needs-input";

export async function importModel(input: unknown): Promise<ImportResult> {
  const parsed = importRequestSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid-input",
      "Import request did not satisfy the public contract.",
    );
  }
  const request = parsed.data;
  if (request.bytes.byteLength > IMPORTER_SAFETY_LIMITS.inputBytes) {
    return failure(
      "resource-limit",
      "Input exceeds the importer byte safety limit.",
    );
  }
  if (request.format !== "stl" && request.format !== "obj") {
    return failure(
      "unsupported-input",
      `Format ${request.format} is not supported.`,
    );
  }

  const frame = resolveFrame(request);
  if ("result" in frame) return frame.result;

  try {
    const parsedMesh =
      request.format === "stl"
        ? parseStl(
            request.bytes,
            request.options.limits.triangleCount,
            IMPORTER_SAFETY_LIMITS.triangleCount,
          )
        : parseObj(
            request.bytes,
            request.options.limits.triangleCount,
            IMPORTER_SAFETY_LIMITS.triangleCount,
            IMPORTER_SAFETY_LIMITS.vertexCount,
          );
    const model = await createModel(request, frame, parsedMesh);
    const result = importResultSchema.parse({
      contractVersion: 1,
      ok: true,
      model,
    });
    return importExchangeSchema.parse({ request, result }).result;
  } catch (error) {
    if (error instanceof RangeError) {
      return failure("resource-limit", error.message);
    }
    if (error instanceof TypeError) {
      return failure("invalid-input", error.message);
    }
    if (error instanceof UnsupportedInputError) {
      return failure("unsupported-input", error.message);
    }
    return failure("invalid-input", "Input could not be imported safely.");
  }
}

export function inferFormat(sourceName: string): "stl" | "obj" | undefined {
  const extension = /\.([^.]+)$/u.exec(sourceName)?.[1]?.toLowerCase();
  return extension === "stl" || extension === "obj" ? extension : undefined;
}

function resolveFrame(
  request: ImportRequest,
): ResolvedFrame | { readonly result: ImportResult } {
  const unit = request.options.userUnit ?? request.options.declaredUnit;
  const axis = request.options.userAxis ?? request.options.declaredAxis;
  const warnings: ContractWarning[] = [];
  if (!unit) {
    warnings.push(
      warning({
        code: "source-unit-required",
        severity: "warning",
        message: `${request.format.toUpperCase()} does not provide an authoritative source unit.`,
      }),
    );
  }
  if (!axis) {
    warnings.push(
      warning({
        code: "source-axis-required",
        severity: "warning",
        message: `${request.format.toUpperCase()} does not provide an authoritative source axis.`,
      }),
    );
  }
  if (!unit || !axis) {
    return {
      result: failure(
        "needs-input",
        "Choose the source unit and up-axis before importing this format.",
        warnings,
      ),
    };
  }
  return {
    unit,
    axis,
    unitOrigin: request.options.userUnit ? "user" : "declared",
    axisOrigin: request.options.userAxis ? "user" : "declared",
  };
}

async function createModel(
  request: ImportRequest,
  frame: ResolvedFrame,
  parsed: ParsedMesh,
): Promise<NormalizedModel> {
  const positions = normalizePositions(
    parsed.positions,
    frame.unit,
    frame.axis,
  );
  const warnings: ContractWarning[] = [];
  const degenerateCount = countDegenerateTriangles(positions, parsed.indices);
  if (degenerateCount > 0) {
    warnings.push(
      warning({
        code: "degenerate-triangles",
        severity: "warning",
        message: `${degenerateCount} degenerate triangle(s) were preserved without repair.`,
        details: { count: degenerateCount },
      }),
    );
  }
  if ((parsed.polygonCount ?? 0) > 0) {
    warnings.push(
      warning({
        code: "polygon-fan-triangulation",
        severity: "warning",
        message: `${parsed.polygonCount} polygon face(s) were fan-triangulated in source order.`,
        details: { count: parsed.polygonCount ?? 0 },
      }),
    );
  }
  if ((parsed.ignoredDirectives?.length ?? 0) > 0) {
    warnings.push(
      warning({
        code: "obj-data-not-evaluated",
        severity: "info",
        message: "Non-geometric OBJ records were not evaluated.",
        details: { directives: [...(parsed.ignoredDirectives ?? [])] },
      }),
    );
  }
  if ((parsed.mergedSolidCount ?? 0) > 1) {
    warnings.push(
      warning({
        code: "stl-multiple-solids-merged",
        severity: "info",
        message: `${parsed.mergedSolidCount} STL solid blocks were merged into a single mesh.`,
        details: { count: parsed.mergedSolidCount ?? 0 },
      }),
    );
  }
  if (frame.unitOrigin === "user" || frame.axisOrigin === "user") {
    warnings.push(
      warning({
        code: "user-source-frame",
        severity: "info",
        message:
          "A user-selected source frame correction was applied and recorded in provenance.",
      }),
    );
  }

  const meshId = meshIdSchema.parse(
    availableId("mesh.imported", request.targetModelId),
  );
  const instanceId = instanceIdSchema.parse(
    availableId("instance.imported", request.targetModelId, meshId),
  );
  const model = {
    contractVersion: 1 as const,
    id: request.targetModelId,
    frame: CANONICAL_FRAME,
    meshes: [{ id: meshId, geometry: { positions, indices: parsed.indices } }],
    placement: {
      kind: "flat" as const,
      instances: [{ id: instanceId, meshId, meshToModel: IDENTITY_MAT4 }],
    },
    warnings,
    provenance: {
      formatId: request.format,
      importerId: importerDescriptor.id,
      importerVersion: importerDescriptor.version,
      sourceName: request.sourceName,
      sourceDigest: await sha256(request.bytes),
      detectedSourceUnit: "unknown" as const,
      detectedSourceAxis: "unknown" as const,
      sourceUnit: frame.unit,
      sourceAxis: frame.axis,
      sourceResolution: { unit: frame.unitOrigin, axis: frame.axisOrigin },
      appliedSourceToModel: sourceToModelTransform(frame.unit, frame.axis),
      notes: parsed.notes,
    },
  };
  return normalizedModelSchema.parse(model);
}

function availableId(
  candidate: string,
  ...excluded: readonly string[]
): string {
  if (!excluded.includes(candidate)) return candidate;
  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const next = `${candidate}.${suffix}`;
    if (!excluded.includes(next)) return next;
  }
  throw new TypeError("Could not allocate a collision-free geometry ID");
}

async function sha256(bytes: Uint8Array) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  const value = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { algorithm: "sha256" as const, value };
}

function failure(
  code: ImportFailureCode,
  message: string,
  warnings: ContractWarning[] = [],
): ImportResult {
  return importResultSchema.parse({
    contractVersion: 1,
    ok: false,
    code,
    message,
    warnings,
  });
}

function warning(value: {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}): ContractWarning {
  return warningSchema.parse(value);
}
