import { readZip } from "./archive.ts";
import {
  DEFAULT_LIMITS,
  type AssemblyNode,
  type GeometryProvenance,
  type ImportLimits,
  type ImportOptions,
  type ImportWarning,
  type MeshGeometry,
  type NormalizedModel,
  type SourceAxis,
  type SourceUnit,
  type TessellatedStepResult,
} from "./contracts.ts";
import {
  IDENTITY_4X4,
  Y_UP_TO_Z_UP,
  axisTransform,
  multiplyMatrices,
  normalizeMesh,
  unitScaleToMillimetres,
} from "./normalize.ts";

const IMPORTER = "geometry-formats-evidence/0";

export function importObj(
  source: string,
  options: ImportOptions,
): NormalizedModel {
  const positions: number[] = [];
  const indices: number[] = [];
  const warnings: ImportWarning[] = [];
  const unit = options.declaredUnit ?? "millimetre";
  const axis = options.declaredAxis ?? "right-handed-z-up";
  if (options.declaredUnit === undefined) {
    warnings.push({
      code: "ambiguous-unit",
      message:
        "OBJ does not declare units; millimetres were selected by policy",
    });
  }
  if (options.declaredAxis === undefined) {
    warnings.push({
      code: "ambiguous-axis",
      message:
        "OBJ does not declare an up axis; right-handed Z-up was selected by policy",
    });
  }

  for (const [lineIndex, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/u);
    if (fields[0] === "v") {
      if (fields.length < 4)
        throw new Error(`OBJ line ${lineIndex + 1} has an incomplete vertex`);
      positions.push(
        parseFinite(fields[1], "OBJ vertex"),
        parseFinite(fields[2], "OBJ vertex"),
        parseFinite(fields[3], "OBJ vertex"),
      );
    } else if (fields[0] === "f") {
      if (fields.length < 4)
        throw new Error(`OBJ line ${lineIndex + 1} has an incomplete face`);
      const face = fields.slice(1).map((field) => {
        const raw = Number.parseInt(field.split("/")[0] ?? "", 10);
        if (!Number.isInteger(raw) || raw === 0)
          throw new Error(`OBJ line ${lineIndex + 1} has an invalid index`);
        const resolved = raw > 0 ? raw - 1 : positions.length / 3 + raw;
        if (resolved < 0 || resolved >= positions.length / 3)
          throw new Error(`OBJ line ${lineIndex + 1} index is out of range`);
        return resolved;
      });
      for (let index = 1; index + 1 < face.length; index += 1) {
        indices.push(face[0] ?? 0, face[index] ?? 0, face[index + 1] ?? 0);
      }
    }
  }
  enforceTriangleLimit(indices.length / 3, options.limits);
  const normalized = normalizeMesh(positions, indices, unit, axis);
  return model(
    "obj",
    options.sourceName,
    unit,
    axis,
    [normalized.mesh],
    [...warnings, ...normalized.warnings],
    [
      "Polygon faces are fan-triangulated; material and smoothing data are not evaluated",
    ],
  );
}

export function importStl(
  source: string | Uint8Array,
  options: ImportOptions,
): NormalizedModel {
  const bytes =
    typeof source === "string" ? new TextEncoder().encode(source) : source;
  const binary = isBinaryStl(bytes);
  const triangles = binary
    ? readBinaryStl(bytes)
    : readAsciiStl(new TextDecoder().decode(bytes));
  enforceTriangleLimit(triangles.length / 9, options.limits);
  const { positions, indices } = indexTriangleSoup(triangles);
  const unit = options.declaredUnit ?? "millimetre";
  const axis = options.declaredAxis ?? "right-handed-z-up";
  const warnings: ImportWarning[] = [];
  if (options.declaredUnit === undefined)
    warnings.push({
      code: "ambiguous-unit",
      message:
        "STL has no standard unit field; millimetres were selected by policy",
    });
  if (options.declaredAxis === undefined)
    warnings.push({
      code: "ambiguous-axis",
      message:
        "STL has no standard up-axis field; right-handed Z-up was selected by policy",
    });
  const normalized = normalizeMesh(positions, indices, unit, axis);
  return model(
    "stl",
    options.sourceName,
    unit,
    axis,
    [normalized.mesh],
    [...warnings, ...normalized.warnings],
    [
      binary
        ? "Binary STL facet normals were not trusted"
        : "ASCII STL facet normals were not trusted",
    ],
  );
}

