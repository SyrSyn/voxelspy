import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  normalizedModelSchema,
  type ImportRequest,
  type NormalizedModel,
  type SourceAxis,
  type SourceUnit,
} from "@voxelspy/contracts";
import { UnsupportedInputError } from "./errors.js";
import { decodeUtf8, checkedTriangleCount } from "./parse.js";
import {
  countDegenerateTriangles,
  sourceToModelTransform,
} from "./normalize.js";

export const STEP_RUNTIME_METADATA = Object.freeze({
  adapter: "occt-import-js",
  version: "0.0.23",
  occtVersion: "7.6.1",
  adapterSourceCommit: "c2148e54b456b571238d35cac037d304053d64b2",
  occtSourceCommit: "d2abb6d844231cb8f29be6894440874a4700e4a5",
  wasmSha256:
    "33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952",
  runtimeHeapCeilingBytes: 2 * 1024 * 1024 * 1024,
});
export const STEP_SAFETY_LIMITS = Object.freeze({
  inputBytes: 32 * 1024 * 1024,
  entities: 200_000,
  statementCharacters: 1_000_000,
  nesting: 64,
  hierarchyNodes: 50_000,
});
export interface StepTessellationParameters {
  readonly linearUnit: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
  readonly linearDeflectionType: "absolute_value";
  readonly linearDeflection: number;
  readonly angularDeflection: number;
}
/** Caller-owned worker timeout or memory refusal, mapped to resource-limit by importModel. */
export class StepRuntimeResourceLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "StepRuntimeResourceLimitError";
  }
}

export interface StepRuntime {
  readonly version: "0.0.23";
  readonly occtVersion: "7.6.1";
  readStepFile(
    bytes: Uint8Array,
    parameters: StepTessellationParameters,
  ): unknown | Promise<unknown>;
}
export interface StepResolvedFrame {
  readonly unit: Exclude<SourceUnit, "unknown">;
  readonly axis: Exclude<SourceAxis, "unknown">;
  readonly unitOrigin: "embedded" | "declared" | "user";
  readonly axisOrigin: "embedded" | "declared" | "user";
  readonly detectedUnit: SourceUnit;
  readonly detectedAxis: SourceAxis;
}

type Unit = Exclude<SourceUnit, "unknown">;
const unitScale: Record<Unit, number> = {
  micrometre: 0.001,
  millimetre: 1,
  centimetre: 10,
  metre: 1000,
  inch: 25.4,
  foot: 304.8,
};
function unsupported(message: string): never {
  throw new UnsupportedInputError(message);
}

