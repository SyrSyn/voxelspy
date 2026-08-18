import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type { Mat4, NormalizedModel, Vec3 } from "@voxelspy/contracts";

import { oneUlpUp } from "./test-utils.js";

/**
 * Box faces expressed as (global corner index, per-face triangle winding)
 * pairs. `corners` lists each face's four corners in a fixed local order;
 * `triangles` gives the two triangles of that face as GLOBAL corner-index
 * triples, matching the winding of `BOX_INDICES` used throughout the rest
 * of this package's test fixtures (see test/fixtures.ts and
 * test/summary.test.ts) so a standard-geometry box built here is identical,
 * corner-for-corner and winding-for-winding, to those.
 */
const BOX_FACES: readonly {
  readonly corners: readonly [number, number, number, number];
  readonly triangles: readonly (readonly [number, number, number])[];
}[] = [
  {
    corners: [0, 1, 2, 3],
    triangles: [
      [0, 2, 1],
      [0, 3, 2],
    ],
  },
  {
    corners: [4, 5, 6, 7],
    triangles: [
      [4, 5, 6],
      [4, 6, 7],
    ],
  },
  {
    corners: [0, 1, 5, 4],
    triangles: [
      [0, 1, 5],
      [0, 5, 4],
    ],
  },
  {
    corners: [3, 7, 6, 2],
    triangles: [
      [3, 7, 6],
      [3, 6, 2],
    ],
  },
  {
    corners: [0, 4, 7, 3],
    triangles: [
      [0, 4, 7],
      [0, 7, 3],
    ],
  },
  {
    corners: [1, 2, 6, 5],
    triangles: [
      [1, 2, 6],
      [1, 6, 5],
    ],
  },
];

function boxCorners(size: readonly [number, number, number]): Vec3[] {
  const [x, y, z] = size;
  return [
    [0, 0, 0],
    [x, 0, 0],
    [x, y, 0],
    [0, y, 0],
    [0, 0, z],
    [x, 0, z],
    [x, y, z],
    [0, y, z],
  ];
}

/** The standard, canonical 8-vertex / 12-triangle indexed box geometry. */
function standardBoxGeometry(size: readonly [number, number, number]): {
  positions: Float64Array;
  indices: Uint32Array;
} {
  const corners = boxCorners(size);
  const positions = new Float64Array(corners.flat());
  const indices = new Uint32Array(
    BOX_FACES.flatMap((face) => face.triangles).flat(),
  );
  return { positions, indices };
}

function flippedIndices(indices: Uint32Array): Uint32Array {
  const flipped = new Uint32Array(indices.length);
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    flipped[triangle * 3] = indices[triangle * 3]!;
    flipped[triangle * 3 + 1] = indices[triangle * 3 + 2]!;
    flipped[triangle * 3 + 2] = indices[triangle * 3 + 1]!;
  }
  return flipped;
}

function duplicatedIndices(indices: Uint32Array): Uint32Array {
  return new Uint32Array([...indices, ...indices]);
}

/**
 * The same box shape, but with four vertices duplicated per face (24
 * vertices total instead of the canonical 8 shared corners) -- geometrically
 * identical, closed, and consistently oriented, but not the indexed
 * representation the exact axis-aligned-box adapter validates against.
 */
function perFaceVertexBoxGeometry(size: readonly [number, number, number]): {
  positions: Float64Array;
  indices: Uint32Array;
} {
  const corners = boxCorners(size);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const face of BOX_FACES) {
    const localBase = positions.length / 3;
    for (const cornerIndex of face.corners) {
      positions.push(...corners[cornerIndex]!);
    }
    for (const [a, b, c] of face.triangles) {
      indices.push(
        localBase + face.corners.indexOf(a),
        localBase + face.corners.indexOf(b),
        localBase + face.corners.indexOf(c),
      );
    }
  }
  return {
    positions: new Float64Array(positions),
    indices: new Uint32Array(indices),
  };
}

