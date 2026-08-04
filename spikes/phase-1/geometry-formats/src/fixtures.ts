import type {
  MeshGeometry,
  SourceAxis,
  SourceUnit,
  TessellatedStepResult,
} from "./contracts.ts";
import { IDENTITY_4X4 } from "./normalize.ts";

export function boxMesh(
  minimum: readonly [number, number, number] = [0, 0, 0],
  maximum: readonly [number, number, number] = [10, 10, 10],
): MeshGeometry {
  const [x0, y0, z0] = minimum;
  const [x1, y1, z1] = maximum;
  return {
    positions: Float64Array.from([
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0,
      4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ]),
  };
}

export function openBoxMesh(): MeshGeometry {
  const box = boxMesh();
  return { positions: box.positions.slice(), indices: box.indices.slice(6) };
}

export function disconnectedCornerTetrahedra(): MeshGeometry {
  return {
    positions: Float64Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3, 4, 5, 6, 4, 7, 5, 5, 7, 6, 6, 7, 4,
    ]),
  };
}

export function sphereMesh(
  radius: number,
  longitudeSegments: number,
  latitudeSegments: number,
): MeshGeometry {
  const positions: number[] = [0, 0, radius];
  for (let latitude = 1; latitude < latitudeSegments; latitude += 1) {
    const phi = (Math.PI * latitude) / latitudeSegments;
    for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
      const theta = (2 * Math.PI * longitude) / longitudeSegments;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      );
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, -radius);
  const indices: number[] = [];
  const ring = (latitude: number, longitude: number): number =>
    1 + (latitude - 1) * longitudeSegments + (longitude % longitudeSegments);
  for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
    const next = (longitude + 1) % longitudeSegments;
    indices.push(0, ring(1, longitude), ring(1, next));
    for (let latitude = 1; latitude < latitudeSegments - 1; latitude += 1) {
      indices.push(
        ring(latitude, longitude),
        ring(latitude + 1, longitude),
        ring(latitude + 1, next),
      );
      indices.push(
        ring(latitude, longitude),
        ring(latitude + 1, next),
        ring(latitude, next),
      );
    }
    indices.push(
      ring(latitudeSegments - 1, longitude),
      bottom,
      ring(latitudeSegments - 1, next),
    );
  }
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
  };
}

export function asciiStlFixture(): string {
  return `solid generated_tetrahedron
facet normal 0 0 -1
 outer loop
  vertex 0 0 0
  vertex 0 10 0
  vertex 10 0 0
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 0 10
 endloop
endfacet
facet normal 1 1 1
 outer loop
  vertex 10 0 0
  vertex 0 10 0
  vertex 0 0 10
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex 0 10 0
  vertex 0 0 0
  vertex 0 0 10
 endloop
endfacet
endsolid generated_tetrahedron
`;
}

export function binaryStlFixture(): Uint8Array {
  const triangles = [
    [0, 0, 0, 0, 10, 0, 10, 0, 0],
    [0, 0, 0, 10, 0, 0, 0, 0, 10],
    [10, 0, 0, 0, 10, 0, 0, 0, 10],
    [0, 10, 0, 0, 0, 0, 0, 0, 10],
  ];
  const bytes = new Uint8Array(84 + triangles.length * 50);
  bytes.set(new TextEncoder().encode("Generated tetrahedron fixture"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, triangleIndex) => {
    const base = 84 + triangleIndex * 50 + 12;
    triangle.forEach((coordinate, coordinateIndex) =>
      view.setFloat32(base + coordinateIndex * 4, coordinate, true),
    );
  });
  return bytes;
}

export function objFixture(): string {
  return `# Generated tetrahedron fixture
v 0 0 0
v 1 0 0
v 0 1 0
v 0 0 1
f 1 3 2
f 1 2 4
f 2 3 4
f 3 1 4
`;
}

