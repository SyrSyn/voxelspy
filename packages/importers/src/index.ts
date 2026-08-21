import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  importExchangeSchema,
  importRequestSchema,
  importResultSchema,
  importerDescriptorSchema,
  instanceIdSchema,
  meshIdSchema,
  nodeIdSchema,
  normalizedModelSchema,
  warningSchema,
  type ContractWarning,
  type ImportRequest,
  type ImportResult,
  type NormalizedModel,
  type SourceAxis,
  type SourceUnit,
} from "@voxelspy/contracts";
import { UnsafeArchiveError, UnsupportedInputError } from "./errors.js";
import { parseGltf, type ParsedGltf } from "./gltf.js";
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
import { parseThreeMf, type ParsedThreeMf } from "./threemf.js";
import type { ArchiveSafetyLimits } from "./zip.js";

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
  UnsafeArchiveError,
  UnsupportedInputError,
} from "./errors.js";

export const IMPORTER_SAFETY_LIMITS = Object.freeze({
  inputBytes: 32 * 1024 * 1024,
  triangleCount: 500_000,
  vertexCount: 1_500_000,
  // Fixed 3MF (ZIP/OPC) container ceilings, applied on top of (never
  // loosened by) any caller-supplied `options.limits.archive` -- see
  // `mergeArchiveLimits` below and the README's "3MF decompression bounds"
  // section for what each field guards against.
  archive: Object.freeze({
    entryCount: 512,
    entryBytes: 64 * 1024 * 1024,
    expandedBytes: 128 * 1024 * 1024,
    compressionRatio: 300,
  }),
  // 3MF-specific bounds with no caller-facing schema field, so they are
  // never loosened by a request: the hand-rolled XML parser's own
  // nesting/size ceilings, and a cap on how many synthetic hierarchy nodes
  // `<build>`/`<component>` unrolling may generate.
  threeMfXml: Object.freeze({
    maxDepth: 64,
    maxNodes: 200_000,
    maxAttributesPerElement: 64,
    maxAttributeValueLength: 1_000_000,
  }),
  threeMfHierarchyNodes: 50_000,
});

export const importerDescriptor = importerDescriptorSchema.parse({
  id: "voxelspy.mesh",
  version: "0.1.0",
  formats: ["stl", "obj", "gltf", "glb", "3mf"],
  mediaTypes: [
    "model/stl",
    "application/sla",
    "model/obj",
    "text/plain",
    "model/gltf+json",
    "model/gltf-binary",
    "model/3mf",
  ],
  extensions: ["stl", "obj", "gltf", "glb", "3mf"],
  capabilities: {
    // glTF/GLB node hierarchies and 3MF build-item/component hierarchies
    // are both imported as `placement: { kind: "hierarchy" }`; STL/OBJ
    // always produce a single flat instance.
    assemblies: true,
    tessellationProvenance: false,
    // Every resource this importer reads (glTF/GLB buffers and, defensively,
    // images; every 3MF ZIP entry) must be embedded in the input bytes
    // themselves; anything external -- a glTF external URI, a 3MF
    // TargetMode="External" relationship, or a 3MF Production-extension
    // cross-part `path` reference -- fails closed rather than being
    // fetched, so "external resources" is honestly false, not merely
    // unimplemented.
    externalResources: false,
  },
});

interface ResolvedFrame {
  readonly unit: ResolvedSourceUnit;
  readonly axis: ResolvedSourceAxis;
  readonly unitOrigin: "embedded" | "declared" | "user";
  readonly axisOrigin: "embedded" | "declared" | "user";
  readonly detectedUnit: SourceUnit;
  readonly detectedAxis: SourceAxis;
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
  if (
    request.format !== "stl" &&
    request.format !== "obj" &&
    request.format !== "gltf" &&
    request.format !== "glb" &&
    request.format !== "3mf"
  ) {
    return failure(
      "unsupported-input",
      `Format ${request.format} is not supported.`,
    );
  }