/** STEP lexical preflight; quotes/comments cannot smuggle entity delimiters or fake units. */
function readEntities(bytes: Uint8Array): Map<string, string> {
  if (bytes.byteLength > STEP_SAFETY_LIMITS.inputBytes)
    throw new RangeError("STEP input exceeds the 32 MiB safety limit.");
  const text = decodeUtf8(bytes, "STEP");
  let statement = "",
    quote = false,
    comment = false,
    depth = 0;
  const statements: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!,
      next = text[i + 1];
    if (comment) {
      if (c === "*" && next === "/") {
        comment = false;
        i++;
        statement += " ";
      }
      continue;
    }
    if (quote) {
      statement += c;
      if (c === "'") {
        if (next === "'") {
          statement += next;
          i++;
        } else quote = false;
      }
    } else if (c === "/" && next === "*") {
      comment = true;
      i++;
    } else if (c === "'") {
      quote = true;
      statement += c;
    } else if (c === ";") {
      if (depth !== 0)
        throw new TypeError("STEP entity has unbalanced parentheses.");
      statements.push(statement.trim());
      statement = "";
      if (statements.length > STEP_SAFETY_LIMITS.entities + 20)
        throw new RangeError("STEP entity count exceeds the safety limit.");
    } else {
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (depth < 0)
        throw new TypeError("STEP entity has unbalanced parentheses.");
      if (depth > STEP_SAFETY_LIMITS.nesting)
        throw new RangeError("STEP nesting exceeds the safety limit.");
      statement += c;
    }
    if (statement.length > STEP_SAFETY_LIMITS.statementCharacters)
      throw new RangeError("STEP entity text exceeds the safety limit.");
  }
  if (quote || comment || depth !== 0 || statement.trim() !== "")
    throw new TypeError("STEP input is truncated or malformed.");
  if (
    statements[0] !== "ISO-10303-21" ||
    statements.at(-1) !== "END-ISO-10303-21"
  )
    throw new TypeError(
      "STEP requires a complete ISO-10303-21 exchange structure.",
    );
  const entities = new Map<string, string>();
  let section: "none" | "header" | "data" = "none",
    dataSeen = false,
    headerSeen = false;
  for (const item of statements.slice(1, -1)) {
    if (item === "HEADER" && !headerSeen && section === "none") {
      section = "header";
      headerSeen = true;
      continue;
    }
    if (item === "DATA" && headerSeen && !dataSeen && section === "none") {
      section = "data";
      dataSeen = true;
      continue;
    }
    if (item === "ENDSEC" && section !== "none") {
      section = "none";
      continue;
    }
    const keywords =
      item
        .replace(/'(?:[^']|'')*'/gu, "''")
        .toUpperCase()
        .match(/[A-Z_][A-Z_0-9]*/gu) ?? [];
    if (
      keywords.some(
        (k) =>
          k.includes("EXTERNAL") ||
          k === "DOCUMENT_FILE" ||
          k === "DOCUMENT_REFERENCE" ||
          k === "REFERENCE" ||
          k === "ANCHOR" ||
          k === "REPRESENTATION_REFERENCE" ||
          k === "PRODUCT_DEFINITION_REFERENCE",
      )
    )
      unsupported(
        "STEP external references and edition-3 reference/anchor sections are not supported.",
      );
    if (section === "header") continue;
    const match = /^#([0-9]{1,12})\s*=\s*([\s\S]+)$/u.exec(item);
    if (section !== "data" || match === null)
      throw new TypeError(
        "STEP contains an unsupported or malformed section/record.",
      );
    const id = String(Number(match[1]));
    if (entities.has(id))
      throw new TypeError("STEP entity identifiers must be unique.");
    entities.set(id, match[2]!);
  }
  if (!headerSeen || !dataSeen || section !== "none" || entities.size === 0)
    throw new TypeError("STEP requires complete HEADER and DATA sections.");
  return entities;
}
function component(body: string, name: string): string | undefined {
  const structural = body.replace(/'(?:[^']|'')*'/gu, (value) =>
    " ".repeat(value.length),
  );
  const match = new RegExp(`\\b${name}\\s*\\(`, "u").exec(structural);
  if (match === null) return undefined;
  const start = match.index + match[0].length;
  let depth = 1,
    quoted = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === "'") {
      if (quoted && body[i + 1] === "'") {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return body.slice(start, i);
  }
  throw new TypeError(`STEP ${name} component is malformed.`);
}
interface Fraction {
  n: bigint;
  d: bigint;
}
function decimal(value: string): Fraction {
  const m = /^([+-]?)((?:\d+(?:\.\d*)?|\.\d+))(?:[Ee]([+-]?\d+))?$/u.exec(
    value.trim(),
  );
  if (!m || value.length > 128)
    unsupported("STEP conversion unit has an unsupported scale.");
  const [whole = "", fraction = ""] = m[2]!.split(".");
  const exp = Number(m[3] ?? 0) - fraction.length;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 64)
    unsupported("STEP conversion scale exceeds supported bounds.");
  const n = BigInt(whole + fraction) * (m[1] === "-" ? -1n : 1n);
  return exp >= 0
    ? { n: n * 10n ** BigInt(exp), d: 1n }
    : { n, d: 10n ** BigInt(-exp) };
}
const ratios: Record<Unit, Fraction> = {
  micrometre: { n: 1n, d: 1000n },
  millimetre: { n: 1n, d: 1n },
  centimetre: { n: 10n, d: 1n },
  metre: { n: 1000n, d: 1n },
  inch: { n: 127n, d: 5n },
  foot: { n: 1524n, d: 5n },
};

