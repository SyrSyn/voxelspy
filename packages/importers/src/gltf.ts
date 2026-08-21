import type { Mat4 } from "@voxelspy/contracts";
import { UnsupportedInputError } from "./errors.js";
import { checkedTriangleCount, decodeUtf8 } from "./parse.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface ParsedGltfMesh {
  readonly id: string;
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

export interface ParsedGltfNode {
  readonly id: string;
  readonly childIds: readonly string[];
  readonly instanceIds: readonly string[];
  /** Node-authored TRS/matrix transform, unmodified from the source file's own unit/axis convention. */
  readonly localToParent: Mat4;
}

export interface ParsedGltfInstance {
  readonly id: string;
  readonly meshId: string;
}

/**
 * The result of reading a glTF/GLB document's static mesh geometry. Frame
 * resolution (unit/axis) and final `NormalizedModel` assembly are the
 * caller's job (`src/index.ts`'s `createGltfModel`) -- this module only
 * reads bytes the file itself provides, at face value, in the file's own
 * (unscaled) units.
 */
export interface ParsedGltf {
  readonly meshes: readonly ParsedGltfMesh[];
  readonly nodes: readonly ParsedGltfNode[];
  readonly sceneRootIds: readonly string[];
  readonly instances: readonly ParsedGltfInstance[];
  /** Attribute names (other than `POSITION`) encountered but not evaluated, e.g. `NORMAL`, `TEXCOORD_0`. */
  readonly ignoredAttributes: readonly string[];
  readonly ignoredMaterialCount: number;
  readonly ignoredTextureCount: number;
  readonly ignoredImageCount: number;
  readonly ignoredSamplerCount: number;
  readonly ignoredCameraCount: number;
  /** `extensionsUsed` entries (never `extensionsRequired` -- any of those fails the whole import). */
  readonly ignoredExtensions: readonly string[];
}

// ---------------------------------------------------------------------------
// GLB container
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46_54_6c_67; // "glTF"
const GLB_JSON_CHUNK_TYPE = 0x4e_4f_53_4a; // "JSON"
const GLB_BIN_CHUNK_TYPE = 0x00_4e_49_42; // "BIN\0"
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

interface GlbContainer {
  readonly json: string;
  readonly binaryChunk: Uint8Array | undefined;
}