  // 3MF Core always declares (or, absent a `unit` attribute, spec-defaults)
  // its own unit, and this package resolves its coordinate axis as
  // right-handed Z-up from the specification (see README) -- both
  // "embedded", exactly like glTF's fixed metre/Y-up declaration below.
  // Unlike glTF's frame, though, 3MF's detected UNIT is only known after
  // reading the model part's `<model unit="...">` attribute, so the archive
  // must be opened and parsed before `resolveFrame` can run.
  if (request.format === "3mf") {
    try {
      const archiveLimits = mergeArchiveLimits(
        request.options.limits.archive,
        IMPORTER_SAFETY_LIMITS.archive,
      );
      const parsedThreeMf = await parseThreeMf(request.bytes, {
        archive: archiveLimits,
        xml: IMPORTER_SAFETY_LIMITS.threeMfXml,
        triangleLimit: request.options.limits.triangleCount,
        safetyTriangleLimit: IMPORTER_SAFETY_LIMITS.triangleCount,
        safetyVertexLimit: IMPORTER_SAFETY_LIMITS.vertexCount,
        hierarchyNodeLimit: IMPORTER_SAFETY_LIMITS.threeMfHierarchyNodes,
      });
      const frame = resolveFrame(
        request,
        parsedThreeMf.detectedUnit,
        "right-handed-z-up",
      );
      if ("result" in frame) return frame.result;
      const model = await createThreeMfModel(request, frame, parsedThreeMf);
      const result = importResultSchema.parse({
        contractVersion: 1,
        ok: true,
        model,
      });
      return importExchangeSchema.parse({ request, result }).result;
    } catch (error) {
      return mapImportError(error);
    }
  }

  // glTF/GLB declare metres and Y-up by specification: the frame is
  // resolved FROM THE FORMAT (an "embedded" resolution), never defaulted
  // and never required as caller input, though a user (or declared)
  // override is still honored like any other format. STL/OBJ have no such
  // embedded metadata, so `resolveFrame` falls back to `needs-input`
  // unless the caller supplies one.
  const isGltf = request.format === "gltf" || request.format === "glb";
  const frame = resolveFrame(
    request,
    isGltf ? "metre" : "unknown",
    isGltf ? "right-handed-y-up" : "unknown",
  );
  if ("result" in frame) return frame.result;

  try {
    const model = isGltf
      ? await createGltfModel(
          request,
          frame,
          parseGltf(
            request.bytes,
            request.format as "gltf" | "glb",
            request.options.limits.triangleCount,
            IMPORTER_SAFETY_LIMITS.triangleCount,
            IMPORTER_SAFETY_LIMITS.vertexCount,
          ),
        )
      : await createModel(
          request,
          frame,
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
              ),
        );
    const result = importResultSchema.parse({
      contractVersion: 1,
      ok: true,
      model,
    });
    return importExchangeSchema.parse({ request, result }).result;
  } catch (error) {
    return mapImportError(error);
  }
}

/**
 * Combines a caller-supplied `options.limits.archive` (optional -- most
 * formats never populate it) with this package's own fixed 3MF archive
 * ceilings, taking the STRICTER (smaller) of the two for every field. A
 * caller may tighten these bounds further; it can never loosen them beyond
 * `IMPORTER_SAFETY_LIMITS.archive`, mirroring how `checkedTriangleCount`
 * already enforces both a caller limit and a fixed safety limit for
 * triangle counts.
 */
function mergeArchiveLimits(
  caller: ImportRequest["options"]["limits"]["archive"],
  fixed: typeof IMPORTER_SAFETY_LIMITS.archive,
): ArchiveSafetyLimits {
  if (!caller) return fixed;
  return {
    entryCount: Math.min(caller.entryCount, fixed.entryCount),
    entryBytes: Math.min(caller.entryBytes, fixed.entryBytes),
    expandedBytes: Math.min(caller.expandedBytes, fixed.expandedBytes),
    compressionRatio: Math.min(caller.compressionRatio, fixed.compressionRatio),
  };
}

function mapImportError(error: unknown): ImportResult {
  if (error instanceof RangeError) {
    return failure("resource-limit", error.message);
  }
  if (error instanceof UnsafeArchiveError) {
    return failure("unsafe-archive", error.message);
  }
  if (error instanceof TypeError) {
    return failure("invalid-input", error.message);
  }
  if (error instanceof UnsupportedInputError) {
    return failure("unsupported-input", error.message);
  }
  return failure("invalid-input", "Input could not be imported safely.");
}

export function inferFormat(
  sourceName: string,
): "stl" | "obj" | "gltf" | "glb" | "3mf" | undefined {
  const extension = /\.([^.]+)$/u.exec(sourceName)?.[1]?.toLowerCase();
  return extension === "stl" ||
    extension === "obj" ||
    extension === "gltf" ||
    extension === "glb" ||
    extension === "3mf"
    ? extension
    : undefined;
}

