import type { Mat4, SourceUnit } from "@voxelspy/contracts";
import { UnsafeArchiveError, UnsupportedInputError } from "./errors.js";
import {
  checkedTriangleCount,
  decodeUtf8,
  parseFiniteDecimal,
} from "./parse.js";
import {
  readZipCentralDirectory,
  readZipEntry,
  type ArchiveSafetyLimits,
} from "./zip.js";
import {
  parseXmlDocument,
  type XmlElement,
  type XmlSafetyLimits,
} from "./xml.js";

// ---------------------------------------------------------------------------
// Public shapes -- mirrors `src/gltf.ts`'s `ParsedGltf`: this module only
// reads bytes the file provides, in the file's own (unscaled) unit. Frame
// resolution (unit/axis) and final `NormalizedModel` assembly are the
// caller's job (`src/index.ts`'s `createThreeMfModel`).
// ---------------------------------------------------------------------------

export interface ParsedThreeMfMesh {
  readonly id: string;
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

export interface ParsedThreeMfNode {
  readonly id: string;
  readonly childIds: readonly string[];
  readonly instanceIds: readonly string[];
  readonly localToParent: Mat4;
}

export interface ParsedThreeMfInstance {
  readonly id: string;
  readonly meshId: string;
}

export interface ParsedThreeMf {
  readonly meshes: readonly ParsedThreeMfMesh[];
  readonly nodes: readonly ParsedThreeMfNode[];
  /** Children of the synthetic frame node: one per `<build><item>`, in document order. */
  readonly itemRootIds: readonly string[];
  readonly instances: readonly ParsedThreeMfInstance[];
  /** The `<model unit="...">` value (or its spec default), resolved to this package's unit vocabulary. */
  readonly detectedUnit: Exclude<SourceUnit, "unknown">;
  readonly ignoredMetadataCount: number;
  readonly ignoredMaterialCount: number;
  readonly ignoredThumbnailCount: number;
  readonly ignoredLabelCount: number;
  readonly ignoredResourceElements: readonly string[];
  readonly ignoredExtensionNamespaces: readonly string[];
  readonly recommendedExtensions: readonly string[];
  readonly unreferencedObjectCount: number;
}

export interface ThreeMfParseLimits {
  readonly archive: ArchiveSafetyLimits;
  readonly xml: XmlSafetyLimits;
  readonly triangleLimit: number;
  readonly safetyTriangleLimit: number;
  readonly safetyVertexLimit: number;
  readonly hierarchyNodeLimit: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORE_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const MODEL_RELATIONSHIP_TYPE =
  "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const MODEL_CONTENT_TYPE =
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";

const UNIT_MAP: Readonly<Record<string, Exclude<SourceUnit, "unknown">>> = {
  micron: "micrometre",
  millimeter: "millimetre",
  centimeter: "centimetre",
  inch: "inch",
  foot: "foot",
  meter: "metre",
};

type ObjectType = "model" | "solidsupport" | "support" | "surface" | "other";
const OBJECT_TYPES = new Set<ObjectType>([
  "model",
  "solidsupport",
  "support",
  "surface",
  "other",
]);

interface MeshObject {
  readonly kind: "mesh";
  readonly type: ObjectType;
  readonly meshId: string;
}
interface ComponentsObject {
  readonly kind: "components";
  readonly type: ObjectType;
  readonly components: readonly { objectId: string; transform: Mat4 }[];
}
type ObjectDef = MeshObject | ComponentsObject;

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function parseThreeMf(
  bytes: Uint8Array,
  limits: ThreeMfParseLimits,
): Promise<ParsedThreeMf> {
  const archive = readZipCentralDirectory(bytes, limits.archive);
  const aggregate = { consumedBytes: 0 };

  const modelPath = await resolveModelPartPath(
    bytes,
    archive,
    limits,
    aggregate,
  );
  const modelEntry =
    archive.byName.get(modelPath) ?? archive.byName.get(`/${modelPath}`);
  if (!modelEntry) {
    throw new TypeError(
      `3MF package does not contain its declared 3D model part: ${modelPath}`,
    );
  }
  const modelBytes = await readZipEntry(
    bytes,
    modelEntry,
    limits.archive,
    aggregate,
  );
  const modelText = decodeUtf8(modelBytes, "3MF model part");
  const modelRoot = parseXmlDocument(modelText, limits.xml);

  if (modelRoot.prefix !== undefined || modelRoot.tag !== "model") {
    throw new TypeError("3MF model part's root element is not <model>");
  }
  const defaultNamespace = modelRoot.attributes.get("xmlns");
  if (defaultNamespace !== CORE_NAMESPACE) {
    throw new UnsupportedInputError(
      "3MF model part does not declare the 3MF Core default namespace",
    );
  }

  const requiredExtensions = splitTokenList(
    modelRoot.attributes.get("requiredextensions"),
  );
  if (requiredExtensions.length > 0) {
    throw new UnsupportedInputError(
      `3MF model requires unsupported extension(s): ${requiredExtensions.join(", ")}`,
    );
  }
  const recommendedExtensions = splitTokenList(
    modelRoot.attributes.get("recommendedextensions"),
  );

  const unitToken = modelRoot.attributes.get("unit") ?? "millimeter";
  const detectedUnit = UNIT_MAP[unitToken];
  if (!detectedUnit) {
    throw new TypeError(`3MF model declares an unsupported unit: ${unitToken}`);
  }

  const resourcesEl = requireSingleChild(modelRoot, "resources", "<model>");
  const buildEl = requireSingleChild(modelRoot, "build", "<model>");
  const ignoredMetadataCount = coreChildren(modelRoot, "metadata").length;

  const extensionNamespaces = new Set<string>();
  collectPrefixes(modelRoot, extensionNamespaces);

  let ignoredMaterialCount = 0;
  let ignoredThumbnailCount = 0;
  let ignoredLabelCount = 0;
  const ignoredResourceElements = new Set<string>();
  const objects = new Map<string, ObjectDef>();
  const meshRecords: ParsedThreeMfMesh[] = [];
  const budget = { vertexTotal: 0, triangleTotal: 0 };

  for (const child of resourcesEl.children) {
    if (child.prefix !== undefined) {
      extensionNamespaces.add(child.prefix);
      continue;
    }
    if (child.tag === "object") {
      const { id, def, mesh } = parseObject(child, budget, limits);
      if (objects.has(id)) {
        throw new TypeError(`3MF document declares duplicate object id ${id}`);
      }
      objects.set(id, def);
      if (mesh) meshRecords.push(mesh);
      if (child.attributes.has("pid")) ignoredMaterialCount += 1;
      if (
        child.attributes.has("thumbnail") &&
        child.attributes.get("thumbnail") !== undefined
      ) {
        ignoredThumbnailCount += 1;
      }
      if (child.attributes.has("partnumber") || child.attributes.has("name")) {
        ignoredLabelCount += 1;
      }
      continue;
    }
    if (child.tag === "basematerials") {
      ignoredMaterialCount += 1;
      continue;
    }
    if (child.tag === "metadata") {
      continue;
    }
    ignoredResourceElements.add(child.tag);
  }

  const items: { objectId: string; transform: Mat4 }[] = [];
  for (const child of buildEl.children) {
    if (child.prefix !== undefined) {
      extensionNamespaces.add(child.prefix);
      continue;
    }
    if (child.tag === "metadata") continue;
    if (child.tag !== "item") {
      ignoredResourceElements.add(child.tag);
      continue;
    }
    assertNoProductionPath(child, "<item>");
    const objectId = requireResourceId(child, "objectid", "<item>");
    const transform = parseOptionalTransform(child, "<item>");
    if (child.attributes.has("partnumber")) ignoredLabelCount += 1;
    items.push({ objectId, transform });
  }
  if (items.length === 0) {
    throw new TypeError("3MF <build> contains no <item> elements to import");
  }

  const nodes: ParsedThreeMfNode[] = [];
  const instances: ParsedThreeMfInstance[] = [];
  const referencedObjectIds = new Set<string>();
  let nodeCounter = 0;
  let instanceCounter = 0;

  function placeObject(
    objectId: string,
    localToParent: Mat4,
    visiting: ReadonlySet<string>,
  ): string {
    if (nodes.length + 1 > limits.hierarchyNodeLimit) {
      throw new RangeError(
        "3MF component/build hierarchy exceeds the importer's node-count safety limit",
      );
    }
    if (visiting.has(objectId)) {
      throw new TypeError(
        `3MF component references form a cycle at object id ${objectId}`,
      );
    }
    const object = objects.get(objectId);
    if (!object) {
      throw new TypeError(`3MF references unknown object id ${objectId}`);
    }
    if (object.type === "other") {
      throw new TypeError(
        `3MF build references object id ${objectId} of type "other", either directly or through a component, which is not permitted`,
      );
    }
    referencedObjectIds.add(objectId);
    const nodeId = `node.3mf.${nodeCounter}`;
    nodeCounter += 1;
    const childIds: string[] = [];
    const instanceIds: string[] = [];
    if (object.kind === "mesh") {
      const instanceId = `instance.3mf.${instanceCounter}`;
      instanceCounter += 1;
      instances.push({ id: instanceId, meshId: object.meshId });
      instanceIds.push(instanceId);
    } else {
      const nextVisiting = new Set(visiting);
      nextVisiting.add(objectId);
      for (const component of object.components) {
        childIds.push(
          placeObject(component.objectId, component.transform, nextVisiting),
        );
      }
    }
    nodes.push({ id: nodeId, childIds, instanceIds, localToParent });
    return nodeId;
  }

  const itemRootIds = items.map((item) =>
    placeObject(item.objectId, item.transform, new Set()),
  );

  return {
    meshes: meshRecords,
    nodes,
    itemRootIds,
    instances,
    detectedUnit,
    ignoredMetadataCount,
    ignoredMaterialCount,
    ignoredThumbnailCount,
    ignoredLabelCount,
    ignoredResourceElements: [...ignoredResourceElements].sort(),
    ignoredExtensionNamespaces: [...extensionNamespaces].sort(),
    recommendedExtensions,
    unreferencedObjectCount: objects.size - referencedObjectIds.size,
  };
}

// ---------------------------------------------------------------------------
// OPC container part resolution
// ---------------------------------------------------------------------------

async function resolveModelPartPath(
  bytes: Uint8Array,
  archive: ReturnType<typeof readZipCentralDirectory>,
  limits: ThreeMfParseLimits,
  aggregate: { consumedBytes: number },
): Promise<string> {
  const relsEntry = archive.byName.get("_rels/.rels");
  if (!relsEntry) {
    throw new TypeError(
      "3MF package is missing its OPC root relationships part (_rels/.rels)",
    );
  }
  const relsBytes = await readZipEntry(
    bytes,
    relsEntry,
    limits.archive,
    aggregate,
  );
  const relsRoot = parseXmlDocument(
    decodeUtf8(relsBytes, "3MF _rels/.rels"),
    limits.xml,
  );
  const modelRelationships = relsRoot.children.filter(
    (child) =>
      child.prefix === undefined &&
      child.tag === "Relationship" &&
      child.attributes.get("Type") === MODEL_RELATIONSHIP_TYPE,
  );
  if (modelRelationships.length !== 1) {
    throw new TypeError(
      `3MF OPC root relationships must declare exactly one 3D model relationship (found ${modelRelationships.length})`,
    );
  }
  const relationship = modelRelationships[0]!;
  if (relationship.attributes.get("TargetMode") === "External") {
    throw new UnsupportedInputError(
      "3MF 3D model relationship targets an external resource, which is not supported",
    );
  }
  const target = relationship.attributes.get("Target");
  if (!target) {
    throw new TypeError("3MF 3D model relationship has no Target attribute");
  }
  const modelPath = target.startsWith("/") ? target.slice(1) : target;

  const contentTypesEntry = archive.byName.get("[Content_Types].xml");
  if (!contentTypesEntry) {
    throw new TypeError(
      "3MF package is missing its OPC content types part ([Content_Types].xml)",
    );
  }
  const contentTypesBytes = await readZipEntry(
    bytes,
    contentTypesEntry,
    limits.archive,
    aggregate,
  );
  const contentTypesRoot = parseXmlDocument(
    decodeUtf8(contentTypesBytes, "3MF [Content_Types].xml"),
    limits.xml,
  );
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const child of contentTypesRoot.children) {
    if (child.prefix !== undefined) continue;
    if (child.tag === "Default") {
      const extension = child.attributes.get("Extension");
      const contentType = child.attributes.get("ContentType");
      if (extension && contentType) {
        defaults.set(extension.toLowerCase(), contentType);
      }
      continue;
    }
    if (child.tag === "Override") {
      const partName = child.attributes.get("PartName");
      const contentType = child.attributes.get("ContentType");
      if (partName && contentType) overrides.set(partName, contentType);
    }
  }
  const overrideContentType = overrides.get(`/${modelPath}`);
  const extension = modelPath
    .slice(modelPath.lastIndexOf(".") + 1)
    .toLowerCase();
  const resolvedContentType = overrideContentType ?? defaults.get(extension);
  if (resolvedContentType !== MODEL_CONTENT_TYPE) {
    throw new TypeError(
      `3MF package does not declare the 3D model content type for part ${modelPath}`,
    );
  }
  return modelPath;
}

// ---------------------------------------------------------------------------
// <object> / <mesh> / <components>
// ---------------------------------------------------------------------------

function parseObject(
  el: XmlElement,
  budget: { vertexTotal: number; triangleTotal: number },
  limits: ThreeMfParseLimits,
): { id: string; def: ObjectDef; mesh: ParsedThreeMfMesh | undefined } {
  const id = requireResourceId(el, "id", "<object>");
  const typeToken = el.attributes.get("type") ?? "model";
  if (!OBJECT_TYPES.has(typeToken as ObjectType)) {
    throw new TypeError(`3MF <object> has an unrecognized type: ${typeToken}`);
  }
  const type = typeToken as ObjectType;

  const meshEl = coreChildren(el, "mesh")[0];
  const componentsEl = coreChildren(el, "components")[0];
  if (meshEl && componentsEl) {
    throw new TypeError(
      `3MF <object id="${id}"> must not declare both <mesh> and <components>`,
    );
  }
  if (!meshEl && !componentsEl) {
    throw new TypeError(
      `3MF <object id="${id}"> must declare exactly one of <mesh> or <components>`,
    );
  }

  if (meshEl) {
    for (const child of meshEl.children) {
      if (child.prefix !== undefined) continue;
      if (child.tag === "beamlattice") {
        throw new UnsupportedInputError(
          `3MF <object id="${id}"> uses the Beam Lattice extension, which is not supported and would silently change the represented geometry if ignored`,
        );
      }
    }
    const verticesEl = requireSingleChild(
      meshEl,
      "vertices",
      `<object id="${id}">`,
    );
    const trianglesEl = requireSingleChild(
      meshEl,
      "triangles",
      `<object id="${id}">`,
    );
    const { positions, count: vertexCount } = readVertices(
      verticesEl,
      id,
      budget,
      limits,
    );
    const indices = readTriangles(trianglesEl, id, vertexCount, budget, limits);
    const meshId = `mesh.3mf.${id}`;
    return {
      id,
      def: { kind: "mesh", type, meshId },
      mesh: { id: meshId, positions, indices },
    };
  }

  const components: { objectId: string; transform: Mat4 }[] = [];
  for (const child of componentsEl!.children) {
    if (child.prefix !== undefined) continue;
    if (child.tag !== "component") {
      throw new TypeError(
        `3MF <object id="${id}"><components> contains an unexpected child element: ${child.tag}`,
      );
    }
    assertNoProductionPath(child, "<component>");
    const componentObjectId = requireResourceId(
      child,
      "objectid",
      "<component>",
    );
    const transform = parseOptionalTransform(child, "<component>");
    components.push({ objectId: componentObjectId, transform });
  }
  return { id, def: { kind: "components", type, components }, mesh: undefined };
}

function readVertices(
  verticesEl: XmlElement,
  objectId: string,
  budget: { vertexTotal: number; triangleTotal: number },
  limits: ThreeMfParseLimits,
): { positions: Float64Array; count: number } {
  const vertexElements = verticesEl.children;
  for (const child of vertexElements) {
    if (child.prefix !== undefined || child.tag !== "vertex") {
      throw new TypeError(
        `3MF <object id="${objectId}"><vertices> contains an unexpected child element`,
      );
    }
  }
  const count = vertexElements.length;
  if (count < 3) {
    throw new TypeError(
      `3MF <object id="${objectId}"> must declare at least 3 vertices`,
    );
  }
  budget.vertexTotal += count;
  if (budget.vertexTotal > limits.safetyVertexLimit) {
    throw new RangeError(
      "3MF geometry exceeds the importer vertex safety limit",
    );
  }
  const positions = new Float64Array(count * 3);
  vertexElements.forEach((vertexEl, index) => {
    const x = parseFiniteDecimal(
      requireAttr(vertexEl, "x", "<vertex>"),
      `<object id="${objectId}"> vertex ${index} x`,
    );
    const y = parseFiniteDecimal(
      requireAttr(vertexEl, "y", "<vertex>"),
      `<object id="${objectId}"> vertex ${index} y`,
    );
    const z = parseFiniteDecimal(
      requireAttr(vertexEl, "z", "<vertex>"),
      `<object id="${objectId}"> vertex ${index} z`,
    );
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
  });
  return { positions, count };
}

function readTriangles(
  trianglesEl: XmlElement,
  objectId: string,
  vertexCount: number,
  budget: { vertexTotal: number; triangleTotal: number },
  limits: ThreeMfParseLimits,
): Uint32Array {
  const triangleElements = trianglesEl.children;
  for (const child of triangleElements) {
    if (child.prefix !== undefined || child.tag !== "triangle") {
      throw new TypeError(
        `3MF <object id="${objectId}"><triangles> contains an unexpected child element`,
      );
    }
  }
  const count = triangleElements.length;
  budget.triangleTotal += count;
  checkedTriangleCount(
    budget.triangleTotal,
    limits.triangleLimit,
    limits.safetyTriangleLimit,
  );
  const indices = new Uint32Array(count * 3);
  triangleElements.forEach((triangleEl, index) => {
    const v1 = requireVertexIndex(
      triangleEl,
      "v1",
      objectId,
      index,
      vertexCount,
    );
    const v2 = requireVertexIndex(
      triangleEl,
      "v2",
      objectId,
      index,
      vertexCount,
    );
    const v3 = requireVertexIndex(
      triangleEl,
      "v3",
      objectId,
      index,
      vertexCount,
    );
    indices[index * 3] = v1;
    indices[index * 3 + 1] = v2;
    indices[index * 3 + 2] = v3;
  });
  return indices;
}

function requireVertexIndex(
  triangleEl: XmlElement,
  attribute: string,
  objectId: string,
  triangleIndex: number,
  vertexCount: number,
): number {
  const raw = requireAttr(triangleEl, attribute, "<triangle>");
  if (!/^\d+$/u.test(raw)) {
    throw new TypeError(
      `3MF <object id="${objectId}"> triangle ${triangleIndex} has an invalid ${attribute} index`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value >= vertexCount) {
    throw new TypeError(
      `3MF <object id="${objectId}"> triangle ${triangleIndex} references vertex ${value}, beyond its ${vertexCount} vertices`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Small XML helpers specific to the 3MF Core element set
// ---------------------------------------------------------------------------

function coreChildren(el: XmlElement, tag: string): XmlElement[] {
  return el.children.filter(
    (child) => child.prefix === undefined && child.tag === tag,
  );
}

function requireSingleChild(
  el: XmlElement,
  tag: string,
  context: string,
): XmlElement {
  const matches = coreChildren(el, tag);
  if (matches.length !== 1) {
    throw new TypeError(
      `${context} must declare exactly one <${tag}> element (found ${matches.length})`,
    );
  }
  return matches[0]!;
}

function requireAttr(el: XmlElement, name: string, context: string): string {
  const value = el.attributes.get(name);
  if (value === undefined) {
    throw new TypeError(
      `${context} is missing its required "${name}" attribute`,
    );
  }
  return value;
}

/**
 * Reads and validates a 3MF `ST_ResourceID`-shaped attribute (a positive
 * integer, used for both `<object id="">` declarations and every
 * `objectid="">` reference to one), returning its canonical decimal string
 * so that e.g. `id="1"` and a reference written as `objectid="01"` are
 * recognized as the same object rather than silently failing to resolve.
 */
function requireResourceId(
  el: XmlElement,
  name: string,
  context: string,
): string {
  const raw = requireAttr(el, name, context);
  if (
    !/^\d+$/u.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < 1
  ) {
    throw new TypeError(
      `${context} has an invalid "${name}" (must be a positive integer)`,
    );
  }
  return String(Number(raw));
}

function parseOptionalTransform(el: XmlElement, context: string): Mat4 {
  const raw = el.attributes.get("transform");
  if (raw === undefined) return IDENTITY;
  const tokens = raw.trim().split(/\s+/u);
  if (tokens.length !== 12) {
    throw new TypeError(
      `${context} transform must contain exactly 12 numbers (found ${tokens.length})`,
    );
  }
  const numbers = tokens.map((token, index) =>
    parseFiniteDecimal(token, `${context} transform[${index}]`),
  );
  // 3MF transforms are 12 row-major numbers (m00 m01 m02 m10 m11 m12 m20
  // m21 m22 m30 m31 m32) applied as p' = p * M (row-vector convention, the
  // last column fixed at [0,0,0,1]). This package's Mat4 is column-major
  // and applied as p' = M * p (column-vector convention). For a pure
  // affine matrix (no perspective row) these two conventions are related
  // by a transpose: storing 3MF's 12 numbers in the SAME order, inserting
  // a 0 after each 3x3 row and a trailing 1, produces exactly the
  // column-major matrix M^T -- which is the correct column-vector matrix
  // for the same physical transform. (Verified directly: translation and a
  // 90-degree axis rotation both round-trip correctly under this mapping;
  // see the README and `test/threemf.test.ts` for the worked derivation
  // and a rotation-transform test case.)
  return [
    numbers[0]!,
    numbers[1]!,
    numbers[2]!,
    0,
    numbers[3]!,
    numbers[4]!,
    numbers[5]!,
    0,
    numbers[6]!,
    numbers[7]!,
    numbers[8]!,
    0,
    numbers[9]!,
    numbers[10]!,
    numbers[11]!,
    1,
  ] as unknown as Mat4;
}

function assertNoProductionPath(el: XmlElement, context: string): void {
  for (const key of el.attributes.keys()) {
    const colon = key.indexOf(":");
    if (colon !== -1 && key.slice(colon + 1) === "path") {
      throw new UnsupportedInputError(
        `${context} declares a Production-extension "path" attribute referencing another model part, which is not supported`,
      );
    }
  }
}

function splitTokenList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.trim().length === 0 ? [] : value.trim().split(/\s+/u);
}

function collectPrefixes(el: XmlElement, into: Set<string>): void {
  if (el.prefix !== undefined) into.add(el.prefix);
  for (const key of el.attributes.keys()) {
    const colon = key.indexOf(":");
    if (colon !== -1) into.add(key.slice(0, colon));
  }
  for (const child of el.children) collectPrefixes(child, into);
}
