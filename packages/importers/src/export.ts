import {
  normalizedModelSchema,
  resolvedSourceAxisSchema,
  resolvedSourceUnitSchema,
  sourceNormalizationTransformSchema,
  warningSchema,
  type ContractWarning,
  type InstanceId,
  type Mat4,
  type MeshBuffer,
  type MeshId,
  type NodeId,
  type NormalizedModel,
  type Sha256Digest,
} from "@voxelspy/contracts";
import {
  ExportInputError,
  ExportResourceLimitError,
  ExportUnsupportedTargetError,
} from "./errors.js";
import {
  applyMat4,
  modelToTargetTransform,
  multiplyMat4,
  type ResolvedSourceAxis,
  type ResolvedSourceUnit,
} from "./normalize.js";
import { BINARY_FACET_BYTES, BINARY_HEADER_BYTES } from "./stl.js";

// ---------------------------------------------------------------------------
// Public option/result shapes
// ---------------------------------------------------------------------------

export type ExportFormat = "stl-binary" | "stl-ascii" | "obj";

const EXPORT_FORMATS: readonly ExportFormat[] = [
  "stl-binary",
  "stl-ascii",
  "obj",
];

export interface ExportOptions {
  readonly targetFormat: ExportFormat;
  /**
   * The unit `exportModel` converts canonical-frame (millimetre)
   * coordinates into before writing them. Required, never defaulted:
   * neither STL nor OBJ can declare a unit inside the file (see
   * `ExportResult.warnings`'s `export.unit-not-declared` entry, always
   * present), so silently picking one on the caller's behalf would let a
   * consumer of the file believe a unit that was never actually chosen.
   */
  readonly targetUnit: ResolvedSourceUnit;
  /** The up-axis convention `exportModel` converts into. Required for the same reason as `targetUnit`. */
  readonly targetAxis: ResolvedSourceAxis;
}

export interface ExportGeometryCounts {
  readonly triangleCount: number;
  readonly vertexCount: number;
}

export interface ExportResult {
  readonly format: ExportFormat;
  readonly bytes: Uint8Array;
  readonly targetUnit: ResolvedSourceUnit;
  readonly targetAxis: ResolvedSourceAxis;
  /**
   * The exact transform applied to every emitted coordinate, converting
   * canonical-frame (millimetre, right-handed Z-up) positions to
   * `targetUnit`/`targetAxis` -- `modelToTargetTransform(targetUnit,
   * targetAxis)` from `src/normalize.ts`, the precise inverse of the
   * transform an import of this same file, declaring the same unit/axis,
   * would apply back (`sourceToModelTransform`).
   */
  readonly appliedModelToTarget: Mat4;
  /** Triangle and vertex counts of the geometry actually written, after flattening every mesh instance into one triangle soup. */
  readonly geometry: ExportGeometryCounts;
  /** SHA-256 digest of `bytes`, computed the same way `@voxelspy/importers`'s import path digests source bytes. */
  readonly digest: Sha256Digest;
  /** Everything this export could not represent honestly by writing bytes alone -- see the module doc comment below for the fixed set this function can emit. */
  readonly warnings: readonly ContractWarning[];
  /** Informational, non-warning context about how the bytes were produced (e.g. how facet normals were computed). */
  readonly notes: readonly string[];
}

/**
 * Safety ceiling on the FLATTENED (post-instancing) geometry `exportModel`
 * will write, checked by cheap arithmetic over each mesh's already-known
 * `positions.length`/`indices.length` -- before any output buffer is
 * allocated. Deliberately the same numbers as `IMPORTER_SAFETY_LIMITS`
 * (`src/index.ts`) -- kept as a literal, not an import, solely to avoid a
 * circular module dependency (`index.ts` imports `exportModel` from this
 * file) -- because a file this package's own importer would refuse on the
 * way in is not a file this package should produce on the way out.
 * `test/export.test.ts` pins both constants equal.
 */