export function threeMfModelBytes(componentTransform?: string): Uint8Array {
  const componentTransformAttribute =
    componentTransform === undefined
      ? ""
      : ` transform="${componentTransform}"`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="centimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" name="generated-tetrahedron" type="model">
   <mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices>
    <triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles>
   </mesh>
  </object>
  <object id="2" name="generated-assembly" type="model"><components><component objectid="1"${componentTransformAttribute}/></components></object>
 </resources>
 <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 2 0 0"/></build>
</model>`;
  return new TextEncoder().encode(xml);
}

export function threeMfFixture(
  entryName = "3D/3dmodel.model",
  componentTransform?: string,
): Uint8Array {
  return storedZip([
    { name: entryName, bytes: threeMfModelBytes(componentTransform) },
  ]);
}

export function gltfFixture(): string {
  const binary = triangleBinary();
  const encoded = bytesToBase64(binary);
  return JSON.stringify({
    asset: { version: "2.0", generator: "geometry-formats-evidence" },
    buffers: [
      {
        byteLength: binary.byteLength,
        uri: `data:application/octet-stream;base64,${encoded}`,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] },
    ],
    nodes: [
      { name: "generated-triangle", mesh: 0, translation: [0, 0.002, 0] },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  });
}

export function glbFixture(): Uint8Array {
  const binary = triangleBinary();
  const jsonObject = JSON.parse(gltfFixture()) as Record<string, unknown>;
  jsonObject.buffers = [{ byteLength: binary.byteLength }];
  const jsonBytes = padded(
    new TextEncoder().encode(JSON.stringify(jsonObject)),
    0x20,
  );
  const binBytes = padded(binary, 0);
  const output = new Uint8Array(
    12 + 8 + jsonBytes.length + 8 + binBytes.length,
  );
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.length;
  view.setUint32(binHeader, binBytes.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  output.set(binBytes, binHeader + 8);
  return output;
}

export function stepTessellationFixture(
  linearDeflection: number,
  sourceUnit: SourceUnit = "inch",
  sourceAxis: SourceAxis = "right-handed-y-up",
): TessellatedStepResult {
  const scale = linearDeflection <= 0.01 ? 8 : 4;
  const mesh = sphereMesh(1, scale * 2, scale);
  return {
    sourceName: "generated-sphere.step",
    tessellator: "fixture-tessellator/1",
    linearDeflection,
    angularDeflection: 0.2,
    meshes: [{ ...mesh, sourceUnit, sourceAxis, name: "generated-sphere" }],
    assembly: [
      {
        id: "root",
        name: "generated-assembly",
        children: [1],
        transform: [...IDENTITY_4X4],
      },
      {
        id: "part-1",
        name: "generated-sphere",
        mesh: 0,
        children: [],
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1],
      },
    ],
  };
}

export function storedZip(
  entries: readonly { name: string; bytes: Uint8Array }[],
): Uint8Array {
  return zipFixture(
    entries.map((entry) => ({
      name: entry.name,
      expanded: entry.bytes,
      encoded: entry.bytes,
      method: 0,
    })),
  );
}

export function rawDeflatedZip(
  name: string,
  expanded: Uint8Array,
  rawDeflated: Uint8Array,
): Uint8Array {
  return zipFixture([{ name, expanded, encoded: rawDeflated, method: 8 }]);
}

function zipFixture(
  entries: readonly {
    name: string;
    expanded: Uint8Array;
    encoded: Uint8Array;
    method: 0 | 8;
  }[],
): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.expanded);
    const local = new Uint8Array(30 + name.length + entry.encoded.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, entry.method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.encoded.length, true);
    localView.setUint32(22, entry.expanded.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.encoded, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, entry.method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.encoded.length, true);
    centralView.setUint32(24, entry.expanded.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localOffset, true);
  return concatenate([...localParts, ...centralParts, eocd]);
}

function triangleBinary(): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0].forEach((value, index) =>
    view.setFloat32(index * 4, value, true),
  );
  view.setUint16(36, 0, true);
  view.setUint16(38, 1, true);
  view.setUint16(40, 2, true);
  return bytes;
}

function padded(bytes: Uint8Array, padding: number): Uint8Array {
  const output = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(padding);
  output.set(bytes);
  return output;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