/** Resolve only units assigned to representation contexts; conversion base units are not mistaken for mixed contexts. */
export function detectStepSourceUnit(bytes: Uint8Array): Unit {
  const entities = readEntities(bytes);
  const unitIds: string[] = [];
  for (const body of entities.values()) {
    const assigned = component(body, "GLOBAL_UNIT_ASSIGNED_CONTEXT");
    if (assigned === undefined) continue;
    const references = assigned.match(/#[0-9]+/gu) ?? [];
    if (
      references.length === 0 ||
      assigned.replace(/#[0-9]+/gu, "").replace(/[\s(),]/gu, "") !== ""
    )
      unsupported("STEP unit context is not a supported explicit entity list.");
    unitIds.push(...references.map((id) => String(Number(id.slice(1)))));
  }
  const resolve = (id: string, active: Set<string>): Fraction | undefined => {
    if (active.has(id) || active.size >= 32)
      unsupported("STEP unit conversion contains a cycle or excessive depth.");
    const body = entities.get(id);
    if (body === undefined)
      throw new TypeError("STEP unit references a missing entity.");
    if (component(body, "LENGTH_UNIT") === undefined) {
      if (
        component(body, "PLANE_ANGLE_UNIT") !== undefined ||
        component(body, "SOLID_ANGLE_UNIT") !== undefined
      )
        return undefined;
      unsupported("STEP unit context contains an unsupported unit kind.");
    }
    const si = component(body, "SI_UNIT");
    if (si !== undefined) {
      const prefix = si.replace(/\s/gu, "");
      const values: Record<string, Unit> = {
        "$,.METRE.": "metre",
        ".MILLI.,.METRE.": "millimetre",
        ".CENTI.,.METRE.": "centimetre",
        ".MICRO.,.METRE.": "micrometre",
      };
      const unit = values[prefix];
      if (!unit) unsupported("STEP length SI unit or prefix is unsupported.");
      return ratios[unit];
    }
    const conversion = component(body, "CONVERSION_BASED_UNIT");
    const cm =
      conversion === undefined
        ? null
        : /^\s*'(?:INCH|INCHES|FOOT|FEET|in|ft)'\s*,\s*#([0-9]+)\s*$/u.exec(
            conversion,
          );
    if (!cm)
      unsupported(
        "STEP length unit is not a supported SI or inch/foot conversion unit.",
      );
    const factor = entities.get(String(Number(cm[1])));
    if (!factor) throw new TypeError("STEP conversion factor is missing.");
    const measure =
      component(factor, "LENGTH_MEASURE_WITH_UNIT") ??
      component(factor, "MEASURE_WITH_UNIT");
    const mm =
      measure === undefined
        ? null
        : /^\s*LENGTH_MEASURE\s*\(([^()]*)\)\s*,\s*#([0-9]+)\s*$/u.exec(
            measure,
          );
    if (!mm)
      unsupported(
        "STEP conversion factor must be an explicit length measure with unit.",
      );
    const next = new Set(active);
    next.add(id);
    const basis = resolve(String(Number(mm[2])), next);
    if (!basis) unsupported("STEP conversion basis is not a length unit.");
    const scale = decimal(mm[1]!);
    if (scale.n <= 0n) unsupported("STEP conversion factor must be positive.");
    return { n: basis.n * scale.n, d: basis.d * scale.d };
  };
  const units = new Set<Unit>();
  for (const id of unitIds) {
    const ratio = resolve(id, new Set());
    if (!ratio) continue;
    const unit = (Object.keys(ratios) as Unit[]).find(
      (u) => ratios[u].n * ratio.d === ratio.n * ratios[u].d,
    );
    if (!unit)
      unsupported(
        "STEP length conversion does not match a supported engineering unit.",
      );
    units.add(unit);
  }
  if (units.size !== 1)
    unsupported(
      "STEP requires one homogeneous, supported representation-context length unit; missing or mixed units are refused.",
    );
  return [...units][0]!;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`STEP runtime ${context} is malformed.`);
  return value as Record<string, unknown>;
}
function numberArray(
  value: unknown,
  maximum: number,
  context: string,
): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length % 3 !== 0)
    throw new TypeError(
      `STEP runtime ${context} must contain complete triples.`,
    );
  if (value.length > maximum * 3)
    throw new RangeError(
      `STEP runtime ${context} exceeds the geometry ceiling.`,
    );
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !Number.isFinite(value[i]))
      throw new TypeError(
        `STEP runtime ${context} contains a non-finite or missing value.`,
      );
  }
  return value as number[];
}