export const EXPORTER_SAFETY_LIMITS = Object.freeze({
  triangleCount: 500_000,
  vertexCount: 1_500_000,
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Serializes `model` (a `NormalizedModel` in the canonical millimetre,
 * right-handed-Z-up frame) to bytes for `options.targetFormat`, one of
 * `"stl-binary"`, `"stl-ascii"`, or `"obj"` -- the exact subset
 * `src/stl.ts`/`src/obj.ts` read back, so a round trip through this
 * package (`exportModel` then `importModel`) is closed: nothing is ever
 * written that this package's own importer would refuse.
 *
 * **Frame handling.** `options.targetUnit`/`targetAxis` are required, never
 * defaulted or inferred: this function never emits canonical-frame
 * (millimetre, Z-up) numbers under a different, unrequested label, and
 * never guesses a target frame the caller did not ask for. Every emitted
 * coordinate is converted by `modelToTargetTransform(targetUnit,
 * targetAxis)` (`src/normalize.ts`), reported back verbatim as
 * `appliedModelToTarget`. Because neither STL nor OBJ has any field for
 * unit or axis metadata, that choice does not survive inside the file
 * bytes themselves -- `ExportResult.warnings` always includes an
 * `export.unit-not-declared` entry saying so, and a caller re-importing the
 * file must supply the same `targetUnit`/`targetAxis` again (as
 * `userUnit`/`userAxis`) to recover the original geometry.
 *
 * **Flattening.** Every placement instance (flat `meshToModel`, or
 * hierarchy `meshToNode` composed with each ancestor node's
 * `localToParent`, computed here independently of `@voxelspy/analysis`)
 * is resolved to one world transform, composed with the output-frame
 * conversion, and applied directly to that instance's mesh geometry.
 * STL and OBJ have no representation for multiple meshes or multiple
 * instances of one mesh, so every instance's triangles are written into a
 * single triangle soup (OBJ: one `v`/`f` vertex-index block, all instances
 * concatenated, each instance re-emitting its own mesh's full vertex list
 * rather than sharing vertices across instances -- geometrically correct
 * since two instances of the same mesh are not necessarily coincident, and
 * consistent with this package's "never silently dedupe geometry"
 * convention). Whenever `model` has more than one mesh or more than one
 * instance, `export.instances-flattened` is added, naming the counts.
 *
 * **Determinism.** Every coordinate is formatted by `formatNumber`
 * (`toString()`'s ECMA-262-specified shortest round-trip decimal --
 * see that function's doc comment for why this is exact and
 * locale-independent), triangles are visited in a fixed order (mesh
 * instance array order, then each mesh's own index order -- never a `Map`
 * or `Set` iteration whose order depends on insertion history beyond what
 * the language guarantees), and no timestamp, random value, or
 * machine-specific data is ever written (the binary STL header is 84 fixed
 * bytes: a constant ASCII label, zero-padded). Two calls with a
 * deeply-equal `model` and `options` always produce byte-identical `bytes`
 * and an identical `digest`.
 *
 * **Round-trip exactness.** `formatNumber`'s text round trip is exact for
 * every value it writes: `Number(formatNumber(v)) === v` always holds (see
 * that function's doc comment), for ASCII STL and OBJ alike -- neither
 * format's own text representation ever loses precision. What can still
 * differ after `exportModel` then `importModel` is the ARITHMETIC of the
 * unit conversion itself, which is ordinary IEEE-754 floating point, not
 * this module's choice: converting a millimetre value to a non-millimetre
 * unit divides it by that unit's scale factor (`UNIT_SCALE_MILLIMETRES`,
 * `src/normalize.ts`; none of `micrometre`/`centimetre`/`metre`/`inch`/
 * `foot` is a power of two), and re-importing multiplies it back --
 * division then multiplication by the same non-power-of-two factor is not
 * guaranteed to be an exact inverse in floating point, independent of
 * serialization. Concretely: round-tripping through ASCII STL or OBJ is
 * BIT-EXACT whenever `targetUnit` is `"millimetre"` (matching the
 * canonical frame, so the unit conversion is multiplication by exactly
 * `1`) -- true for any `targetAxis`, since the Z-up/Y-up conversion is
 * only a sign flip and a coordinate permutation, never a multiply. For any
 * other `targetUnit`, expect equality only to ordinary double-precision
 * tolerance (a handful of ULPs, i.e. a relative error on the order of
 * `1e-15`) -- see `test/export.test.ts`'s unit-conversion round-trip test
 * for the exact tolerance used. Binary STL is lossier still: it stores
 * each coordinate as an IEEE-754 float32 (`DataView.setFloat32`), so its
 * round trip is bounded by float32's much coarser relative precision
 * (`2^-23`, roughly `1.2e-7`) regardless of `targetUnit` -- see
 * `test/export.test.ts`'s `float32Tolerance` helper.
 *
 * **Bounds.** `model` is validated against `normalizedModelSchema`
 * (throwing whatever `ZodError` that raises, unchanged, for a structurally
 * invalid model) before any geometry is touched. Flattened triangle and
 * vertex counts are checked against `EXPORTER_SAFETY_LIMITS` by cheap
 * arithmetic over existing typed-array lengths -- before any output buffer
 * is allocated -- and `ExportResourceLimitError` is thrown if either is
 * exceeded. An unrecognized `targetFormat` throws
 * `ExportUnsupportedTargetError`; an invalid `targetUnit`/`targetAxis`, or
 * geometry that flattens to zero triangles, throws `ExportInputError`.
 */
export async function exportModel(
  model: NormalizedModel,
  options: ExportOptions,
): Promise<ExportResult> {
  const validated = normalizedModelSchema.parse(model);
  const format = resolveFormat(options.targetFormat);
  const unitResult = resolvedSourceUnitSchema.safeParse(options.targetUnit);
  if (!unitResult.success) {
    throw new ExportInputError(
      `options.targetUnit must be a resolved source unit; received ${String(options.targetUnit)}.`,
    );
  }
  const axisResult = resolvedSourceAxisSchema.safeParse(options.targetAxis);
  if (!axisResult.success) {
    throw new ExportInputError(
      `options.targetAxis must be a resolved source axis; received ${String(options.targetAxis)}.`,
    );
  }
  const targetUnit = unitResult.data;
  const targetAxis = axisResult.data;

  const meshById = new Map<MeshId, MeshBuffer>(
    validated.meshes.map((mesh) => [mesh.id, mesh.geometry] as const),
  );

  const counts = countFlattenedGeometry(validated, meshById);
  if (counts.triangleCount > EXPORTER_SAFETY_LIMITS.triangleCount) {
    throw new ExportResourceLimitError(
      `Flattened export geometry requires ${counts.triangleCount} triangles; the exporter safety limit is ${EXPORTER_SAFETY_LIMITS.triangleCount} (matching this package's own importer ceiling -- a file this package would refuse to import, it will not produce).`,
    );
  }
  if (counts.vertexCount > EXPORTER_SAFETY_LIMITS.vertexCount) {
    throw new ExportResourceLimitError(
      `Flattened export geometry requires ${counts.vertexCount} vertices; the exporter safety limit is ${EXPORTER_SAFETY_LIMITS.vertexCount}.`,
    );
  }
  if (counts.triangleCount === 0) {
    throw new ExportInputError(
      "exportModel requires at least one triangle after flattening every mesh instance.",
    );
  }

  const appliedModelToTarget = sourceNormalizationTransformSchema.parse(
    modelToTargetTransform(targetUnit, targetAxis),
  );
  const instances = resolveInstanceTransforms(validated, appliedModelToTarget);

  const warnings: ContractWarning[] = [];
  const notes: string[] = [];

  warnings.push(
    warning({
      code: "export.unit-not-declared",
      severity: "info",
      message: `${formatLabel(format)} cannot declare a unit or axis convention inside the file. This export was written in ${targetUnit}, ${targetAxis}; that choice exists only in this ExportResult, not in the emitted bytes. Re-importing this file requires supplying the same unit and axis again.`,
      details: { targetUnit, targetAxis },
    }),
  );

  const meshCount = validated.meshes.length;
  const instanceCount = validated.placement.instances.length;
  if (meshCount > 1 || instanceCount > 1) {
    warnings.push(
      warning({
        code: "export.instances-flattened",
        severity: "info",
        message: `${meshCount} mesh(es) across ${instanceCount} instance(s) were flattened into a single triangle soup; ${formatLabel(format)} has no representation for multiple meshes or mesh instancing.`,
        details: { meshCount, instanceCount },
      }),
    );
  }

  let bytes: Uint8Array;
  let vertexCount: number;
  if (format === "stl-binary") {
    const built = buildBinaryStl(instances, meshById);
    bytes = built.bytes;
    vertexCount = built.triangleCount * 3;
    if (built.degenerateNormalCount > 0) {
      warnings.push(
        warning({
          code: "export.degenerate-facet-normals",
          severity: "warning",
          message: `${built.degenerateNormalCount} triangle(s) had zero area after the output transform, so no facet normal could be computed; a zero vector was written for those facets.`,
          details: { count: built.degenerateNormalCount },
        }),
      );
    }
    notes.push(
      "Facet normals are computed geometrically from each triangle's vertex winding order (right-hand rule); the normalized model retains no original per-facet normal data to write instead.",
    );
  } else if (format === "stl-ascii") {
    const built = buildAsciiStl(instances, meshById, String(validated.id));
    bytes = new TextEncoder().encode(built.text);
    vertexCount = built.triangleCount * 3;
    if (built.degenerateNormalCount > 0) {
      warnings.push(
        warning({
          code: "export.degenerate-facet-normals",
          severity: "warning",
          message: `${built.degenerateNormalCount} triangle(s) had zero area after the output transform, so no facet normal could be computed; a zero vector was written for those facets.`,
          details: { count: built.degenerateNormalCount },
        }),
      );
    }
    notes.push(
      "Facet normals are computed geometrically from each triangle's vertex winding order (right-hand rule); the normalized model retains no original per-facet normal data to write instead.",
    );
  } else {
    const built = buildObj(instances, meshById);
    bytes = new TextEncoder().encode(built.text);
    vertexCount = built.vertexCount;
    notes.push(
      'No material library is referenced or emitted; the file contains only vertex positions ("v") and triangular faces ("f").',
    );
  }

  const digest = await sha256(bytes);

  return {
    format,
    bytes,
    targetUnit,
    targetAxis,
    appliedModelToTarget,
    geometry: { triangleCount: counts.triangleCount, vertexCount },
    digest,
    warnings,
    notes,
  };
}

function formatLabel(format: ExportFormat): string {
  return format === "stl-binary"
    ? "Binary STL"
    : format === "stl-ascii"
      ? "ASCII STL"
      : "OBJ";
}

function resolveFormat(format: unknown): ExportFormat {
  if (
    typeof format === "string" &&
    (EXPORT_FORMATS as readonly string[]).includes(format)
  ) {
    return format as ExportFormat;
  }
  throw new ExportUnsupportedTargetError(
    `Export target ${JSON.stringify(format)} is not supported; supported targets are ${EXPORT_FORMATS.join(", ")}.`,
  );
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Canonical number formatting rule for every coordinate this module emits:
 * `value.toString()`, ECMA-262's `Number::toString` -- the shortest decimal
 * string that reads back, via `Number(...)`, to the exact same IEEE-754
 * double. This is not an implementation convenience; it is the specific
 * property `test/export.test.ts` exercises: for every finite `Float64`
 * coordinate this exporter can ever be asked to write,
 * `Number(value.toString()) === value` holds by specification, so
 * `parseFiniteDecimal` (`src/parse.ts`, which accepts exactly the decimal
 * and exponential forms `Number::toString` can produce -- including
 * `-0.5`, `1e-7`, and `1.5e+21`) recovers the identical double on
 * re-import. It is also locale-independent (unlike
 * `toLocaleString`/`Intl.NumberFormat`) and carries no hidden precision:
 * unlike `toFixed`, it never truncates a value that needs more digits, and
 * never pads one that needs fewer.
 *
 * `-0` is not special-cased: `(-0).toString() === "0"` is itself part of
 * the `Number::toString` specification, so it is unreachable in emitted
 * text without extra code, not merely made unlikely by it.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ExportInputError(
      "Export produced a non-finite coordinate after applying the target unit/axis conversion.",
    );
  }
  return value.toString();
}

// ---------------------------------------------------------------------------
// Flattening: per-instance world transforms
// ---------------------------------------------------------------------------

interface ResolvedInstance {
  readonly meshId: MeshId;
  /** Mesh-local position -> target file coordinates, in one composed transform. */
  readonly transform: Mat4;
}

function resolveInstanceTransforms(
  model: NormalizedModel,
  modelToTarget: Mat4,
): readonly ResolvedInstance[] {
  if (model.placement.kind === "flat") {
    return model.placement.instances.map((instance) => ({
      meshId: instance.meshId,
      transform: multiplyMat4(modelToTarget, instance.meshToModel),
    }));
  }

  const placement = model.placement;
  const nodeById = new Map(placement.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<NodeId, NodeId>();
  for (const node of placement.nodes) {
    for (const childId of node.childIds) parentOf.set(childId, node.id);
  }
  const nodeToModelCache = new Map<NodeId, Mat4>();
  const nodeToModel = (nodeId: NodeId): Mat4 => {
    const cached = nodeToModelCache.get(nodeId);
    if (cached) return cached;
    const node = nodeById.get(nodeId);
    if (!node) {
      throw new ExportInputError(
        `Placement references unknown hierarchy node "${nodeId}".`,
      );
    }
    const parentId = parentOf.get(nodeId);
    const resolved =
      parentId === undefined
        ? node.localToParent
        : multiplyMat4(nodeToModel(parentId), node.localToParent);
    nodeToModelCache.set(nodeId, resolved);
    return resolved;
  };

  const instanceNodeId = new Map<InstanceId, NodeId>();
  for (const node of placement.nodes) {
    for (const instanceId of node.instanceIds) {
      instanceNodeId.set(instanceId, node.id);
    }
  }

  return placement.instances.map((instance) => {
    const nodeId = instanceNodeId.get(instance.id);
    if (nodeId === undefined) {
      throw new ExportInputError(
        `Instance "${instance.id}" is not attached to any hierarchy node.`,
      );
    }
    const worldToModel = nodeToModel(nodeId);
    const instanceToModel = multiplyMat4(worldToModel, instance.meshToNode);
    return {
      meshId: instance.meshId,
      transform: multiplyMat4(modelToTarget, instanceToModel),
    };
  });
}

function countFlattenedGeometry(
  model: NormalizedModel,
  meshById: ReadonlyMap<MeshId, MeshBuffer>,
): ExportGeometryCounts {
  let triangleCount = 0;
  let vertexCount = 0;
  for (const instance of model.placement.instances) {
    const geometry = meshById.get(instance.meshId);
    if (!geometry) continue; // unreachable once normalizedModelSchema has validated model
    triangleCount += geometry.indices.length / 3;
    vertexCount += geometry.positions.length / 3;
  }
  return { triangleCount, vertexCount };
}

// ---------------------------------------------------------------------------
// Facet geometry
// ---------------------------------------------------------------------------

function transformedVertex(
  instance: ResolvedInstance,
  positions: Float64Array,
  vertexIndex: number,
): readonly [number, number, number] {
  const base = vertexIndex * 3;
  return applyMat4(
    instance.transform,
    positions[base]!,
    positions[base + 1]!,
    positions[base + 2]!,
  );
}

/** `[nx, ny, nz]` (unit length) from the triangle's vertex winding order via the right-hand rule, or `[0, 0, 0]` for a zero-area (degenerate) triangle. */
function computeFaceNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): readonly [number, number, number] {
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0) || !Number.isFinite(length)) return [0, 0, 0];
  return [nx / length, ny / length, nz / length];
}

