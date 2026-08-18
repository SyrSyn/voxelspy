import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisRequestSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type {
  AnalysisRequest,
  Mat4,
  NormalizedModel,
  Vec3,
} from "@voxelspy/contracts";

const BOX_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4,
  7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
]);

export function boxModel(
  id: string,
  maximum: readonly [number, number, number] = [2, 2, 2],
  options: { open?: boolean; meshToModel?: Mat4 } = {},
): NormalizedModel {
  const [x, y, z] = maximum;
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: {
          positions: new Float64Array([
            0,
            0,
            0,
            x,
            0,
            0,
            x,
            y,
            0,
            0,
            y,
            0,
            0,
            0,
            z,
            x,
            0,
            z,
            x,
            y,
            z,
            0,
            y,
            z,
          ]),
          indices: options.open
            ? new Uint32Array([...BOX_INDICES].slice(0, -6))
            : new Uint32Array(BOX_INDICES),
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `${id}.instance`,
          meshId: `${id}.mesh`,
          meshToModel: options.meshToModel ?? IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "analysis-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: ["Procedurally generated rectangular box."],
    },
  });
}

export function triangleModel(id: string): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: {
          positions: new Float64Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `${id}.instance`,
          meshId: `${id}.mesh`,
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "analysis-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: ["Procedurally generated triangle."],
    },
  });
}

export function facetLocalSquareModel(id: string): NormalizedModel {
  return generatedMeshModel(
    id,
    new Float64Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0]),
    new Uint32Array([0, 1, 2, 3, 4, 5]),
    "stl",
    "Two connected facets with facet-local duplicate vertices.",
  );
}

export function disconnectedFacetModel(
  id: string,
  triangleCount: number,
): NormalizedModel {
  const positions = new Float64Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const x = triangle * 10;
    positions.set([x, 0, 0, x + 1, 0, 0, x, 1, 0], triangle * 9);
    indices.set(
      [triangle * 3, triangle * 3 + 1, triangle * 3 + 2],
      triangle * 3,
    );
  }
  return generatedMeshModel(
    id,
    positions,
    indices,
    "generated-fixture",
    "Separated procedural triangles.",
  );
}

/**
 * A coarse, two-triangle flat 100x100mm panel (one diagonal split). Its
 * triangles' longest edge is the ~141.42mm hypotenuse, used to exercise the
 * surface-distance sample-spacing bound against a deliberately tiny
 * tolerance.
 */
export function coarsePanelModel(id: string): NormalizedModel {
  const positions = new Float64Array([
    0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return generatedMeshModel(
    id,
    positions,
    indices,
    "generated-fixture",
    "Coarse two-triangle flat panel for surface-distance sample-spacing fixtures.",
  );
}

/**
 * A finely tessellated 100x100mm panel covering the same footprint as
 * `coarsePanelModel`, built from a 4x4 grid of 25mm cells (two triangles
 * each), with one interior cell (row 1, column 1 -- the [25,50]x[25,50]
 * square) omitted entirely. That cell's four corner vertices remain part of
 * neighboring cells, so the hole introduces no vertex or centroid sample at
 * its own location or boundary that differs from the flat plane -- the gap
 * is invisible to vertex-and-centroid sampling from either side.
 */
export function panelWithInteriorHoleModel(id: string): NormalizedModel {
  const gridSize = 4;
  const step = 100 / gridSize;
  const holeRow = 1;
  const holeColumn = 1;
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
      if (row === holeRow && column === holeColumn) continue;
      const a = vertexIndex(row, column);
      const b = vertexIndex(row, column + 1);
      const c = vertexIndex(row + 1, column + 1);
      const d = vertexIndex(row + 1, column);
      indices.push(a, b, c, a, c, d);
    }
  }

  return generatedMeshModel(
    id,
    new Float64Array(positions),
    new Uint32Array(indices),
    "generated-fixture",
    "Finely tessellated panel with one interior grid cell omitted, forming a hole with no vertex or centroid sample of its own.",
  );
}

/**
 * A four-walled, open-top/bottom square channel (a "socket") centered on the
 * z axis: four disconnected rectangular walls at `x = ±halfOpening` and
 * `y = ±halfOpening`, each spanning `z` in `[0, height]`. Used by the
 * clearance-check peg-in-hole fixture: a box "peg" centered inside the
 * channel is equidistant from all four walls, so the clearance between the
 * peg's four side faces and this socket is uniform by construction.
 */