function translationMat4(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

interface MeshSpec {
  readonly id: string;
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

interface InstanceSpec {
  readonly id: string;
  readonly meshId: string;
  readonly meshToModel: Mat4;
}

function buildModel(
  id: string,
  meshes: readonly MeshSpec[],
  instances: readonly InstanceSpec[],
  note: string,
): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: meshes.map((mesh) => ({
      id: mesh.id,
      geometry: { positions: mesh.positions, indices: mesh.indices },
    })),
    placement: { kind: "flat", instances },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "analysis-adversarial-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [note],
    },
  });
}

/** A closed, axis-aligned box with every triangle's winding reversed. */
export function flippedWindingBoxModel(
  id: string,
  size: readonly [number, number, number] = [2, 2, 2],
): NormalizedModel {
  const { positions, indices } = standardBoxGeometry(size);
  return buildModel(
    id,
    [{ id: `${id}.mesh`, positions, indices: flippedIndices(indices) }],
    [
      {
        id: `${id}.instance`,
        meshId: `${id}.mesh`,
        meshToModel: IDENTITY_MAT4,
      },
    ],
    "Axis-aligned box identical to the canonical fixture except every triangle's winding is reversed.",
  );
}

/**
 * The same box shape, but with every one of its 12 triangles duplicated (24
 * triangles total over the same 8 vertices) -- coincident, non-manifold
 * duplicate faces.
 */
export function duplicatedFaceBoxModel(
  id: string,
  size: readonly [number, number, number] = [2, 2, 2],
): NormalizedModel {
  const { positions, indices } = standardBoxGeometry(size);
  return buildModel(
    id,
    [{ id: `${id}.mesh`, positions, indices: duplicatedIndices(indices) }],
    [
      {
        id: `${id}.instance`,
        meshId: `${id}.mesh`,
        meshToModel: IDENTITY_MAT4,
      },
    ],
    "Axis-aligned box with every triangle duplicated: coincident, non-manifold duplicate faces over identical positions.",
  );
}

/** See `perFaceVertexBoxGeometry`. */
export function duplicatePerFaceVertexBoxModel(
  id: string,
  size: readonly [number, number, number] = [2, 2, 2],
): NormalizedModel {
  const { positions, indices } = perFaceVertexBoxGeometry(size);
  return buildModel(
    id,
    [{ id: `${id}.mesh`, positions, indices }],
    [
      {
        id: `${id}.instance`,
        meshId: `${id}.mesh`,
        meshToModel: IDENTITY_MAT4,
      },
    ],
    "Axis-aligned box with 24 vertices (four duplicated per face) instead of the canonical 8 shared corners.",
  );
}

/**
 * A fully facet-local box: every triangle owns a private copy of each of
 * its three corners (36 vertices total), sharing no vertex INDEX with any
 * other triangle -- even though every duplicated corner's coordinates
 * coincide exactly with its counterparts on neighboring triangles. This is
 * the representation many importers (e.g. binary STL) naturally produce.
 */
export function facetLocalBoxModel(
  id: string,
  size: readonly [number, number, number] = [2, 2, 2],
): NormalizedModel {
  const { positions, indices } = standardBoxGeometry(size);
  const facetLocalPositions = new Float64Array(indices.length * 3);
  indices.forEach((vertexIndex, index) => {
    facetLocalPositions.set(
      positions.slice(vertexIndex * 3, vertexIndex * 3 + 3),
      index * 3,
    );
  });
  const facetLocalIndices = Uint32Array.from(
    { length: indices.length },
    (_, index) => index,
  );
  return buildModel(
    id,
    [
      {
        id: `${id}.mesh`,
        positions: facetLocalPositions,
        indices: facetLocalIndices,
      },
    ],
    [
      {
        id: `${id}.instance`,
        meshId: `${id}.mesh`,
        meshToModel: IDENTITY_MAT4,
      },
    ],
    "Fully facet-local box: every triangle owns its own private copy of each corner (36 vertices), sharing no vertex index with any other triangle despite coordinates coinciding exactly.",
  );
}

/**
 * A closed outer box containing a second, fully interior closed box surface
 * -- an internal void/cavity boundary modeled as a second disjoint mesh
 * instance, not a boolean-subtracted solid.
 */