export async function importThreeMf(
  source: Uint8Array,
  options: ImportOptions,
): Promise<NormalizedModel> {
  const entries = await readZip(
    source,
    options.limits,
    options.allowUnboundedDeflate ?? false,
  );
  const modelEntries = entries.filter((entry) =>
    entry.name.toLowerCase().endsWith(".model"),
  );
  if (modelEntries.length !== 1)
    throw new Error(
      `Expected one 3MF model part, found ${modelEntries.length}`,
    );
  const xml = new TextDecoder().decode(modelEntries[0]?.bytes);
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml))
    throw new Error("3MF XML declarations and entities are rejected");
  const unit = parseThreeMfUnit(
    attribute(firstTag(xml, "model"), "unit") ?? "millimeter",
  );
  const meshByObject = new Map<string, number>();
  const meshes: MeshGeometry[] = [];
  const warnings: ImportWarning[] = [];
  const objectBlocks = tagsWithBody(xml, "object");
  let totalTriangles = 0;

  for (const object of objectBlocks) {
    const id = requiredAttribute(object.open, "id");
    const meshBody = tagsWithBody(object.body, "mesh")[0]?.body;
    if (meshBody === undefined) continue;
    const vertexTags = allTags(meshBody, "vertex");
    const triangleTags = allTags(meshBody, "triangle");
    totalTriangles += triangleTags.length;
    enforceTriangleLimit(totalTriangles, options.limits);
    const positions = vertexTags.flatMap((tag) => [
      parseFinite(attribute(tag, "x"), "3MF vertex"),
      parseFinite(attribute(tag, "y"), "3MF vertex"),
      parseFinite(attribute(tag, "z"), "3MF vertex"),
    ]);
    const indices = triangleTags.flatMap((tag) => [
      parseInteger(attribute(tag, "v1"), "3MF triangle"),
      parseInteger(attribute(tag, "v2"), "3MF triangle"),
      parseInteger(attribute(tag, "v3"), "3MF triangle"),
    ]);
    const normalized = normalizeMesh(
      positions,
      indices,
      unit,
      "right-handed-z-up",
    );
    meshByObject.set(id, meshes.length);
    meshes.push(normalized.mesh);
    warnings.push(...normalized.warnings);
  }

  const assembly = buildThreeMfAssembly(xml, objectBlocks, meshByObject, unit);
  return model(
    "3mf",
    options.sourceName,
    unit,
    "right-handed-z-up",
    meshes,
    warnings,
    [
      "Core meshes, identity component references, build items, and build transforms were evaluated; component-local transforms and extensions were rejected",
    ],
    assembly,
  );
}

export function importGltf(
  source: string | Uint8Array,
  options: ImportOptions,
): NormalizedModel {
  const { json, binaryChunk } = decodeGltf(source);
  if (json.animations !== undefined)
    throw new Error(
      "Animated glTF is rejected by this static evidence importer",
    );
  const buffers = decodeGltfBuffers(json, binaryChunk);
  const meshes: MeshGeometry[] = [];
  const warnings: ImportWarning[] = [];
  const meshMap = new Map<number, number>();
  let totalTriangles = 0;
  const rawMeshes = asArray(json.meshes, "glTF meshes");
  for (const [meshIndex, rawMesh] of rawMeshes.entries()) {
    const meshObject = asObject(rawMesh, "glTF mesh");
    const primitives = asArray(meshObject.primitives, "glTF primitives");
    if (primitives.length !== 1)
      throw new Error(
        "Evidence importer accepts one TRIANGLES primitive per glTF mesh",
      );
    const primitive = asObject(primitives[0], "glTF primitive");
    if (primitive.mode !== undefined && primitive.mode !== 4)
      throw new Error("Only glTF TRIANGLES primitives are accepted");
    if (primitive.targets !== undefined)
      throw new Error("glTF primitive morph targets are rejected");
    const attributes = asObject(primitive.attributes, "glTF attributes");
    const positions = readGltfAccessor(
      json,
      buffers,
      asInteger(attributes.POSITION, "POSITION accessor"),
      "VEC3",
    );
    const indices =
      primitive.indices === undefined
        ? Array.from({ length: positions.length / 3 }, (_, index) => index)
        : readGltfAccessor(
            json,
            buffers,
            asInteger(primitive.indices, "index accessor"),
            "SCALAR",
          );
    totalTriangles += indices.length / 3;
    enforceTriangleLimit(totalTriangles, options.limits);
    const normalized = normalizeMesh(
      positions,
      indices,
      "metre",
      "right-handed-y-up",
    );
    meshMap.set(meshIndex, meshes.length);
    meshes.push(normalized.mesh);
    warnings.push(...normalized.warnings);
  }
  const assembly = buildGltfAssembly(json, meshMap);
  return model(
    "gltf",
    options.sourceName,
    "metre",
    "right-handed-y-up",
    meshes,
    warnings,
    [
      "Static triangle meshes and node transforms were evaluated; animation, skinning, morphing, compression, and materials were not evaluated",
    ],
    assembly,
  );
}