function resolveFrame(
  request: ImportRequest,
  detectedUnit: SourceUnit,
  detectedAxis: SourceAxis,
): ResolvedFrame | { readonly result: ImportResult } {
  const embeddedUnit = detectedUnit === "unknown" ? undefined : detectedUnit;
  const embeddedAxis = detectedAxis === "unknown" ? undefined : detectedAxis;
  const unit =
    request.options.userUnit ?? request.options.declaredUnit ?? embeddedUnit;
  const axis =
    request.options.userAxis ?? request.options.declaredAxis ?? embeddedAxis;
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
  const unitOrigin = request.options.userUnit
    ? "user"
    : request.options.declaredUnit
      ? "declared"
      : "embedded";
  const axisOrigin = request.options.userAxis
    ? "user"
    : request.options.declaredAxis
      ? "declared"
      : "embedded";
  return { unit, axis, unitOrigin, axisOrigin, detectedUnit, detectedAxis };
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
  if (userOrDeclaredSourceFrameOverride(frame)) {
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
      detectedSourceUnit: frame.detectedUnit,
      detectedSourceAxis: frame.detectedAxis,
      sourceUnit: frame.unit,
      sourceAxis: frame.axis,
      sourceResolution: { unit: frame.unitOrigin, axis: frame.axisOrigin },
      appliedSourceToModel: sourceToModelTransform(frame.unit, frame.axis),
      notes: parsed.notes,
    },
  };
  return normalizedModelSchema.parse(model);
}

/**
 * True when the resolved unit or axis differs from what a format's own
 * embedded metadata declares -- for STL/OBJ (no embedded metadata,
 * `frame.detectedUnit`/`detectedAxis` always `"unknown"`) this only fires
 * for an explicit `userUnit`/`userAxis`, matching the original behavior;
 * for glTF/GLB (which always has an embedded metre/Y-up declaration) it
 * also fires for a `declaredUnit`/`declaredAxis` override, since that is
 * still overriding an authoritative, format-supplied value.
 */
function userOrDeclaredSourceFrameOverride(frame: ResolvedFrame): boolean {
  if (frame.unitOrigin === "user" || frame.axisOrigin === "user") return true;
  const embeddedUnit = frame.detectedUnit !== "unknown";
  const embeddedAxis = frame.detectedAxis !== "unknown";
  return (
    (embeddedUnit && frame.unitOrigin !== "embedded") ||
    (embeddedAxis && frame.axisOrigin !== "embedded")
  );
}

/**
 * Assembles a `NormalizedModel` from a parsed glTF/GLB document as a
 * `placement: { kind: "hierarchy" }`: the node graph `src/gltf.ts` read is
 * reproduced faithfully (each glTF node becomes one assembly node, keeping
 * its own authored TRS/matrix transform unmodified, in the file's own
 * unit/axis), wrapped under two synthetic ancestor nodes --
 * `node.gltf.root` (identity, satisfying `normalizedModelSchema`'s
 * requirement that hierarchy roots use an identity `localToParent`) and
 * `node.gltf.frame` (carrying `sourceToModelTransform(frame.unit,
 * frame.axis)`, the exact same source-to-canonical-frame conversion STL/OBJ
 * apply per-vertex). Composing the transform once, at the top of the
 * hierarchy, means every mesh's `positions` and every real glTF node's
 * `localToParent` are stored exactly as authored (metres, Y-up, unless
 * overridden) -- never rescaled or axis-swapped individually -- while the
 * resolved world transform for every instance still lands in the
 * canonical millimetre, right-handed-Z-up frame.
 */