// ---------------------------------------------------------------------------
// Binary STL
// ---------------------------------------------------------------------------

/** Fixed, deterministic 80-byte binary STL header text (no timestamp, no machine identity), zero-padded. */
const BINARY_STL_HEADER_TEXT = "VoxelSpy exported STL";

interface BinaryStlBuild {
  readonly bytes: Uint8Array;
  readonly triangleCount: number;
  readonly degenerateNormalCount: number;
}

function buildBinaryStl(
  instances: readonly ResolvedInstance[],
  meshById: ReadonlyMap<MeshId, MeshBuffer>,
): BinaryStlBuild {
  let triangleCount = 0;
  for (const instance of instances) {
    triangleCount += meshById.get(instance.meshId)!.indices.length / 3;
  }

  const bytes = new Uint8Array(
    BINARY_HEADER_BYTES + triangleCount * BINARY_FACET_BYTES,
  );
  const headerBytes = new TextEncoder().encode(BINARY_STL_HEADER_TEXT);
  bytes.set(headerBytes.subarray(0, 80), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangleCount, true);

  let facetIndex = 0;
  let degenerateNormalCount = 0;
  for (const instance of instances) {
    const mesh = meshById.get(instance.meshId)!;
    const { positions, indices } = mesh;
    for (let t = 0; t < indices.length; t += 3) {
      const [ax, ay, az] = transformedVertex(instance, positions, indices[t]!);
      const [bx, by, bz] = transformedVertex(
        instance,
        positions,
        indices[t + 1]!,
      );
      const [cx, cy, cz] = transformedVertex(
        instance,
        positions,
        indices[t + 2]!,
      );
      const [nx, ny, nz] = computeFaceNormal(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        cx,
        cy,
        cz,
      );
      if (nx === 0 && ny === 0 && nz === 0) degenerateNormalCount += 1;

      const facetOffset = BINARY_HEADER_BYTES + facetIndex * BINARY_FACET_BYTES;
      writeFinite(view, facetOffset, nx);
      writeFinite(view, facetOffset + 4, ny);
      writeFinite(view, facetOffset + 8, nz);
      writeFinite(view, facetOffset + 12, ax);
      writeFinite(view, facetOffset + 16, ay);
      writeFinite(view, facetOffset + 20, az);
      writeFinite(view, facetOffset + 24, bx);
      writeFinite(view, facetOffset + 28, by);
      writeFinite(view, facetOffset + 32, bz);
      writeFinite(view, facetOffset + 36, cx);
      writeFinite(view, facetOffset + 40, cy);
      writeFinite(view, facetOffset + 44, cz);
      // Attribute byte count (bytes 48-49) is left as the deterministic
      // zero this buffer was allocated with; this package's importer
      // already reports (rather than interprets) a nonzero value here.
      facetIndex += 1;
    }
  }

  return { bytes, triangleCount, degenerateNormalCount };
}