export function normalizeStepTessellation(
  result: TessellatedStepResult,
): NormalizedModel {
  if (!(result.linearDeflection > 0) || !(result.angularDeflection > 0)) {
    throw new Error(
      "STEP tessellation tolerances must be positive and explicit",
    );
  }
  const meshes: MeshGeometry[] = [];
  const warnings: ImportWarning[] = [];
  for (const source of result.meshes) {
    const normalized = normalizeMesh(
      source.positions,
      source.indices,
      source.sourceUnit,
      source.sourceAxis,
    );
    meshes.push(normalized.mesh);
    warnings.push(...normalized.warnings);
  }
  for (const warning of result.warnings ?? [])
    warnings.push({ code: "unsupported-feature", message: warning });
  const sourceUnit = result.meshes[0]?.sourceUnit ?? "millimetre";
  const sourceAxis = result.meshes[0]?.sourceAxis ?? "right-handed-z-up";
  if (
    result.meshes.some(
      (mesh) =>
        mesh.sourceUnit !== sourceUnit || mesh.sourceAxis !== sourceAxis,
    )
  ) {
    throw new Error(
      "A STEP tessellator result must use one source unit and axis convention",
    );
  }
  const scale = unitScaleToMillimetres(sourceUnit);
  const assembly = result.assembly.map((node) => ({
    ...node,
    transform: normalizeNodeTransform(node.transform, sourceAxis, scale),
  }));
  return model(
    "step-tessellation",
    result.sourceName,
    sourceUnit,
    sourceAxis,
    meshes,
    warnings,
    [
      `Tessellator: ${result.tessellator}`,
      `Linear deflection: ${result.linearDeflection} source units`,
      `Angular deflection: ${result.angularDeflection} radians`,
      "B-rep interpretation and tessellation happen outside this prototype boundary",
    ],
    assembly,
  );
}

function model(
  format: GeometryProvenance["format"],
  sourceName: string,
  sourceUnit: SourceUnit,
  sourceAxis: SourceAxis,
  meshes: readonly MeshGeometry[],
  warnings: readonly ImportWarning[],
  notes: readonly string[],
  assembly?: readonly AssemblyNode[],
): NormalizedModel {
  const base = {
    coordinateSystem: "right-handed-z-up" as const,
    unit: "millimetre" as const,
    meshes,
    warnings,
    provenance: {
      format,
      importer: IMPORTER,
      sourceName,
      sourceUnit,
      sourceAxis,
      sourceToMillimetres: unitScaleToMillimetres(sourceUnit),
      sourceToZUp: axisTransform(sourceAxis),
      notes,
    },
  };
  return assembly === undefined ? base : { ...base, assembly };
}

function readAsciiStl(source: string): number[] {
  const vertices = [
    ...source.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/giu),
  ];
  if (vertices.length === 0 || vertices.length % 3 !== 0)
    throw new Error("Malformed ASCII STL triangle soup");
  return vertices.flatMap((match) => [
    parseFinite(match[1], "STL vertex"),
    parseFinite(match[2], "STL vertex"),
    parseFinite(match[3], "STL vertex"),
  ]);
}

function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const count = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(80, true);
  return bytes.byteLength === 84 + count * 50;
}

function readBinaryStl(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (bytes.byteLength !== 84 + count * 50)
    throw new Error("Malformed binary STL length");
  const output: number[] = [];
  for (let triangle = 0; triangle < count; triangle += 1) {
    const base = 84 + triangle * 50 + 12;
    for (let coordinate = 0; coordinate < 9; coordinate += 1)
      output.push(view.getFloat32(base + coordinate * 4, true));
  }
  return output;
}