async function createGltfModel(
  request: ImportRequest,
  frame: ResolvedFrame,
  parsed: ParsedGltf,
): Promise<NormalizedModel> {
  const warnings: ContractWarning[] = [];
  if (userOrDeclaredSourceFrameOverride(frame)) {
    warnings.push(
      warning({
        code: "user-source-frame",
        severity: "info",
        message:
          "A source frame correction overrides glTF's format-declared metre, right-handed-Y-up frame and was recorded in provenance.",
      }),
    );
  }
  if (parsed.ignoredAttributes.length > 0) {
    warnings.push(
      warning({
        code: "gltf-attributes-not-evaluated",
        severity: "info",
        message: "Non-geometric glTF vertex attributes were not evaluated.",
        details: { attributes: [...parsed.ignoredAttributes] },
      }),
    );
  }
  const droppedCounts: Record<string, number> = {
    materials: parsed.ignoredMaterialCount,
    textures: parsed.ignoredTextureCount,
    images: parsed.ignoredImageCount,
    samplers: parsed.ignoredSamplerCount,
    cameras: parsed.ignoredCameraCount,
  };
  const droppedEntries = Object.entries(droppedCounts).filter(
    ([, count]) => count > 0,
  );
  if (droppedEntries.length > 0) {
    warnings.push(
      warning({
        code: "gltf-decorative-data-ignored",
        severity: "info",
        message: `glTF material, texture, image, sampler, and/or camera data does not affect geometry output and was not evaluated: ${droppedEntries
          .map(([key, count]) => `${count} ${key}`)
          .join(", ")}.`,
        details: Object.fromEntries(droppedEntries),
      }),
    );
  }
  if (parsed.ignoredExtensions.length > 0) {
    warnings.push(
      warning({
        code: "gltf-extension-ignored",
        severity: "info",
        message: `glTF extension(s) were present but not applied to geometry: ${parsed.ignoredExtensions.join(", ")}.`,
        details: { extensions: [...parsed.ignoredExtensions] },
      }),
    );
  }

  const meshes = parsed.meshes.map((mesh) => ({
    id: meshIdSchema.parse(mesh.id),
    geometry: { positions: mesh.positions, indices: mesh.indices },
  }));

  const rootId = nodeIdSchema.parse("node.gltf.root");
  const frameNodeId = nodeIdSchema.parse("node.gltf.frame");
  const appliedSourceToModel = sourceToModelTransform(frame.unit, frame.axis);
  const nodes = [
    {
      id: rootId,
      childIds: [frameNodeId],
      instanceIds: [],
      localToParent: IDENTITY_MAT4,
    },
    {
      id: frameNodeId,
      childIds: parsed.sceneRootIds.map((id) => nodeIdSchema.parse(id)),
      instanceIds: [],
      localToParent: appliedSourceToModel,
    },
    ...parsed.nodes.map((node) => ({
      id: nodeIdSchema.parse(node.id),
      childIds: node.childIds.map((childId) => nodeIdSchema.parse(childId)),
      instanceIds: node.instanceIds.map((instanceId) =>
        instanceIdSchema.parse(instanceId),
      ),
      localToParent: node.localToParent,
    })),
  ];

  const model = {
    contractVersion: 1 as const,
    id: request.targetModelId,
    frame: CANONICAL_FRAME,
    meshes,
    placement: {
      kind: "hierarchy" as const,
      instances: parsed.instances.map((instance) => ({
        id: instanceIdSchema.parse(instance.id),
        meshId: meshIdSchema.parse(instance.meshId),
        meshToNode: IDENTITY_MAT4,
      })),
      rootIds: [rootId],
      nodes,
    },
    warnings,
    provenance: {
      formatId: request.format,
      importerId: importerDescriptor.id,
      importerVersion: importerDescriptor.version,
      sourceName: request.sourceName,
      sourceDigest: await sha256(request.bytes),
      detectedSourceUnit: frame.detectedUnit,
      detectedSourceAxis: frame.detectedAxis,
      sourceUnit: frame.unit,
      sourceAxis: frame.axis,
      sourceResolution: { unit: frame.unitOrigin, axis: frame.axisOrigin },
      appliedSourceToModel,
      notes: [
        "glTF materials, textures, images, samplers, cameras, and animations are not evaluated; only static mesh geometry (POSITION attributes and mode-4 TRIANGLES primitives) is imported.",
      ],
    },
  };
  return normalizedModelSchema.parse(model);
}

/**
 * Assembles a `NormalizedModel` from a parsed 3MF document, structurally
 * mirroring `createGltfModel` above: `src/threemf.ts`'s unrolled
 * build-item/component tree becomes a `placement: { kind: "hierarchy" }`
 * under two synthetic ancestor nodes (`node.3mf.root` identity,
 * `node.3mf.frame` carrying `sourceToModelTransform(frame.unit,
 * frame.axis)`), so every 3MF `transform` attribute is stored exactly as
 * authored (in the file's own unit) and only the resolved world transform
 * lands in the canonical millimetre, right-handed-Z-up frame.
 */