export function squareChannelModel(
  id: string,
  halfOpening: number,
  height: number,
): NormalizedModel {
  const walls: readonly (readonly [Vec3, Vec3, Vec3, Vec3])[] = [
    // front (y = -halfOpening), spanning x
    [
      [-halfOpening, -halfOpening, 0],
      [halfOpening, -halfOpening, 0],
      [halfOpening, -halfOpening, height],
      [-halfOpening, -halfOpening, height],
    ],
    // back (y = halfOpening)
    [
      [-halfOpening, halfOpening, 0],
      [halfOpening, halfOpening, 0],
      [halfOpening, halfOpening, height],
      [-halfOpening, halfOpening, height],
    ],
    // left (x = -halfOpening), spanning y
    [
      [-halfOpening, -halfOpening, 0],
      [-halfOpening, halfOpening, 0],
      [-halfOpening, halfOpening, height],
      [-halfOpening, -halfOpening, height],
    ],
    // right (x = halfOpening)
    [
      [halfOpening, -halfOpening, 0],
      [halfOpening, halfOpening, 0],
      [halfOpening, halfOpening, height],
      [halfOpening, -halfOpening, height],
    ],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  walls.forEach((quad, wallIndex) => {
    const base = wallIndex * 4;
    for (const vertex of quad) positions.push(...vertex);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return generatedMeshModel(
    id,
    new Float64Array(positions),
    new Uint32Array(indices),
    "generated-fixture",
    "Four-walled open square channel (a socket), used for peg-in-hole clearance-check fixtures.",
  );
}

/**
 * Two disjoint closed boxes: a `firstMax`-sized box at the origin and a
 * `secondMax`-sized box translated by `secondOffset` (far enough away, by
 * default, that the two never touch or overlap). Reuses `BOX_INDICES`
 * twice, index-shifted for the second box's eight vertices, so both shells
 * are exactly the same well-formed closed, consistently oriented solid
 * `boxModel` itself produces. Used for island/component-count fixtures that
 * need each component to independently report a real triangle count,
 * bounding extent, and volume.
 */
export function twoDisjointBoxesModel(
  id: string,
  firstMax: readonly [number, number, number] = [10, 10, 10],
  secondMax: readonly [number, number, number] = [4, 4, 4],
  secondOffset: readonly [number, number, number] = [100, 0, 0],
): NormalizedModel {
  const cornerFractions: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const boxPositions = (
    max: readonly [number, number, number],
    offset: readonly [number, number, number],
  ): number[] =>
    cornerFractions.flatMap(([fx, fy, fz]) => [
      fx * max[0] + offset[0],
      fy * max[1] + offset[1],
      fz * max[2] + offset[2],
    ]);
  const positions = new Float64Array([
    ...boxPositions(firstMax, [0, 0, 0]),
    ...boxPositions(secondMax, secondOffset),
  ]);
  const indices = new Uint32Array([
    ...BOX_INDICES,
    ...[...BOX_INDICES].map((index) => index + 8),
  ]);
  return generatedMeshModel(
    id,
    positions,
    indices,
    "generated-fixture",
    "Two disjoint closed boxes, for island/component-count fixtures.",
  );
}

/**
 * A single flat rectangular panel (two triangles) whose exact outward
 * normal is tilted `angleFromVerticalDegrees` away from vertical, measured
 * the same way `assessPrintability`'s overhang check measures it: `0`
 * degrees is a vertical wall (normal perpendicular to +Z), `90` degrees is
 * a flat downward-facing ceiling (normal exactly `-Z`). Constructed so the
 * outward normal is exactly `(cos(theta), 0, -sin(theta))` for
 * `theta = angleFromVerticalDegrees` in radians -- an exact, closed-form
 * geometric fact about this fixture, not something measured after the
 * fact, so a test asserting the overhang check's reported angle can compare
 * against `angleFromVerticalDegrees` directly.
 */
export function tiltedPanelModel(
  id: string,
  angleFromVerticalDegrees: number,
  size = 10,
): NormalizedModel {
  const theta = (angleFromVerticalDegrees * Math.PI) / 180;
  // In-plane basis for the panel: `u` and `v` both perpendicular to the
  // intended outward normal `(cos(theta), 0, -sin(theta))`, with
  // `cross(u, v) === normal` exactly (verified in this function's doc
  // comment's derivation), so triangle winding `(a, b, c)`/`(a, c, d)`
  // below produces that exact outward normal, not just a parallel one.
  const u: Vec3 = [-Math.sin(theta), 0, -Math.cos(theta)];
  const v: Vec3 = [0, 1, 0];
  const base: Vec3 = [0, 0, size * 2];
  const add = (a: Vec3, b: Vec3, scale: number): Vec3 => [
    a[0] + b[0] * scale,
    a[1] + b[1] * scale,
    a[2] + b[2] * scale,
  ];
  const corner = (uScale: number, vScale: number): Vec3 =>
    add(add(base, u, uScale), v, vScale);
  const a = corner(0, 0);
  const b = corner(size, 0);
  const c = corner(size, size);
  const d = corner(0, size);
  const positions = new Float64Array([...a, ...b, ...c, ...a, ...c, ...d]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  return generatedMeshModel(
    id,
    positions,
    indices,
    "generated-fixture",
    `Single tilted rectangular panel at ${angleFromVerticalDegrees} degrees from vertical, for overhang-check fixtures.`,
  );
}

function generatedMeshModel(
  id: string,
  positions: Float64Array,
  indices: Uint32Array,
  formatId: string,
  note: string,
): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: { positions, indices },
      },
    ],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `${id}.instance`,
          meshId: `${id}.mesh`,
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId,
      importerId: "analysis-test-fixture",
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

export function request(
  method: "surface-distance" | "axis-aligned-box-solid" | "unknown-method",
  options: {
    candidateTransform?: Mat4;
    parameters?: Record<string, unknown>;
    maxWorkUnits?: number;
    maxMemoryBytes?: number;
    baselineId?: string;
    candidateId?: string;
    toleranceMillimetres?: number;
  } = {},
): AnalysisRequest {
  return analysisRequestSchema.parse({
    contractVersion: 1,
    requestId: "analysis.request.1",
    baseline: {
      modelId: options.baselineId ?? "baseline",
      modelToComparison: IDENTITY_MAT4,
    },
    candidate: {
      modelId: options.candidateId ?? "candidate",
      modelToComparison: options.candidateTransform ?? IDENTITY_MAT4,
    },
    method: {
      id: method,
      version: "1.0.0",
      parameters: options.parameters ?? {},
    },
    tolerance: { distanceMillimetres: options.toleranceMillimetres ?? 0.01 },
    ...(options.maxWorkUnits === undefined
      ? {}
      : {
          executionBudget: {
            maxWorkUnits: options.maxWorkUnits,
            maxMemoryBytes: options.maxMemoryBytes ?? 8 * 1024 * 1024,
          },
        }),
  });
}

export function translation(x: number, y = 0, z = 0): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/**
 * Plain-string-id mirror of `NormalizedModel["placement"]`'s shape, used
 * only as `customModel`'s parameter type: the contracts schema's actual
 * `ModelPlacement` type uses branded id types (`MeshId`/`InstanceId`/
 * `NodeId`), which only a value already validated by that schema can carry,
 * so a fixture *building* a not-yet-validated placement from plain string
 * literals needs this unbranded shape instead -- `normalizedModelSchema.parse`
 * below both validates and brands it.
 */
export type CustomPlacement =
  | {
      readonly kind: "flat";
      readonly instances: readonly {
        readonly id: string;
        readonly meshId: string;
        readonly meshToModel: Mat4;
      }[];
    }
  | {
      readonly kind: "hierarchy";
      readonly instances: readonly {
        readonly id: string;
        readonly meshId: string;
        readonly meshToNode: Mat4;
      }[];
      readonly rootIds: readonly string[];
      readonly nodes: readonly {
        readonly id: string;
        readonly childIds: readonly string[];
        readonly instanceIds: readonly string[];
        readonly localToParent: Mat4;
      }[];
    };

/**
 * A generic multi-mesh, arbitrary-placement model builder -- unlike the
 * single-mesh, single-instance helpers above, this takes the full
 * `meshes`/`placement` shape directly, for fixtures (e.g.
 * `test/flatten-order.test.ts`, `test/triangle-locator.test.ts`) that need
 * more than one mesh, more than one instance, or a hierarchy placement with
 * explicit nodes.
 */
export function customModel(
  id: string,
  meshes: readonly {
    readonly id: string;
    readonly positions: readonly number[];
    readonly indices: readonly number[];
  }[],
  placement: CustomPlacement,
): NormalizedModel {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: meshes.map((mesh) => ({
      id: mesh.id,
      geometry: {
        positions: new Float64Array(mesh.positions),
        indices: new Uint32Array(mesh.indices),
      },
    })),
    placement,
    warnings: [],
    provenance: {
      formatId: "generated-fixture",
      importerId: "analysis-test-fixture",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [`Procedurally generated custom-placement fixture for ${id}.`],
    },
  });
}

/** One right triangle, local vertices `(0,0,0), (1,0,0), (0,1,0)` -- easy to translate by hand and check exactly (pure integer arithmetic, no floating-point tolerance needed). */
export const UNIT_TRIANGLE: { positions: number[]; indices: number[] } = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
};

/** Same shape as `UNIT_TRIANGLE`, but its local vertices are already offset by `(anchorX, 0, 0)` -- used so a mesh's identity is visible directly in its world-space coordinates even under an identity placement transform. */
export function anchoredTriangle(anchorX: number): {
  positions: number[];
  indices: number[];
} {
  return {
    positions: [anchorX, 0, 0, anchorX + 1, 0, 0, anchorX, 1, 0],
    indices: [0, 1, 2],
  };
}
