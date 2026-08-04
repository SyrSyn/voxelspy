import {
  checkedTriangleCount,
  decodeUtf8,
  linesOf,
  parseFiniteDecimal,
} from "./parse.js";
import type { ParsedMesh } from "./parse.js";

const BINARY_HEADER_BYTES = 84;
const BINARY_FACET_BYTES = 50;
const MAX_LINE_LENGTH = 1_000_000;

export function parseStl(
  bytes: Uint8Array,
  triangleLimit: number,
  safetyTriangleLimit: number,
): ParsedMesh {
  if (isExactBinaryStl(bytes)) {
    return parseBinaryStl(bytes, triangleLimit, safetyTriangleLimit);
  }
  return parseAsciiStl(
    decodeUtf8(bytes, "ASCII STL"),
    triangleLimit,
    safetyTriangleLimit,
  );
}

function isExactBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < BINARY_HEADER_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  return BINARY_HEADER_BYTES + count * BINARY_FACET_BYTES === bytes.byteLength;
}

function parseBinaryStl(
  bytes: Uint8Array,
  triangleLimit: number,
  safetyTriangleLimit: number,
): ParsedMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  checkedTriangleCount(triangleCount, triangleLimit, safetyTriangleLimit);
  const positions = new Float64Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  let nonzeroAttributeCount = 0;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const facetOffset = BINARY_HEADER_BYTES + triangle * BINARY_FACET_BYTES;
    for (let coordinate = 0; coordinate < 9; coordinate += 1) {
      const value = view.getFloat32(facetOffset + 12 + coordinate * 4, true);
      if (!Number.isFinite(value)) {
        throw new TypeError("Binary STL contains a non-finite coordinate");
      }
      positions[triangle * 9 + coordinate] = value;
    }
    const firstVertex = triangle * 3;
    indices[firstVertex] = firstVertex;
    indices[firstVertex + 1] = firstVertex + 1;
    indices[firstVertex + 2] = firstVertex + 2;
    if (view.getUint16(facetOffset + 48, true) !== 0) {
      nonzeroAttributeCount += 1;
    }
  }

  const notes = [
    "Facet normals are retained neither as geometry nor as proof of orientation.",
  ];
  if (nonzeroAttributeCount > 0) {
    notes.push(
      `${nonzeroAttributeCount} binary facet attribute field(s) were not interpreted.`,
    );
  }
  return { positions, indices, notes };
}

function parseAsciiStl(
  text: string,
  triangleLimit: number,
  safetyTriangleLimit: number,
): ParsedMesh {
  const positions: number[] = [];
  let state: "outside" | "facet" | "loop" | "vertices" | "endloop" = "outside";
  let verticesInFacet = 0;
  let triangleCount = 0;
  let lineIndex = -1;

  for (const rawLine of linesOf(text)) {
    lineIndex += 1;
    if (rawLine.length > MAX_LINE_LENGTH) {
      throw new RangeError(
        `ASCII STL line ${lineIndex + 1} exceeds the safety limit`,
      );
    }
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^(?:solid|endsolid)(?:\s|$)/iu.test(line)) {
      if (state !== "outside")
        failAscii(lineIndex, "unexpected solid boundary");
      continue;
    }
    const fields = line.split(/\s+/u);
    if (fields[0]?.toLowerCase() === "facet") {
      if (
        state !== "outside" ||
        fields.length !== 5 ||
        fields[1]?.toLowerCase() !== "normal"
      ) {
        failAscii(lineIndex, "invalid facet header");
      }
      parseFiniteDecimal(fields[2] ?? "", "STL facet normal");
      parseFiniteDecimal(fields[3] ?? "", "STL facet normal");
      parseFiniteDecimal(fields[4] ?? "", "STL facet normal");
      state = "facet";
      verticesInFacet = 0;
      continue;
    }
    if (fields[0]?.toLowerCase() === "outer") {
      if (
        state !== "facet" ||
        fields.length !== 2 ||
        fields[1]?.toLowerCase() !== "loop"
      ) {
        failAscii(lineIndex, "invalid outer loop");
      }
      state = "loop";
      continue;
    }
    if (fields[0]?.toLowerCase() === "vertex") {
      if (
        (state !== "loop" && state !== "vertices") ||
        fields.length !== 4 ||
        verticesInFacet >= 3
      ) {
        failAscii(lineIndex, "invalid facet vertex");
      }
      positions.push(
        parseFiniteDecimal(fields[1] ?? "", "STL vertex"),
        parseFiniteDecimal(fields[2] ?? "", "STL vertex"),
        parseFiniteDecimal(fields[3] ?? "", "STL vertex"),
      );
      verticesInFacet += 1;
      state = "vertices";
      continue;
    }
    if (fields[0]?.toLowerCase() === "endloop") {
      if (
        state !== "vertices" ||
        fields.length !== 1 ||
        verticesInFacet !== 3
      ) {
        failAscii(lineIndex, "facet must contain exactly three vertices");
      }
      state = "endloop";
      continue;
    }
    if (fields[0]?.toLowerCase() === "endfacet") {
      if (state !== "endloop" || fields.length !== 1) {
        failAscii(lineIndex, "invalid facet ending");
      }
      triangleCount += 1;
      checkedTriangleCount(triangleCount, triangleLimit, safetyTriangleLimit);
      state = "outside";
      continue;
    }
    failAscii(lineIndex, "unsupported statement");
  }

  if (state !== "outside")
    throw new TypeError("ASCII STL ended inside a facet");
  checkedTriangleCount(triangleCount, triangleLimit, safetyTriangleLimit);
  const indices = Uint32Array.from(
    { length: triangleCount * 3 },
    (_, index) => index,
  );
  return {
    positions,
    indices,
    notes: [
      "Facet normals are retained neither as geometry nor as proof of orientation.",
    ],
  };
}

function failAscii(lineIndex: number, reason: string): never {
  throw new TypeError(`ASCII STL line ${lineIndex + 1}: ${reason}`);
}