function indexTriangleSoup(triangles: readonly number[]): {
  positions: number[];
  indices: number[];
} {
  const positions: number[] = [];
  const indices: number[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < triangles.length; index += 3) {
    const point = [
      triangles[index] ?? 0,
      triangles[index + 1] ?? 0,
      triangles[index + 2] ?? 0,
    ];
    const key = point.join(",");
    let vertex = seen.get(key);
    if (vertex === undefined) {
      vertex = positions.length / 3;
      seen.set(key, vertex);
      positions.push(...point);
    }
    indices.push(vertex);
  }
  return { positions, indices };
}

function decodeGltf(source: string | Uint8Array): {
  json: Record<string, unknown>;
  binaryChunk?: Uint8Array;
} {
  if (typeof source === "string")
    return { json: asObject(JSON.parse(source), "glTF") };
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  if (source.byteLength >= 12 && view.getUint32(0, true) === 0x46546c67) {
    if (
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== source.byteLength
    )
      throw new Error("Malformed GLB header");
    let offset = 12;
    let json: Record<string, unknown> | undefined;
    let binaryChunk: Uint8Array | undefined;
    while (offset < source.byteLength) {
      if (offset + 8 > source.byteLength)
        throw new Error("Truncated GLB chunk header");
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      if (offset + 8 + length > source.byteLength)
        throw new Error("Truncated GLB chunk");
      const bytes = source.slice(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a)
        json = asObject(
          JSON.parse(new TextDecoder().decode(bytes).trim()),
          "GLB JSON",
        );
      if (type === 0x004e4942) binaryChunk = bytes;
      offset += 8 + length;
    }
    if (json === undefined) throw new Error("GLB JSON chunk missing");
    return binaryChunk === undefined ? { json } : { json, binaryChunk };
  }
  return {
    json: asObject(JSON.parse(new TextDecoder().decode(source)), "glTF"),
  };
}

function decodeGltfBuffers(
  json: Record<string, unknown>,
  binaryChunk?: Uint8Array,
): readonly Uint8Array[] {
  return asArray(json.buffers, "glTF buffers").map((raw, index) => {
    const buffer = asObject(raw, "glTF buffer");
    if (buffer.uri === undefined) {
      if (index !== 0 || binaryChunk === undefined)
        throw new Error("glTF buffer has no data source");
      return binaryChunk;
    }
    if (
      typeof buffer.uri !== "string" ||
      !buffer.uri.startsWith("data:application/octet-stream;base64,")
    ) {
      throw new Error(
        "External glTF resources are rejected by this evidence importer",
      );
    }
    return decodeBase64(buffer.uri.slice(buffer.uri.indexOf(",") + 1));
  });
}

function readGltfAccessor(
  json: Record<string, unknown>,
  buffers: readonly Uint8Array[],
  accessorIndex: number,
  expectedType: "SCALAR" | "VEC3",
): number[] {
  const accessor = asObject(
    asArray(json.accessors, "glTF accessors")[accessorIndex],
    "glTF accessor",
  );
  if (accessor.type !== expectedType || accessor.sparse !== undefined)
    throw new Error(`Unsupported glTF ${expectedType} accessor`);
  const componentType = asInteger(
    accessor.componentType,
    "glTF component type",
  );
  if (accessor.normalized === true)
    throw new Error("Normalized glTF geometry accessors are unsupported");
  const count = asInteger(accessor.count, "glTF accessor count");
  const view = asObject(
    asArray(json.bufferViews, "glTF bufferViews")[
      asInteger(accessor.bufferView, "glTF bufferView")
    ],
    "glTF bufferView",
  );
  const bytes = buffers[asInteger(view.buffer, "glTF buffer index")];
  if (bytes === undefined) throw new Error("glTF buffer index is out of range");
  const components = expectedType === "VEC3" ? 3 : 1;
  const componentBytes =
    componentType === 5126 || componentType === 5125
      ? 4
      : componentType === 5123
        ? 2
        : componentType === 5121
          ? 1
          : 0;
  if (
    componentBytes === 0 ||
    (expectedType === "VEC3" && componentType !== 5126) ||
    (expectedType === "SCALAR" && ![5121, 5123, 5125].includes(componentType))
  )
    throw new Error("Unsupported glTF accessor component type");
  const stride =
    typeof view.byteStride === "number"
      ? view.byteStride
      : components * componentBytes;
  const base =
    asOptionalInteger(view.byteOffset) + asOptionalInteger(accessor.byteOffset);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output: number[] = [];
  for (let item = 0; item < count; item += 1) {
    for (let component = 0; component < components; component += 1) {
      const offset = base + item * stride + component * componentBytes;
      if (offset + componentBytes > data.byteLength)
        throw new Error("glTF accessor exceeds its buffer");
      output.push(
        componentType === 5126
          ? data.getFloat32(offset, true)
          : componentType === 5125
            ? data.getUint32(offset, true)
            : componentType === 5123
              ? data.getUint16(offset, true)
              : data.getUint8(offset),
      );
    }
  }
  return output;
}