function parseGlbContainer(bytes: Uint8Array): GlbContainer {
  if (bytes.byteLength < GLB_HEADER_BYTES) {
    throw new TypeError(
      `GLB input is ${bytes.byteLength} byte(s), shorter than the ${GLB_HEADER_BYTES}-byte header`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new TypeError(
      "GLB input does not start with the glTF binary magic number",
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new UnsupportedInputError(
      `GLB version ${version} is not supported; only version 2 is supported`,
    );
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) {
    throw new TypeError(
      `GLB header declares a total length of ${declaredLength} byte(s), but the input is ${bytes.byteLength} byte(s)`,
    );
  }

  let offset = GLB_HEADER_BYTES;
  if (offset + CHUNK_HEADER_BYTES > bytes.byteLength) {
    throw new TypeError("GLB input is truncated before its first chunk header");
  }
  const jsonChunkLength = view.getUint32(offset, true);
  const jsonChunkType = view.getUint32(offset + 4, true);
  offset += CHUNK_HEADER_BYTES;
  if (jsonChunkType !== GLB_JSON_CHUNK_TYPE) {
    throw new TypeError("GLB input's first chunk is not a JSON chunk");
  }
  if (jsonChunkLength % 4 !== 0) {
    throw new TypeError("GLB JSON chunk length is not 4-byte aligned");
  }
  if (offset + jsonChunkLength > bytes.byteLength) {
    throw new TypeError("GLB JSON chunk length overruns the input");
  }
  const jsonBytes = bytes.subarray(offset, offset + jsonChunkLength);
  offset += jsonChunkLength;

  let binaryChunk: Uint8Array | undefined;
  if (offset < bytes.byteLength) {
    if (offset + CHUNK_HEADER_BYTES > bytes.byteLength) {
      throw new TypeError(
        "GLB input is truncated before its second chunk header",
      );
    }
    const binChunkLength = view.getUint32(offset, true);
    const binChunkType = view.getUint32(offset + 4, true);
    offset += CHUNK_HEADER_BYTES;
    if (binChunkType !== GLB_BIN_CHUNK_TYPE) {
      throw new TypeError("GLB input's second chunk is not a binary chunk");
    }
    if (binChunkLength % 4 !== 0) {
      throw new TypeError("GLB binary chunk length is not 4-byte aligned");
    }
    if (offset + binChunkLength > bytes.byteLength) {
      throw new TypeError("GLB binary chunk length overruns the input");
    }
    binaryChunk = bytes.subarray(offset, offset + binChunkLength);
    offset += binChunkLength;
  }
  if (offset !== bytes.byteLength) {
    throw new TypeError(
      `GLB input has ${bytes.byteLength - offset} unexpected trailing byte(s) after its declared chunk(s)`,
    );
  }

  return { json: decodeUtf8(jsonBytes, "GLB JSON chunk"), binaryChunk };
}

// ---------------------------------------------------------------------------
// JSON document helpers
// ---------------------------------------------------------------------------

function parseJsonDocument(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new TypeError("glTF JSON could not be parsed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requireIndex(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer index`);
  }
  return value;
}

function at<T>(array: readonly T[], index: number, label: string): T {
  const value = array[index];
  if (value === undefined) throw new TypeError(`${label} is out of range`);
  return value;
}

// ---------------------------------------------------------------------------
// Data URIs
// ---------------------------------------------------------------------------

const DATA_URI_PREFIX = /^data:[^,]*;base64,/iu;

function assertEmbeddedDataUri(uri: string, label: string): RegExpExecArray {
  const match = DATA_URI_PREFIX.exec(uri);
  if (!match) {
    throw new UnsupportedInputError(
      `${label} is an external or relative resource reference, which is not supported; only embedded base64 data URIs (or the GLB binary chunk, for buffer 0) are accepted`,
    );
  }
  return match;
}

function decodeDataUri(uri: string, label: string): Uint8Array {
  const match = assertEmbeddedDataUri(uri, label);
  const base64 = uri.slice(match[0].length);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) {
    throw new TypeError(`${label} contains invalid base64 data`);
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new TypeError(`${label} could not be base64-decoded`);
  }
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Buffers / bufferViews / accessors
// ---------------------------------------------------------------------------

function resolveBuffer(
  entry: unknown,
  index: number,
  containerFormat: "gltf" | "glb",
  binaryChunk: Uint8Array | undefined,
): Uint8Array {
  const buffer = requireObject(entry, `buffers[${index}]`);
  const byteLength = buffer.byteLength;
  if (
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    throw new TypeError(
      `buffers[${index}].byteLength must be a non-negative integer`,
    );
  }
  if (buffer.uri === undefined) {
    if (index !== 0 || containerFormat !== "glb" || binaryChunk === undefined) {
      throw new UnsupportedInputError(
        `buffers[${index}] has no uri; only buffer 0 of a GLB file may rely on the embedded binary chunk`,
      );
    }
    if (
      byteLength > binaryChunk.byteLength ||
      binaryChunk.byteLength - byteLength >= 4
    ) {
      throw new TypeError(
        `buffers[${index}].byteLength (${byteLength}) does not match the GLB binary chunk length (${binaryChunk.byteLength})`,
      );
    }
    return binaryChunk.subarray(0, byteLength);
  }
  if (typeof buffer.uri !== "string") {
    throw new TypeError(`buffers[${index}].uri must be a string`);
  }
  const decoded = decodeDataUri(buffer.uri, `buffers[${index}].uri`);
  if (decoded.byteLength !== byteLength) {
    throw new TypeError(
      `buffers[${index}].byteLength (${byteLength}) does not match its decoded data URI length (${decoded.byteLength})`,
    );
  }
  return decoded;
}

interface ResolvedBufferView {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly byteStride: number | undefined;
}

function resolveBufferView(
  entry: unknown,
  index: number,
  buffers: readonly Uint8Array[],
): ResolvedBufferView {
  const view = requireObject(entry, `bufferViews[${index}]`);
  const bufferIndex = requireIndex(view.buffer, `bufferViews[${index}].buffer`);
  const buffer = buffers[bufferIndex];
  if (buffer === undefined) {
    throw new TypeError(
      `bufferViews[${index}].buffer references unknown buffer ${bufferIndex}`,
    );
  }
  const byteOffset =
    view.byteOffset === undefined
      ? 0
      : requireIndex(view.byteOffset, `bufferViews[${index}].byteOffset`);
  if (
    typeof view.byteLength !== "number" ||
    !Number.isSafeInteger(view.byteLength) ||
    view.byteLength < 0
  ) {
    throw new TypeError(
      `bufferViews[${index}].byteLength must be a non-negative integer`,
    );
  }
  const byteLength = view.byteLength;
  if (byteOffset + byteLength > buffer.byteLength) {
    throw new TypeError(
      `bufferViews[${index}] spans byte(s) ${byteOffset}..${byteOffset + byteLength}, beyond its buffer's actual ${buffer.byteLength} byte(s)`,
    );
  }
  let byteStride: number | undefined;
  if (view.byteStride !== undefined) {
    if (
      typeof view.byteStride !== "number" ||
      !Number.isInteger(view.byteStride) ||
      view.byteStride < 4 ||
      view.byteStride > 252
    ) {
      throw new TypeError(
        `bufferViews[${index}].byteStride must be an integer between 4 and 252`,
      );
    }
    byteStride = view.byteStride;
  }
  return {
    bytes: buffer.subarray(byteOffset, byteOffset + byteLength),
    byteLength,
    byteStride,
  };
}

const COMPONENT_BYTE_SIZE: Readonly<Record<number, number>> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENT_COUNT: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

interface ResolvedAccessor {
  readonly count: number;
  readonly componentType: number;
  readonly type: string;
  readonly bufferView: ResolvedBufferView;
  readonly byteOffset: number;
}

function resolveAccessor(
  accessors: readonly unknown[],
  index: number,
  label: string,
  bufferViews: readonly ResolvedBufferView[],
): ResolvedAccessor {
  const accessor = requireObject(at(accessors, index, label), label);
  if (accessor.sparse !== undefined) {
    throw new UnsupportedInputError(
      `${label} uses sparse accessor storage, which is not supported`,
    );
  }
  if (accessor.bufferView === undefined) {
    throw new UnsupportedInputError(
      `${label} has no bufferView; zero-filled or extension-provided accessor data is not supported`,
    );
  }
  const bufferViewIndex = requireIndex(
    accessor.bufferView,
    `${label}.bufferView`,
  );
  const bufferView = bufferViews[bufferViewIndex];
  if (bufferView === undefined) {
    throw new TypeError(
      `${label}.bufferView references unknown bufferView ${bufferViewIndex}`,
    );
  }
  const componentType = accessor.componentType;
  if (
    typeof componentType !== "number" ||
    !(componentType in COMPONENT_BYTE_SIZE)
  ) {
    throw new UnsupportedInputError(
      `${label}.componentType ${String(componentType)} is not a supported component type`,
    );
  }
  const type = accessor.type;
  if (typeof type !== "string" || !(type in TYPE_COMPONENT_COUNT)) {
    throw new TypeError(`${label}.type must be a supported accessor type`);
  }
  if (
    typeof accessor.count !== "number" ||
    !Number.isSafeInteger(accessor.count) ||
    accessor.count < 0
  ) {
    throw new TypeError(`${label}.count must be a non-negative integer`);
  }
  const byteOffset =
    accessor.byteOffset === undefined
      ? 0
      : requireIndex(accessor.byteOffset, `${label}.byteOffset`);
  if (accessor.normalized === true) {
    throw new UnsupportedInputError(
      `${label}.normalized integer encoding is not supported`,
    );
  }
  return { count: accessor.count, componentType, type, bufferView, byteOffset };
}

/**
 * Validates the accessor's declared byte span against its bufferView's
 * ACTUAL (already-bounded) byte length before any typed array sized by
 * `accessor.count` is allocated -- so an attacker-controlled `count` cannot
 * cause a huge allocation: the input itself is already capped (32 MiB by
 * `IMPORTER_SAFETY_LIMITS.inputBytes`), so the number of elements that can
 * fit in a real buffer is inherently bounded.
 */
function accessorByteSpan(
  resolved: ResolvedAccessor,
  label: string,
): { readonly elementSize: number; readonly stride: number } {
  const componentSize = COMPONENT_BYTE_SIZE[resolved.componentType]!;
  const componentCount = TYPE_COMPONENT_COUNT[resolved.type]!;
  const elementSize = componentSize * componentCount;
  const stride = resolved.bufferView.byteStride ?? elementSize;
  if (stride < elementSize) {
    throw new TypeError(`${label} byteStride is smaller than its element size`);
  }
  const neededBytes =
    resolved.count === 0
      ? 0
      : resolved.byteOffset + (resolved.count - 1) * stride + elementSize;
  if (neededBytes > resolved.bufferView.byteLength) {
    throw new TypeError(
      `${label} requires ${neededBytes} byte(s) but its bufferView provides only ${resolved.bufferView.byteLength}`,
    );
  }
  return { elementSize, stride };
}

function bufferViewDataView(bufferView: ResolvedBufferView): DataView {
  return new DataView(
    bufferView.bytes.buffer,
    bufferView.bytes.byteOffset,
    bufferView.bytes.byteLength,
  );
}

function readPositionAccessor(
  accessors: readonly unknown[],
  index: number,
  label: string,
  bufferViews: readonly ResolvedBufferView[],
): Float64Array {
  const resolved = resolveAccessor(accessors, index, label, bufferViews);
  if (resolved.type !== "VEC3" || resolved.componentType !== 5126) {
    throw new UnsupportedInputError(
      `${label} must be a FLOAT VEC3 accessor; found type ${resolved.type}, componentType ${resolved.componentType}`,
    );
  }
  const { stride } = accessorByteSpan(resolved, label);
  const view = bufferViewDataView(resolved.bufferView);
  const positions = new Float64Array(resolved.count * 3);
  for (let element = 0; element < resolved.count; element += 1) {
    const elementOffset = resolved.byteOffset + element * stride;
    const x = view.getFloat32(elementOffset, true);
    const y = view.getFloat32(elementOffset + 4, true);
    const z = view.getFloat32(elementOffset + 8, true);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new TypeError(`${label} contains a non-finite coordinate`);
    }
    positions[element * 3] = x;
    positions[element * 3 + 1] = y;
    positions[element * 3 + 2] = z;
  }
  return positions;
}

const INDEX_COMPONENT_TYPES = new Set([5121, 5123, 5125]);

function readIndexAccessor(
  accessors: readonly unknown[],
  index: number,
  label: string,
  bufferViews: readonly ResolvedBufferView[],
): Uint32Array {
  const resolved = resolveAccessor(accessors, index, label, bufferViews);
  if (resolved.type !== "SCALAR") {
    throw new TypeError(`${label} must be a SCALAR accessor`);
  }
  if (!INDEX_COMPONENT_TYPES.has(resolved.componentType)) {
    throw new UnsupportedInputError(
      `${label}.componentType ${resolved.componentType} is not a supported index component type`,
    );
  }
  const { stride } = accessorByteSpan(resolved, label);
  const view = bufferViewDataView(resolved.bufferView);
  const indices = new Uint32Array(resolved.count);
  for (let element = 0; element < resolved.count; element += 1) {
    const elementOffset = resolved.byteOffset + element * stride;
    indices[element] =
      resolved.componentType === 5121
        ? view.getUint8(elementOffset)
        : resolved.componentType === 5123
          ? view.getUint16(elementOffset, true)
          : view.getUint32(elementOffset, true);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Primitives / meshes
// ---------------------------------------------------------------------------

const PRIMITIVE_MODE_NAMES: Readonly<Record<number, string>> = {
  0: "POINTS",
  1: "LINES",
  2: "LINE_LOOP",
  3: "LINE_STRIP",
  4: "TRIANGLES",
  5: "TRIANGLE_STRIP",
  6: "TRIANGLE_FAN",
};

interface PrimitiveBudget {
  vertexTotal: number;
  triangleTotal: number;
}

function resolvePrimitive(
  primitive: Record<string, unknown>,
  label: string,
  accessors: readonly unknown[],
  bufferViews: readonly ResolvedBufferView[],
  budget: PrimitiveBudget,
  triangleLimit: number,
  safetyTriangleLimit: number,
  safetyVertexLimit: number,
  ignoredAttributes: Set<string>,
): { positions: Float64Array; indices: Uint32Array } {
  const targets = optionalArray(primitive.targets, `${label}.targets`);
  if (targets.length > 0) {
    throw new UnsupportedInputError(
      `${label}.targets declares ${targets.length} morph target(s), which are not supported`,
    );
  }
  const mode = primitive.mode;
  if (
    mode !== undefined &&
    (typeof mode !== "number" || !Number.isInteger(mode))
  ) {
    throw new TypeError(`${label}.mode must be an integer`);
  }
  const resolvedMode = mode === undefined ? 4 : mode;
  if (resolvedMode !== 4) {
    const modeName = PRIMITIVE_MODE_NAMES[resolvedMode] ?? "unknown";
    throw new UnsupportedInputError(
      `${label}.mode ${resolvedMode} (${modeName}) is not supported; only mode 4 (TRIANGLES) is imported. Strip and fan topologies are deliberately not converted to indexed triangle lists, since doing so would silently change connectivity.`,
    );
  }

  const attributes = requireObject(primitive.attributes, `${label}.attributes`);
  if (attributes.JOINTS_0 !== undefined || attributes.WEIGHTS_0 !== undefined) {
    throw new UnsupportedInputError(
      `${label} declares joint/weight attributes, which indicate skinning and are not supported`,
    );
  }
  for (const attributeName of Object.keys(attributes)) {
    if (attributeName !== "POSITION") ignoredAttributes.add(attributeName);
  }
  if (typeof attributes.POSITION !== "number") {
    throw new TypeError(`${label}.attributes.POSITION is required`);
  }
  const positionIndex = requireIndex(
    attributes.POSITION,
    `${label}.attributes.POSITION`,
  );
  const positions = readPositionAccessor(
    accessors,
    positionIndex,
    `accessors[${positionIndex}] (${label}.attributes.POSITION)`,
    bufferViews,
  );
  const vertexCount = positions.length / 3;
  budget.vertexTotal += vertexCount;
  if (budget.vertexTotal > safetyVertexLimit) {
    throw new RangeError(
      "glTF geometry exceeds the importer vertex safety limit",
    );
  }

  let indices: Uint32Array;
  if (primitive.indices !== undefined) {
    const indicesIndex = requireIndex(primitive.indices, `${label}.indices`);
    indices = readIndexAccessor(
      accessors,
      indicesIndex,
      `accessors[${indicesIndex}] (${label}.indices)`,
      bufferViews,
    );
    for (let element = 0; element < indices.length; element += 1) {
      if (indices[element]! >= vertexCount) {
        throw new TypeError(
          `${label}.indices references vertex ${indices[element]}, beyond POSITION's ${vertexCount} vertices`,
        );
      }
    }
  } else {
    indices = Uint32Array.from({ length: vertexCount }, (_, i) => i);
  }

  if (indices.length % 3 !== 0) {
    throw new TypeError(
      `${label} must contain complete triangles (found ${indices.length} indices)`,
    );
  }
  budget.triangleTotal += indices.length / 3;
  checkedTriangleCount(
    budget.triangleTotal,
    triangleLimit,
    safetyTriangleLimit,
  );

  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Node transforms
// ---------------------------------------------------------------------------

function requireFiniteArray(
  value: unknown,
  length: number,
  label: string,
): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${label} must be an array of ${length} number(s)`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new TypeError(`${label}[${index}] must be a finite number`);
    }
    return entry;
  });
}

function composeTrs(
  translation: readonly number[],
  rotation: readonly number[],
  scale: readonly number[],
): Mat4 {
  const [x, y, z, w] = rotation as [number, number, number, number];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const r00 = 1 - 2 * (yy + zz);
  const r10 = 2 * (xy + wz);
  const r20 = 2 * (xz - wy);
  const r01 = 2 * (xy - wz);
  const r11 = 1 - 2 * (xx + zz);
  const r21 = 2 * (yz + wx);
  const r02 = 2 * (xz + wy);
  const r12 = 2 * (yz - wx);
  const r22 = 1 - 2 * (xx + yy);
  const [sx, sy, sz] = scale as [number, number, number];
  const [tx, ty, tz] = translation as [number, number, number];
  return [
    r00 * sx,
    r10 * sx,
    r20 * sx,
    0,
    r01 * sy,
    r11 * sy,
    r21 * sy,
    0,
    r02 * sz,
    r12 * sz,
    r22 * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ] as unknown as Mat4;
}

function resolveNodeTransform(
  node: Record<string, unknown>,
  label: string,
): Mat4 {
  if (node.matrix !== undefined) {
    if (
      node.translation !== undefined ||
      node.rotation !== undefined ||
      node.scale !== undefined
    ) {
      throw new TypeError(
        `${label} declares both matrix and translation/rotation/scale properties`,
      );
    }
    return requireFiniteArray(
      node.matrix,
      16,
      `${label}.matrix`,
    ) as unknown as Mat4;
  }
  const translation =
    node.translation === undefined
      ? [0, 0, 0]
      : requireFiniteArray(node.translation, 3, `${label}.translation`);
  const rotation =
    node.rotation === undefined
      ? [0, 0, 0, 1]
      : requireFiniteArray(node.rotation, 4, `${label}.rotation`);
  const scale =
    node.scale === undefined
      ? [1, 1, 1]
      : requireFiniteArray(node.scale, 3, `${label}.scale`);
  return composeTrs(translation, rotation, scale);
}

// ---------------------------------------------------------------------------
// Scene / node hierarchy
// ---------------------------------------------------------------------------

function resolveSceneRootIndices(
  doc: Record<string, unknown>,
  nodeObjects: readonly Record<string, unknown>[],
): number[] {
  const scenes = optionalArray(doc.scenes, "scenes").map((entry, index) =>
    requireObject(entry, `scenes[${index}]`),
  );
  let sceneIndex: number | undefined;
  if (doc.scene !== undefined) {
    sceneIndex = requireIndex(doc.scene, "scene");
    if (scenes[sceneIndex] === undefined) {
      throw new TypeError(`scene ${sceneIndex} does not exist`);
    }
  } else if (scenes.length === 1) {
    sceneIndex = 0;
  }
  if (sceneIndex !== undefined) {
    const scene = scenes[sceneIndex]!;
    return optionalArray(scene.nodes, `scenes[${sceneIndex}].nodes`).map(
      (entry, index) =>
        requireIndex(entry, `scenes[${sceneIndex}].nodes[${index}]`),
    );
  }
  // No default scene is declared and the scene is ambiguous or absent
  // (zero or multiple `scenes` entries with no `scene` index): fall back to
  // every node that is nobody's child, across the entire `nodes` array.
  // This is a deliberate, documented fallback (see README), not a silent
  // guess about geometry -- it only changes which nodes are treated as
  // roots of the hierarchy, never how any single node's own transform or
  // geometry is interpreted.
  const childIndices = new Set<number>();
  nodeObjects.forEach((node, index) => {
    for (const child of optionalArray(
      node.children,
      `nodes[${index}].children`,
    )) {
      if (typeof child === "number") childIndices.add(child);
    }
  });
  const roots: number[] = [];
  nodeObjects.forEach((_, index) => {
    if (!childIndices.has(index)) roots.push(index);
  });
  return roots;
}

interface HierarchyBuildResult {
  readonly nodes: ParsedGltfNode[];
  readonly instances: ParsedGltfInstance[];
  readonly cameraCount: number;
}

function buildHierarchy(
  nodeObjects: readonly Record<string, unknown>[],
  meshPrimitiveIds: readonly (readonly string[])[],
  rootIndices: readonly number[],
): HierarchyBuildResult {
  const emitted: ParsedGltfNode[] = [];
  const instances: ParsedGltfInstance[] = [];
  const visited = new Set<number>();
  const queue: number[] = [...rootIndices];
  let head = 0;
  let instanceCounter = 0;
  let cameraCount = 0;

  rootIndices.forEach((rootIndex, position) => {
    if (nodeObjects[rootIndex] === undefined) {
      throw new TypeError(
        `Scene root node ${rootIndex} (index ${position}) does not exist`,
      );
    }
  });

  while (head < queue.length) {
    const nodeIndex = queue[head]!;
    head += 1;
    if (visited.has(nodeIndex)) continue;
    visited.add(nodeIndex);

    const node = at(nodeObjects, nodeIndex, `nodes[${nodeIndex}]`);
    if (node.camera !== undefined) cameraCount += 1;
    if (node.skin !== undefined) {
      throw new UnsupportedInputError(
        `nodes[${nodeIndex}].skin indicates skinning, which is not supported`,
      );
    }
    if (node.weights !== undefined) {
      throw new UnsupportedInputError(
        `nodes[${nodeIndex}].weights indicates morph target weights, which are not supported`,
      );
    }
    const localToParent = resolveNodeTransform(node, `nodes[${nodeIndex}]`);
    const childIndices = optionalArray(
      node.children,
      `nodes[${nodeIndex}].children`,
    ).map((child, index) =>
      requireIndex(child, `nodes[${nodeIndex}].children[${index}]`),
    );
    childIndices.forEach((childIndex) => {
      if (nodeObjects[childIndex] === undefined) {
        throw new TypeError(
          `nodes[${nodeIndex}].children references unknown node ${childIndex}`,
        );
      }
    });

    const instanceIds: string[] = [];
    if (node.mesh !== undefined) {
      const meshIndex = requireIndex(node.mesh, `nodes[${nodeIndex}].mesh`);
      const primitiveIds = meshPrimitiveIds[meshIndex];
      if (primitiveIds === undefined) {
        throw new TypeError(
          `nodes[${nodeIndex}].mesh references unknown mesh ${meshIndex}`,
        );
      }
      for (const meshId of primitiveIds) {
        const instanceId = `instance.gltf.${instanceCounter}`;
        instanceCounter += 1;
        instances.push({ id: instanceId, meshId });
        instanceIds.push(instanceId);
      }
    }

    emitted.push({
      id: `node.gltf.${nodeIndex}`,
      childIds: childIndices.map((childIndex) => `node.gltf.${childIndex}`),
      instanceIds,
      localToParent,
    });
    for (const childIndex of childIndices) queue.push(childIndex);
  }

  return { nodes: emitted, instances, cameraCount };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export function parseGltf(
  bytes: Uint8Array,
  containerFormat: "gltf" | "glb",
  triangleLimit: number,
  safetyTriangleLimit: number,
  safetyVertexLimit: number,
): ParsedGltf {
  const { json, binaryChunk } =
    containerFormat === "glb"
      ? parseGlbContainer(bytes)
      : { json: decodeUtf8(bytes, "glTF"), binaryChunk: undefined };

  const doc = requireObject(parseJsonDocument(json), "glTF document");

  const asset = requireObject(doc.asset, "glTF asset");
  if (typeof asset.version !== "string") {
    throw new TypeError("glTF asset.version must be a string");
  }
  if (!/^2\.\d+$/u.test(asset.version)) {
    throw new UnsupportedInputError(
      `glTF asset.version ${JSON.stringify(asset.version)} is not supported; only glTF 2.x is supported`,
    );
  }

  const extensionsRequired = optionalArray(
    doc.extensionsRequired,
    "extensionsRequired",
  ).map((entry, index) => {
    if (typeof entry !== "string") {
      throw new TypeError(`extensionsRequired[${index}] must be a string`);
    }
    return entry;
  });
  if (extensionsRequired.length > 0) {
    throw new UnsupportedInputError(
      `glTF requires unsupported extension(s): ${extensionsRequired.join(", ")}`,
    );
  }
  const ignoredExtensions = optionalArray(
    doc.extensionsUsed,
    "extensionsUsed",
  ).map((entry, index) => {
    if (typeof entry !== "string") {
      throw new TypeError(`extensionsUsed[${index}] must be a string`);
    }
    return entry;
  });

  if (optionalArray(doc.animations, "animations").length > 0) {
    throw new UnsupportedInputError(
      "glTF animations are not supported by this static-geometry importer",
    );
  }
  if (optionalArray(doc.skins, "skins").length > 0) {
    throw new UnsupportedInputError(
      "glTF skins are not supported by this static-geometry importer",
    );
  }

  // Images are otherwise ignored entirely (never decoded), but an external
  // or relative image reference is still refused explicitly, matching every
  // other resource reference this importer accepts only as embedded bytes.
  optionalArray(doc.images, "images").forEach((entry, index) => {
    const image = requireObject(entry, `images[${index}]`);
    if (typeof image.uri === "string") {
      assertEmbeddedDataUri(image.uri, `images[${index}].uri`);
    }
  });

  const buffers = optionalArray(doc.buffers, "buffers").map((entry, index) =>
    resolveBuffer(entry, index, containerFormat, binaryChunk),
  );
  const bufferViews = optionalArray(doc.bufferViews, "bufferViews").map(
    (entry, index) => resolveBufferView(entry, index, buffers),
  );
  const accessors = optionalArray(doc.accessors, "accessors");
  const meshesJson = optionalArray(doc.meshes, "meshes");
  const nodesJson = optionalArray(doc.nodes, "nodes");

  const budget: PrimitiveBudget = { vertexTotal: 0, triangleTotal: 0 };
  const ignoredAttributes = new Set<string>();
  const meshRecords: ParsedGltfMesh[] = [];
  const meshPrimitiveIds: string[][] = meshesJson.map(
    (meshEntry, meshIndex) => {
      const mesh = requireObject(meshEntry, `meshes[${meshIndex}]`);
      if (mesh.weights !== undefined) {
        throw new UnsupportedInputError(
          `meshes[${meshIndex}].weights indicates morph targets, which are not supported`,
        );
      }
      const primitives = optionalArray(
        mesh.primitives,
        `meshes[${meshIndex}].primitives`,
      );
      if (primitives.length === 0) {
        throw new TypeError(
          `meshes[${meshIndex}] must declare at least one primitive`,
        );
      }
      return primitives.map((primitiveEntry, primitiveIndex) => {
        const label = `meshes[${meshIndex}].primitives[${primitiveIndex}]`;
        const { positions, indices } = resolvePrimitive(
          requireObject(primitiveEntry, label),
          label,
          accessors,
          bufferViews,
          budget,
          triangleLimit,
          safetyTriangleLimit,
          safetyVertexLimit,
          ignoredAttributes,
        );
        const id = `mesh.gltf.${meshIndex}.${primitiveIndex}`;
        meshRecords.push({ id, positions, indices });
        return id;
      });
    },
  );

  const nodeObjects = nodesJson.map((entry, index) =>
    requireObject(entry, `nodes[${index}]`),
  );
  const rootIndices = resolveSceneRootIndices(doc, nodeObjects);
  const { nodes, instances, cameraCount } = buildHierarchy(
    nodeObjects,
    meshPrimitiveIds,
    rootIndices,
  );

  if (instances.length === 0) {
    throw new UnsupportedInputError(
      "glTF document contains no static mesh geometry reachable from its default scene",
    );
  }

  return {
    meshes: meshRecords,
    nodes,
    sceneRootIds: rootIndices.map((index) => `node.gltf.${index}`),
    instances,
    ignoredAttributes: [...ignoredAttributes].sort(),
    ignoredMaterialCount: optionalArray(doc.materials, "materials").length,
    ignoredTextureCount: optionalArray(doc.textures, "textures").length,
    ignoredImageCount: optionalArray(doc.images, "images").length,
    ignoredSamplerCount: optionalArray(doc.samplers, "samplers").length,
    ignoredCameraCount: cameraCount,
    ignoredExtensions,
  };
}