export function boxWithInternalVoidModel(
  id: string,
  outerSize: readonly [number, number, number] = [20, 20, 20],
  innerSize: readonly [number, number, number] = [6, 6, 6],
  innerOffset: readonly [number, number, number] = [7, 7, 7],
): NormalizedModel {
  const outer = standardBoxGeometry(outerSize);
  const inner = standardBoxGeometry(innerSize);
  return buildModel(
    id,
    [
      { id: `${id}.outer`, positions: outer.positions, indices: outer.indices },
      { id: `${id}.inner`, positions: inner.positions, indices: inner.indices },
    ],
    [
      {
        id: `${id}.outer.instance`,
        meshId: `${id}.outer`,
        meshToModel: IDENTITY_MAT4,
      },
      {
        id: `${id}.inner.instance`,
        meshId: `${id}.inner`,
        meshToModel: translationMat4(...innerOffset),
      },
    ],
    "Closed outer box plus a second, fully interior closed box surface (an internal void boundary) as a disjoint mesh instance.",
  );
}

/**
 * A finely tessellated flat panel covering the same 100x100mm footprint as
 * `coarsePanelModel` in test/fixtures.ts, but with no holes -- every grid
 * cell present, so the geometric surface is identical to a flat plane
 * regardless of tessellation.
 */
export function finePanelModel(id: string, gridSize: number): NormalizedModel {
  const step = 100 / gridSize;
  const vertexIndex = (row: number, column: number) =>
    row * (gridSize + 1) + column;
  const positions: number[] = [];
  for (let row = 0; row <= gridSize; row += 1) {
    for (let column = 0; column <= gridSize; column += 1) {
      positions.push(column * step, row * step, 0);
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const a = vertexIndex(row, column);
      const b = vertexIndex(row, column + 1);
      const c = vertexIndex(row + 1, column + 1);
      const d = vertexIndex(row + 1, column);
      indices.push(a, b, c, a, c, d);
    }
  }
  return buildModel(
    id,
    [
      {
        id: `${id}.mesh`,
        positions: new Float64Array(positions),
        indices: new Uint32Array(indices),
      },
    ],
    [
      {
        id: `${id}.instance`,
        meshId: `${id}.mesh`,
        meshToModel: IDENTITY_MAT4,
      },
    ],
    `Finely tessellated (${gridSize}x${gridSize} grid, ${gridSize * gridSize * 2} triangles) flat panel covering the same 100x100mm footprint as the coarse two-triangle panel, with no holes.`,
  );
}

/**
 * Two triangles sharing an edge through facet-local duplicate vertices (as
 * an STL-style importer would emit), translated by `translationAmount`, with
 * one facet-local copy of the shared corner nudged by exactly one ULP so it
 * no longer bit-matches its counterpart in the neighboring triangle.
 */
export function ulpFragmentedFacetLocalSquareModel(
  id: string,
  translationAmount: readonly [number, number, number],
): NormalizedModel {
  const [dx, dy, dz] = translationAmount;
  const positions = new Float64Array([
    dx,
    dy,
    dz,
    2 + dx,
    dy,
    dz,
    2 + dx,
    2 + dy,
    dz,
    dx,
    dy,
    dz,
    2 + dx,
    2 + dy,
    dz,
    dx,
    2 + dy,
    dz,
  ]);
  // Nudge triangle 2's own copy of the shared (dx,dy,dz) corner (vertex
  // index 3) by one ULP in x, so it no longer bit-matches triangle 1's copy
  // of the same logical point (vertex index 0). Every other coordinate,
  // including the triangles' other shared corner (index 2 vs. index 4),
  // stays bit-identical.
  positions[9] = oneUlpUp(positions[9]!);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  return buildModel(
    id,
    [{ id: `${id}.mesh`, positions, indices }],
    [
      {
        id: `${id}.instance`,
        meshId: `${id}.mesh`,
        meshToModel: IDENTITY_MAT4,
      },
    ],
    "Two connected facets (facet-local duplicate vertices) with one shared-edge vertex copy nudged by one ULP.",
  );
}