function writeFinite(view: DataView, offset: number, value: number): void {
  if (!Number.isFinite(value)) {
    throw new ExportInputError(
      "Export produced a non-finite coordinate after applying the target unit/axis conversion.",
    );
  }
  view.setFloat32(offset, value, true);
}

// ---------------------------------------------------------------------------
// ASCII STL
// ---------------------------------------------------------------------------

interface AsciiStlBuild {
  readonly text: string;
  readonly triangleCount: number;
  readonly degenerateNormalCount: number;
}

function buildAsciiStl(
  instances: readonly ResolvedInstance[],
  meshById: ReadonlyMap<MeshId, MeshBuffer>,
  solidName: string,
): AsciiStlBuild {
  const lines: string[] = [`solid ${solidName}`];
  let triangleCount = 0;
  let degenerateNormalCount = 0;

  for (const instance of instances) {
    const mesh = meshById.get(instance.meshId)!;
    const { positions, indices } = mesh;
    for (let t = 0; t < indices.length; t += 3) {
      const [ax, ay, az] = transformedVertex(instance, positions, indices[t]!);
      const [bx, by, bz] = transformedVertex(
        instance,
        positions,
        indices[t + 1]!,
      );
      const [cx, cy, cz] = transformedVertex(
        instance,
        positions,
        indices[t + 2]!,
      );
      const [nx, ny, nz] = computeFaceNormal(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        cx,
        cy,
        cz,
      );
      if (nx === 0 && ny === 0 && nz === 0) degenerateNormalCount += 1;

      lines.push(
        `facet normal ${formatNumber(nx)} ${formatNumber(ny)} ${formatNumber(nz)}`,
      );
      lines.push("outer loop");
      lines.push(
        `vertex ${formatNumber(ax)} ${formatNumber(ay)} ${formatNumber(az)}`,
      );
      lines.push(
        `vertex ${formatNumber(bx)} ${formatNumber(by)} ${formatNumber(bz)}`,
      );
      lines.push(
        `vertex ${formatNumber(cx)} ${formatNumber(cy)} ${formatNumber(cz)}`,
      );
      lines.push("endloop");
      lines.push("endfacet");
      triangleCount += 1;
    }
  }

  lines.push(`endsolid ${solidName}`);
  return {
    text: `${lines.join("\n")}\n`,
    triangleCount,
    degenerateNormalCount,
  };
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

interface ObjBuild {
  readonly text: string;
  readonly triangleCount: number;
  readonly vertexCount: number;
}

function buildObj(
  instances: readonly ResolvedInstance[],
  meshById: ReadonlyMap<MeshId, MeshBuffer>,
): ObjBuild {
  const lines: string[] = [];
  let vertexOffset = 0;
  let triangleCount = 0;
  let vertexCount = 0;

  for (const instance of instances) {
    const mesh = meshById.get(instance.meshId)!;
    const localVertexCount = mesh.positions.length / 3;
    for (let v = 0; v < localVertexCount; v += 1) {
      const [x, y, z] = transformedVertex(instance, mesh.positions, v);
      lines.push(`v ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(z)}`);
    }
    const { indices } = mesh;
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]! + vertexOffset + 1;
      const b = indices[t + 1]! + vertexOffset + 1;
      const c = indices[t + 2]! + vertexOffset + 1;
      lines.push(`f ${a} ${b} ${c}`);
      triangleCount += 1;
    }
    vertexOffset += localVertexCount;
    vertexCount += localVertexCount;
  }

  return { text: `${lines.join("\n")}\n`, triangleCount, vertexCount };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function warning(value: {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}): ContractWarning {
  return warningSchema.parse(value);
}

async function sha256(bytes: Uint8Array): Promise<Sha256Digest> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  const value = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { algorithm: "sha256" as const, value };
}
