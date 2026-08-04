import {
  checkedTriangleCount,
  decodeUtf8,
  linesOf,
  parseFiniteDecimal,
} from "./parse.js";
import type { ParsedMesh } from "./parse.js";
import { UnsupportedInputError } from "./errors.js";

const MAX_LINE_LENGTH = 1_000_000;
const IGNORED_DIRECTIVES = new Set(["g", "o", "s", "usemtl", "vt", "vn"]);

export function parseObj(
  bytes: Uint8Array,
  triangleLimit: number,
  safetyTriangleLimit: number,
  safetyVertexLimit: number,
): ParsedMesh {
  const positions: number[] = [];
  const triangles: number[] = [];
  const ignored = new Set<string>();
  let polygonCount = 0;
  const source = decodeUtf8(bytes, "OBJ");
  let lineIndex = -1;

  for (const rawLine of linesOf(source)) {
    lineIndex += 1;
    if (rawLine.length > MAX_LINE_LENGTH) {
      throw new RangeError(
        `OBJ line ${lineIndex + 1} exceeds the safety limit`,
      );
    }
    const withoutComment = rawLine.split("#", 1)[0]?.trim() ?? "";
    if (withoutComment.length === 0) continue;
    const fields = withoutComment.split(/\s+/u);
    const directive = fields[0] ?? "";

    if (directive === "v") {
      if (fields.length !== 4) {
        failObj(lineIndex, "vertices must contain exactly x, y, and z");
      }
      if (positions.length / 3 >= safetyVertexLimit) {
        throw new RangeError("OBJ exceeds the importer vertex safety limit");
      }
      positions.push(
        parseFiniteDecimal(fields[1] ?? "", "OBJ vertex"),
        parseFiniteDecimal(fields[2] ?? "", "OBJ vertex"),
        parseFiniteDecimal(fields[3] ?? "", "OBJ vertex"),
      );
      continue;
    }

    if (directive === "f") {
      if (fields.length < 4)
        failObj(lineIndex, "faces need at least three vertices");
      const faceFields = fields.slice(1);
      checkedTriangleCount(
        triangles.length / 3 + faceFields.length - 2,
        triangleLimit,
        safetyTriangleLimit,
      );
      if (faceFields.some((field) => field.includes("/"))) {
        ignored.add("face-attributes");
      }
      const face = faceFields.map((field) =>
        resolveVertexIndex(field, positions.length / 3, lineIndex),
      );
      if (face.length > 3) polygonCount += 1;
      for (let index = 1; index + 1 < face.length; index += 1) {
        triangles.push(face[0]!, face[index]!, face[index + 1]!);
      }
      continue;
    }

    if (IGNORED_DIRECTIVES.has(directive)) {
      ignored.add(directive);
      continue;
    }
    if (directive === "mtllib") {
      throw new UnsupportedInputError(
        "OBJ external material libraries are unsupported",
      );
    }
    throw new UnsupportedInputError(
      `OBJ line ${lineIndex + 1}: unsupported ${directive} statement`,
    );
  }

  checkedTriangleCount(
    triangles.length / 3,
    triangleLimit,
    safetyTriangleLimit,
  );
  return {
    positions,
    indices: Uint32Array.from(triangles),
    notes: [
      "OBJ materials, normals, texture coordinates, and smoothing are not geometry inputs.",
    ],
    polygonCount,
    ignoredDirectives: [...ignored].sort(),
  };
}

function resolveVertexIndex(
  token: string,
  vertexCount: number,
  lineIndex: number,
): number {
  if (!/^[+-]?\d+(?:\/[+-]?\d+(?:\/[+-]?\d+)?|\/\/[+-]?\d+)?$/u.test(token)) {
    failObj(lineIndex, "invalid face reference");
  }
  const raw = Number(token.split("/", 1)[0]);
  if (!Number.isSafeInteger(raw) || raw === 0) {
    failObj(lineIndex, "invalid vertex index");
  }
  const resolved = raw > 0 ? raw - 1 : vertexCount + raw;
  if (resolved < 0 || resolved >= vertexCount) {
    failObj(lineIndex, "vertex index is out of range");
  }
  return resolved;
}

function failObj(lineIndex: number, reason: string): never {
  throw new TypeError(`OBJ line ${lineIndex + 1}: ${reason}`);
}