function buildGltfAssembly(
  json: Record<string, unknown>,
  meshMap: ReadonlyMap<number, number>,
): AssemblyNode[] {
  const nodes = asArray(json.nodes ?? [], "glTF nodes");
  return nodes.map((raw, index) => {
    const node = asObject(raw, "glTF node");
    if (node.skin !== undefined || node.weights !== undefined)
      throw new Error("Skinned and morphed glTF nodes are not static geometry");
    const matrix =
      node.matrix === undefined
        ? composeTrs(node)
        : asNumberArray(node.matrix, 16, "glTF node matrix");
    const mesh =
      node.mesh === undefined
        ? undefined
        : meshMap.get(asInteger(node.mesh, "glTF node mesh"));
    const base = {
      id: `node-${index}`,
      children: asArray(node.children ?? [], "glTF children").map((child) =>
        asInteger(child, "glTF child"),
      ),
      transform: normalizeNodeTransform(matrix, "right-handed-y-up", 1000),
    };
    return {
      ...base,
      ...(typeof node.name === "string" ? { name: node.name } : {}),
      ...(mesh === undefined ? {} : { mesh }),
    };
  });
}

function composeTrs(node: Record<string, unknown>): number[] {
  const translation =
    node.translation === undefined
      ? [0, 0, 0]
      : asNumberArray(node.translation, 3, "glTF translation");
  const scale =
    node.scale === undefined
      ? [1, 1, 1]
      : asNumberArray(node.scale, 3, "glTF scale");
  const rotation =
    node.rotation === undefined
      ? [0, 0, 0, 1]
      : asNumberArray(node.rotation, 4, "glTF rotation");
  const [x = 0, y = 0, z = 0, w = 1] = rotation;
  const [sx = 1, sy = 1, sz = 1] = scale;
  return [
    (1 - 2 * y * y - 2 * z * z) * sx,
    (2 * x * y + 2 * z * w) * sx,
    (2 * x * z - 2 * y * w) * sx,
    0,
    (2 * x * y - 2 * z * w) * sy,
    (1 - 2 * x * x - 2 * z * z) * sy,
    (2 * y * z + 2 * x * w) * sy,
    0,
    (2 * x * z + 2 * y * w) * sz,
    (2 * y * z - 2 * x * w) * sz,
    (1 - 2 * x * x - 2 * y * y) * sz,
    0,
    translation[0] ?? 0,
    translation[1] ?? 0,
    translation[2] ?? 0,
    1,
  ];
}

function buildThreeMfAssembly(
  xml: string,
  objects: readonly { open: string; body: string }[],
  meshByObject: ReadonlyMap<string, number>,
  unit: SourceUnit,
): AssemblyNode[] {
  const objectIndex = new Map<string, number>();
  objects.forEach((object, index) =>
    objectIndex.set(requiredAttribute(object.open, "id"), index),
  );
  const scale = unitScaleToMillimetres(unit);
  const nodes: AssemblyNode[] = objects.map((object, index) => {
    const id = requiredAttribute(object.open, "id");
    const components = allTags(object.body, "component");
    if (components.some((tag) => attribute(tag, "transform") !== undefined))
      throw new Error(
        "3MF component-local transforms are rejected by this evidence importer",
      );
    const mesh = meshByObject.get(id);
    const name = attribute(object.open, "name");
    const base = {
      id: `object-${id}`,
      children: components.map(
        (tag) => objectIndex.get(requiredAttribute(tag, "objectid")) ?? -1,
      ),
      transform: [...IDENTITY_4X4],
    };
    return {
      ...base,
      ...(name === undefined ? {} : { name }),
      ...(mesh === undefined ? {} : { mesh }),
    };
  });
  for (const build of tagsWithBody(xml, "build")) {
    for (const [itemIndex, tag] of allTags(build.body, "item").entries()) {
      const objectId = requiredAttribute(tag, "objectid");
      const child = objectIndex.get(objectId);
      if (child === undefined)
        throw new Error(`3MF build references missing object ${objectId}`);
      nodes.push({
        id: `build-${itemIndex}`,
        children: [child],
        transform: normalizeNodeTransform(
          parseThreeMfTransform(attribute(tag, "transform")),
          "right-handed-z-up",
          scale,
        ),
      });
    }
  }
  if (nodes.some((node) => node.children.includes(-1)))
    throw new Error("3MF component references a missing object");
  return nodes;
}