/** Convert only a caller-supplied trusted runtime result; the parser never loads code, assets or models. */
export async function importStepModel(
  request: ImportRequest,
  frame: StepResolvedFrame,
  runtime: StepRuntime,
  limits: { triangleCount: number; vertexCount: number },
): Promise<NormalizedModel> {
  if (request.bytes.byteLength > STEP_SAFETY_LIMITS.inputBytes)
    throw new RangeError("STEP input exceeds the byte ceiling.");
  if (runtime.version !== "0.0.23" || runtime.occtVersion !== "7.6.1")
    unsupported("STEP runtime versions do not match the qualified adapter.");
  const nativeUnit = frame.detectedUnit;
  if (nativeUnit === "unknown")
    unsupported(
      "STEP native source unit must be detected before tessellation.",
    );
  const linearUnits: Record<Unit, StepTessellationParameters["linearUnit"]> = {
    micrometre: "millimeter",
    millimetre: "millimeter",
    centimetre: "centimeter",
    metre: "meter",
    inch: "inch",
    foot: "foot",
  };
  const nativeScale = nativeUnit === "micrometre" ? 1 : unitScale[nativeUnit];
  const parameters: StepTessellationParameters = {
    linearUnit: linearUnits[nativeUnit],
    linearDeflectionType: "absolute_value",
    linearDeflection: 0.1 / nativeScale,
    angularDeflection: 0.5,
  };
  const output = record(
    await runtime.readStepFile(request.bytes, parameters),
    "result",
  );
  if (output.success !== true)
    throw new TypeError("STEP native transfer or tessellation failed.");
  if (
    !Array.isArray(output.meshes) ||
    output.meshes.length === 0 ||
    output.meshes.length > STEP_SAFETY_LIMITS.hierarchyNodes
  )
    throw new TypeError(
      "STEP native result contains no bounded triangle meshes.",
    );
  const idFor = (value: string) =>
    value === request.targetModelId ? `${value}.imported` : value;
  let triangles = 0,
    vertices = 0,
    degenerate = 0;
  const meshes = output.meshes.map((value, index) => {
    const mesh = record(value, "mesh");
    const attributes = record(mesh.attributes, "attributes");
    const positions = numberArray(
      record(attributes.position, "position").array,
      limits.vertexCount,
      "positions",
    );
    const indices = numberArray(
      record(mesh.index, "index").array,
      limits.triangleCount,
      "indices",
    );
    vertices += positions.length / 3;
    triangles += indices.length / 3;
    if (vertices > limits.vertexCount)
      throw new RangeError(
        "STEP total vertex count exceeds the importer ceiling.",
      );
    checkedTriangleCount(
      triangles,
      request.options.limits.triangleCount,
      limits.triangleCount,
    );
    if (
      !indices.every(
        (i) => Number.isSafeInteger(i) && i >= 0 && i < positions.length / 3,
      )
    )
      throw new TypeError("STEP triangle references an out-of-range vertex.");
    const packedPositions = Float64Array.from(positions, (v) =>
      nativeUnit === "micrometre" ? v * 1000 : v,
    );
    if (!packedPositions.every(Number.isFinite))
      throw new TypeError("STEP source-frame conversion overflowed.");
    const packedIndices = Uint32Array.from(indices);
    degenerate += countDegenerateTriangles(packedPositions, packedIndices);
    return {
      id: idFor(`mesh.step.${index}`),
      geometry: { positions: packedPositions, indices: packedIndices },
    };
  });
  const nodes: {
    id: string;
    childIds: string[];
    instanceIds: string[];
    localToParent: typeof IDENTITY_MAT4;
  }[] = [];
  const instances: {
    id: string;
    meshId: string;
    meshToNode: typeof IDENTITY_MAT4;
  }[] = [];
  const referenced = new Set<number>();
  const queue: { value: unknown; parent: number | undefined; depth: number }[] =
    [{ value: output.root, parent: undefined, depth: 0 }];
  const rootIds: string[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (queue.length > STEP_SAFETY_LIMITS.hierarchyNodes)
      throw new RangeError("STEP hierarchy exceeds the node ceiling.");
    const item = queue[cursor]!;
    if (item.depth > STEP_SAFETY_LIMITS.nesting)
      throw new RangeError("STEP hierarchy exceeds the depth ceiling.");
    const source = record(item.value, "hierarchy node");
    if (!Array.isArray(source.meshes) || !Array.isArray(source.children))
      throw new TypeError("STEP hierarchy node is malformed.");
    if (
      source.meshes.length > meshes.length ||
      source.children.length > STEP_SAFETY_LIMITS.hierarchyNodes
    )
      throw new RangeError("STEP hierarchy references exceed the ceiling.");
    const id = idFor(`node.step.${cursor}`),
      instanceIds: string[] = [];
    for (const meshIndex of source.meshes) {
      if (
        typeof meshIndex !== "number" ||
        !Number.isSafeInteger(meshIndex) ||
        meshIndex < 0 ||
        meshIndex >= meshes.length ||
        referenced.has(meshIndex)
      )
        throw new TypeError(
          "STEP hierarchy references missing or repeated baked mesh geometry.",
        );
      referenced.add(meshIndex);
      const instanceId = idFor(`instance.step.${meshIndex}`);
      instanceIds.push(instanceId);
      instances.push({
        id: instanceId,
        meshId: meshes[meshIndex]!.id,
        meshToNode: IDENTITY_MAT4,
      });
    }
    nodes.push({ id, childIds: [], instanceIds, localToParent: IDENTITY_MAT4 });
    if (item.parent === undefined) rootIds.push(id);
    else nodes[item.parent]!.childIds.push(id);
    for (const child of source.children)
      queue.push({ value: child, parent: cursor, depth: item.depth + 1 });
    if (source.children.length === 0 && source.meshes.length === 0)
      throw new TypeError(
        "STEP runtime returned an empty leaf; skipped or unsupported geometry is not accepted.",
      );
  }
  if (referenced.size !== meshes.length)
    throw new TypeError("STEP runtime returned unreferenced geometry.");
  const warnings: {
    code: string;
    severity: "warning" | "info";
    message: string;
    details?: Record<string, unknown>;
  }[] = [
    {
      code: "step-tessellated-surface",
      severity: "warning",
      message:
        "STEP CAD geometry was tessellated; results describe the triangle approximation, not exact source CAD geometry.",
      details: {
        linearDeflectionMillimetres: 0.1,
        angularDeflectionRadians: 0.5,
      },
    },
    {
      code: "step-transfer-not-auditable",
      severity: "warning",
      message:
        "The upstream OCCT transfer may heal geometry or omit unsupported entities without exposing a complete audit. No additional repair, alignment or recentering was performed. Source bytes and digest are retained separately.",
    },
    {
      code: "step-transforms-baked",
      severity: "info",
      message:
        "OCCT bakes placements into each returned mesh. The returned hierarchy is retained with identity local transforms; original CAD placement matrices and instancing identities are unavailable.",
    },
    {
      code: "step-nongeometric-data-not-evaluated",
      severity: "info",
      message:
        "CAD names, colors, materials, tolerances, PMI and source face identifiers are not retained as engineering metadata.",
    },
    {
      code: "step-native-resource-boundary",
      severity: "warning",
      message:
        "Input and returned geometry are bounded. Native parsing is synchronous; its 2 GiB WASM linear-memory ceiling is not a process or total-memory bound. Native work cannot be interrupted internally; callers must use a terminable isolated worker and timeout.",
    },
  ];
  if (degenerate > 0)
    warnings.push({
      code: "degenerate-triangles",
      severity: "warning",
      message: `${degenerate} degenerate triangles were preserved without repair.`,
      details: { count: degenerate },
    });
  if (frame.unitOrigin !== "embedded" || frame.axisOrigin === "user")
    warnings.push({
      code: "user-source-frame",
      severity: "info",
      message:
        "An explicit source frame interpretation was applied and recorded in provenance.",
    });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    request.bytes.buffer as ArrayBuffer,
  );
  const sourceDigest = {
    algorithm: "sha256" as const,
    value: [...new Uint8Array(digest)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join(""),
  };
  const frameId = idFor("node.step.frame"),
    rootId = idFor("node.step.root");
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id: request.targetModelId,
    frame: CANONICAL_FRAME,
    meshes,
    placement: {
      kind: "hierarchy",
      rootIds: [rootId],
      nodes: [
        {
          id: rootId,
          childIds: [frameId],
          instanceIds: [],
          localToParent: IDENTITY_MAT4,
        },
        {
          id: frameId,
          childIds: rootIds,
          instanceIds: [],
          localToParent: sourceToModelTransform(frame.unit, frame.axis),
        },
        ...nodes,
      ],
      instances,
    },
    warnings,
    provenance: {
      formatId: request.format,
      importerId: "voxelspy.mesh",
      importerVersion: "0.1.0",
      sourceName: request.sourceName,
      sourceDigest,
      detectedSourceUnit: frame.detectedUnit,
      detectedSourceAxis: "unknown",
      sourceUnit: frame.unit,
      sourceAxis: frame.axis,
      sourceResolution: { unit: frame.unitOrigin, axis: frame.axisOrigin },
      appliedSourceToModel: sourceToModelTransform(frame.unit, frame.axis),
      tessellation: {
        adapterId: "occt-import-js",
        adapterVersion: "0.0.23",
        parameters: {
          ...STEP_RUNTIME_METADATA,
          ...parameters,
          nativeSourceUnit: nativeUnit,
          sourceCoordinateRecoveryScale: nativeUnit === "micrometre" ? 1000 : 1,
          linearDeflectionMillimetres: 0.1,
          assemblyTransforms: "baked-in-mesh-coordinates",
          transferAudit: "unavailable",
        },
      },
      notes: [
        "Source length unit resolved from homogeneous representation contexts; no implicit STEP up-axis was assumed.",
        "Exact OCCT source version is pinned by the upstream npm distribution's submodule; no runtime version-query API is available.",
      ],
    },
  });
}