async function createThreeMfModel(
  request: ImportRequest,
  frame: ResolvedFrame,
  parsed: ParsedThreeMf,
): Promise<NormalizedModel> {
  const warnings: ContractWarning[] = [];
  if (userOrDeclaredSourceFrameOverride(frame)) {
    warnings.push(
      warning({
        code: "user-source-frame",
        severity: "info",
        message:
          "A source frame correction overrides 3MF's declared (or spec-default) unit and/or this importer's right-handed-Z-up axis resolution, and was recorded in provenance.",
      }),
    );
  }
  const droppedCounts: Record<string, number> = {
    metadata: parsed.ignoredMetadataCount,
    "material/colour assignments": parsed.ignoredMaterialCount,
    thumbnails: parsed.ignoredThumbnailCount,
    labels: parsed.ignoredLabelCount,
  };
  const droppedEntries = Object.entries(droppedCounts).filter(
    ([, count]) => count > 0,
  );
  if (droppedEntries.length > 0) {
    warnings.push(
      warning({
        code: "3mf-decorative-data-ignored",
        severity: "info",
        message: `3MF metadata, material/colour, thumbnail, and/or label (name/partnumber) data does not affect geometry output and was not evaluated: ${droppedEntries
          .map(([key, count]) => `${count} ${key}`)
          .join(", ")}.`,
        details: Object.fromEntries(droppedEntries),
      }),
    );
  }
  if (parsed.ignoredResourceElements.length > 0) {
    warnings.push(
      warning({
        code: "3mf-resource-ignored",
        severity: "info",
        message: `Unrecognized 3MF resource or build element(s) were not evaluated: ${parsed.ignoredResourceElements.join(", ")}.`,
        details: { elements: [...parsed.ignoredResourceElements] },
      }),
    );
  }
  if (
    parsed.ignoredExtensionNamespaces.length > 0 ||
    parsed.recommendedExtensions.length > 0
  ) {
    warnings.push(
      warning({
        code: "3mf-extension-ignored",
        severity: "info",
        message: `3MF namespaced extension content was present but not applied to geometry: namespace prefix(es) ${parsed.ignoredExtensionNamespaces.join(", ") || "(none)"}; recommendedextensions ${parsed.recommendedExtensions.join(", ") || "(none)"}.`,
        details: {
          namespaces: [...parsed.ignoredExtensionNamespaces],
          recommendedExtensions: [...parsed.recommendedExtensions],
        },
      }),
    );
  }
  if (parsed.unreferencedObjectCount > 0) {
    warnings.push(
      warning({
        code: "3mf-unreferenced-objects",
        severity: "info",
        message: `${parsed.unreferencedObjectCount} 3MF resource object(s) were not reachable from any <build><item> and were not included in the imported model.`,
        details: { count: parsed.unreferencedObjectCount },
      }),
    );
  }

  const meshes = parsed.meshes.map((mesh) => ({
    id: meshIdSchema.parse(mesh.id),
    geometry: { positions: mesh.positions, indices: mesh.indices },
  }));

  const rootId = nodeIdSchema.parse("node.3mf.root");
  const frameNodeId = nodeIdSchema.parse("node.3mf.frame");
  const appliedSourceToModel = sourceToModelTransform(frame.unit, frame.axis);
  const nodes = [
    {
      id: rootId,
      childIds: [frameNodeId],
      instanceIds: [],
      localToParent: IDENTITY_MAT4,
    },
    {
      id: frameNodeId,
      childIds: parsed.itemRootIds.map((id) => nodeIdSchema.parse(id)),
      instanceIds: [],
      localToParent: appliedSourceToModel,
    },
    ...parsed.nodes.map((node) => ({
      id: nodeIdSchema.parse(node.id),
      childIds: node.childIds.map((childId) => nodeIdSchema.parse(childId)),
      instanceIds: node.instanceIds.map((instanceId) =>
        instanceIdSchema.parse(instanceId),
      ),
      localToParent: node.localToParent,
    })),
  ];

  const model = {
    contractVersion: 1 as const,
    id: request.targetModelId,
    frame: CANONICAL_FRAME,
    meshes,
    placement: {
      kind: "hierarchy" as const,
      instances: parsed.instances.map((instance) => ({
        id: instanceIdSchema.parse(instance.id),
        meshId: meshIdSchema.parse(instance.meshId),
        meshToNode: IDENTITY_MAT4,
      })),
      rootIds: [rootId],
      nodes,
    },
    warnings,
    provenance: {
      formatId: request.format,
      importerId: importerDescriptor.id,
      importerVersion: importerDescriptor.version,
      sourceName: request.sourceName,
      sourceDigest: await sha256(request.bytes),
      detectedSourceUnit: frame.detectedUnit,
      detectedSourceAxis: frame.detectedAxis,
      sourceUnit: frame.unit,
      sourceAxis: frame.axis,
      sourceResolution: { unit: frame.unitOrigin, axis: frame.axisOrigin },
      appliedSourceToModel,
      notes: [
        "3MF metadata, base materials/colours, thumbnails, and object names/part numbers are not evaluated; only Core mesh geometry (<mesh> vertices/triangles) reachable from <build><item> is imported.",
      ],
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