function parseThreeMfTransform(value: string | undefined): number[] {
  if (value === undefined) return [...IDENTITY_4X4];
  const fields = value.trim().split(/\s+/u).map(Number);
  if (fields.length !== 12 || fields.some((field) => !Number.isFinite(field)))
    throw new Error("Invalid 3MF transform");
  return [
    fields[0] ?? 0,
    fields[1] ?? 0,
    fields[2] ?? 0,
    0,
    fields[3] ?? 0,
    fields[4] ?? 0,
    fields[5] ?? 0,
    0,
    fields[6] ?? 0,
    fields[7] ?? 0,
    fields[8] ?? 0,
    0,
    fields[9] ?? 0,
    fields[10] ?? 0,
    fields[11] ?? 0,
    1,
  ];
}

function normalizeNodeTransform(
  matrix: readonly number[],
  axis: SourceAxis,
  scale: number,
): number[] {
  const scaled = [...matrix];
  scaled[12] = (scaled[12] ?? 0) * scale;
  scaled[13] = (scaled[13] ?? 0) * scale;
  scaled[14] = (scaled[14] ?? 0) * scale;
  if (axis === "right-handed-z-up") return scaled;
  const inverse = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  return multiplyMatrices(Y_UP_TO_Z_UP, multiplyMatrices(scaled, inverse));
}

function parseThreeMfUnit(value: string): SourceUnit {
  const units: Record<string, SourceUnit> = {
    micron: "micrometre",
    millimeter: "millimetre",
    centimeter: "centimetre",
    meter: "metre",
    inch: "inch",
    foot: "foot",
  };
  const unit = units[value];
  if (unit === undefined) throw new Error(`Unsupported 3MF unit: ${value}`);
  return unit;
}

function firstTag(xml: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>`, "iu").exec(xml)?.[0];
  if (match === undefined) throw new Error(`Missing <${name}> element`);
  return match;
}

function allTags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*(?:/?>)`, "giu"))].map(
    (match) => match[0] ?? "",
  );
}

function tagsWithBody(
  xml: string,
  name: string,
): { open: string; body: string }[] {
  return [
    ...xml.matchAll(
      new RegExp(`(<${name}\\b[^>]*>)([\\s\\S]*?)</${name}>`, "giu"),
    ),
  ].map((match) => ({ open: match[1] ?? "", body: match[2] ?? "" }));
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "iu").exec(tag)?.[1];
}

function requiredAttribute(tag: string, name: string): string {
  const value = attribute(tag, name);
  if (value === undefined) throw new Error(`Missing ${name} attribute`);
  return value;
}

function parseFinite(value: string | undefined, context: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed))
    throw new Error(`${context} is not finite`);
  return parsed;
}

function parseInteger(value: string | undefined, context: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${context} is not a non-negative integer`);
  return parsed;
}

function enforceTriangleLimit(
  count: number,
  overrides?: Partial<ImportLimits>,
): void {
  const limit = { ...DEFAULT_LIMITS, ...overrides }.maxTriangles;
  if (!Number.isSafeInteger(count) || count > limit)
    throw new Error(`Triangle count ${count} exceeds limit ${limit}`);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value;
}

function asInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value))
    throw new Error(`${context} must be an integer`);
  return value as number;
}

function asOptionalInteger(value: unknown): number {
  return value === undefined ? 0 : asInteger(value, "glTF byte offset");
}

function asNumberArray(
  value: unknown,
  length: number,
  context: string,
): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new Error(`${context} must contain ${length} finite numbers`);
  }
  return value as number[];
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
