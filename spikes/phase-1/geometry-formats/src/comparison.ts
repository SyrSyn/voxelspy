import type { MeshGeometry } from "./contracts.ts";

export interface SolidValidation {
  readonly valid: boolean;
  readonly boundaryEdges: number;
  readonly nonManifoldEdges: number;
  readonly inconsistentEdges: number;
  readonly signedVolume: number;
  readonly reasons: readonly string[];
}

export interface SurfaceDistanceResult {
  readonly semantics: "approximate";
  readonly distanceMillimetres: number;
  readonly sampling: "vertices-and-centroids";
  readonly caveat: string;
}

export type OccupancyResult =
  | {
      readonly semantics: "approximate";
      readonly voxelSizeMillimetres: number;
      readonly differingVoxels: number;
      readonly sampledVoxels: number;
      readonly estimatedDifferenceVolumeCubicMillimetres: number;
    }
  | { readonly semantics: "indeterminate"; readonly reason: string };

export type AxisAlignedSolidResult =
  | {
      readonly semantics: "exact-for-validated-axis-aligned-boxes";
      readonly firstVolumeCubicMillimetres: number;
      readonly secondVolumeCubicMillimetres: number;
      readonly intersectionVolumeCubicMillimetres: number;
      readonly symmetricDifferenceVolumeCubicMillimetres: number;
    }
  | { readonly semantics: "indeterminate"; readonly reason: string };

export function validateClosedOrientedSolid(
  mesh: MeshGeometry,
): SolidValidation {
  const reasons = meshStructureProblems(mesh);
  const edges = new Map<string, { forward: number; reverse: number }>();
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const a = mesh.indices[triangle];
    const b = mesh.indices[triangle + 1];
    const c = mesh.indices[triangle + 2];
    if (a === undefined || b === undefined || c === undefined) continue;
    addEdge(edges, a, b);
    addEdge(edges, b, c);
    addEdge(edges, c, a);
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const edge of edges.values()) {
    const total = edge.forward + edge.reverse;
    if (total === 1) boundaryEdges += 1;
    else if (total > 2) nonManifoldEdges += 1;
    else if (edge.forward !== 1 || edge.reverse !== 1) inconsistentEdges += 1;
  }
  const signedVolume = meshSignedVolume(mesh);
  if (boundaryEdges > 0) reasons.push(`${boundaryEdges} boundary edges`);
  if (nonManifoldEdges > 0)
    reasons.push(`${nonManifoldEdges} non-manifold edges`);
  if (inconsistentEdges > 0)
    reasons.push(`${inconsistentEdges} inconsistently oriented edges`);
  if (!Number.isFinite(signedVolume)) reasons.push("non-finite signed volume");
  else if (Math.abs(signedVolume) < 1e-12) reasons.push("zero signed volume");
  return {
    valid: reasons.length === 0,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    signedVolume,
    reasons,
  };
}

export function sampledSurfaceDistance(
  first: MeshGeometry,
  second: MeshGeometry,
): SurfaceDistanceResult {
  assertComparableSurface(first, "First");
  assertComparableSurface(second, "Second");
  const forward = directedSampleDistance(sampleSurface(first), second);
  const reverse = directedSampleDistance(sampleSurface(second), first);
  return {
    semantics: "approximate",
    distanceMillimetres: Math.max(forward, reverse),
    sampling: "vertices-and-centroids",
    caveat:
      "Finite samples can miss an extremum between samples; this is not an exact Hausdorff distance",
  };
}

export function compareOccupancy(
  first: MeshGeometry,
  second: MeshGeometry,
  voxelSizeMillimetres: number,
  maxSampledVoxels = 1_000_000,
): OccupancyResult {
  if (!(voxelSizeMillimetres > 0))
    throw new Error("Voxel size must be positive");
  if (!Number.isSafeInteger(maxSampledVoxels) || maxSampledVoxels < 1)
    throw new Error("Sampled-voxel budget must be a positive safe integer");
  const firstValidation = validateClosedOrientedSolid(first);
  const secondValidation = validateClosedOrientedSolid(second);
  if (!firstValidation.valid || !secondValidation.valid) {
    return {
      semantics: "indeterminate",
      reason: `Occupancy requires closed oriented inputs: ${[...firstValidation.reasons, ...secondValidation.reasons].join("; ")}`,
    };
  }
  const bounds = unionBounds(meshBounds(first), meshBounds(second));
  const margin = voxelSizeMillimetres / 2;
  const sampleMinimum: Vec3 = [
    bounds.minimum[0] - margin,
    bounds.minimum[1] - margin,
    bounds.minimum[2] - margin,
  ];
  const counts = [0, 1, 2].map(
    (axis) =>
      Math.floor(
        ((bounds.maximum[axis] ?? 0) + margin - (sampleMinimum[axis] ?? 0)) /
          voxelSizeMillimetres,
      ) + 1,
  );
  const requiredSamples =
    (counts[0] ?? 0) * (counts[1] ?? 0) * (counts[2] ?? 0);
  if (
    !Number.isSafeInteger(requiredSamples) ||
    requiredSamples > maxSampledVoxels
  ) {
    return {
      semantics: "indeterminate",
      reason: `Occupancy requires ${requiredSamples} samples; budget is ${maxSampledVoxels}`,
    };
  }
  let differingVoxels = 0;
  let sampledVoxels = 0;
  for (let xIndex = 0; xIndex < (counts[0] ?? 0); xIndex += 1) {
    const x = sampleMinimum[0] + xIndex * voxelSizeMillimetres;
    for (let yIndex = 0; yIndex < (counts[1] ?? 0); yIndex += 1) {
      const y = sampleMinimum[1] + yIndex * voxelSizeMillimetres;
      for (let zIndex = 0; zIndex < (counts[2] ?? 0); zIndex += 1) {
        const z = sampleMinimum[2] + zIndex * voxelSizeMillimetres;
        sampledVoxels += 1;
        if (
          pointInsideMesh([x, y, z], first) !==
          pointInsideMesh([x, y, z], second)
        )
          differingVoxels += 1;
      }
    }
  }
  return {
    semantics: "approximate",
    voxelSizeMillimetres,
    differingVoxels,
    sampledVoxels,
    estimatedDifferenceVolumeCubicMillimetres:
      differingVoxels * voxelSizeMillimetres ** 3,
  };
}

export function compareValidatedAxisAlignedSolids(
  first: MeshGeometry,
  second: MeshGeometry,
): AxisAlignedSolidResult {
  const firstBox = validatedBox(first);
  const secondBox = validatedBox(second);
  if (firstBox === undefined || secondBox === undefined) {
    return {
      semantics: "indeterminate",
      reason:
        "The evidence kernel is exact only for validated, closed, axis-aligned boxes",
    };
  }
  const firstVolume = boundsVolume(firstBox);
  const secondVolume = boundsVolume(secondBox);
  const intersection = {
    minimum: [
      Math.max(firstBox.minimum[0], secondBox.minimum[0]),
      Math.max(firstBox.minimum[1], secondBox.minimum[1]),
      Math.max(firstBox.minimum[2], secondBox.minimum[2]),
    ] as [number, number, number],
    maximum: [
      Math.min(firstBox.maximum[0], secondBox.maximum[0]),
      Math.min(firstBox.maximum[1], secondBox.maximum[1]),
      Math.min(firstBox.maximum[2], secondBox.maximum[2]),
    ] as [number, number, number],
  };
  const intersectionVolume = boundsVolume(intersection);
  return {
    semantics: "exact-for-validated-axis-aligned-boxes",
    firstVolumeCubicMillimetres: firstVolume,
    secondVolumeCubicMillimetres: secondVolume,
    intersectionVolumeCubicMillimetres: intersectionVolume,
    symmetricDifferenceVolumeCubicMillimetres:
      firstVolume + secondVolume - 2 * intersectionVolume,
  };
}

function addEdge(
  edges: Map<string, { forward: number; reverse: number }>,
  from: number,
  to: number,
): void {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const key = `${low}:${high}`;
  const counts = edges.get(key) ?? { forward: 0, reverse: 0 };
  if (from === low) counts.forward += 1;
  else counts.reverse += 1;
  edges.set(key, counts);
}

function meshSignedVolume(mesh: MeshGeometry): number {
  let volume = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = point(mesh, mesh.indices[index] ?? 0);
    const b = point(mesh, mesh.indices[index + 1] ?? 0);
    const c = point(mesh, mesh.indices[index + 2] ?? 0);
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

function sampleSurface(mesh: MeshGeometry): [number, number, number][] {
  const samples: [number, number, number][] = [];
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1)
    samples.push(point(mesh, vertex));
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = point(mesh, mesh.indices[index] ?? 0);
    const b = point(mesh, mesh.indices[index + 1] ?? 0);
    const c = point(mesh, mesh.indices[index + 2] ?? 0);
    samples.push([
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ]);
  }
  return samples;
}

function directedSampleDistance(
  samples: readonly [number, number, number][],
  mesh: MeshGeometry,
): number {
  let maximum = 0;
  for (const sample of samples) {
    let minimumSquared = Number.POSITIVE_INFINITY;
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const distance = pointTriangleDistanceSquared(
        sample,
        point(mesh, mesh.indices[index] ?? 0),
        point(mesh, mesh.indices[index + 1] ?? 0),
        point(mesh, mesh.indices[index + 2] ?? 0),
      );
      minimumSquared = Math.min(minimumSquared, distance);
    }
    maximum = Math.max(maximum, Math.sqrt(minimumSquared));
  }
  return maximum;
}

function pointTriangleDistanceSquared(
  p: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number {
  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const ap = subtract(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return squaredLength(ap);
  const bp = subtract(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return squaredLength(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0)
    return squaredLength(subtract(p, add(a, scale(ab, d1 / (d1 - d3)))));
  const cp = subtract(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return squaredLength(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0)
    return squaredLength(subtract(p, add(a, scale(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = subtract(c, b);
    return squaredLength(
      subtract(p, add(b, scale(edge, (d4 - d3) / (d4 - d3 + (d5 - d6))))),
    );
  }
  const denominator = 1 / (va + vb + vc);
  return squaredLength(
    subtract(
      p,
      add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator))),
    ),
  );
}

function pointInsideMesh(pointValue: Vec3, mesh: MeshGeometry): boolean {
  const direction: Vec3 = [1, 0.000_013, 0.000_037];
  let hits = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    if (
      rayIntersectsTriangle(
        pointValue,
        direction,
        point(mesh, mesh.indices[index] ?? 0),
        point(mesh, mesh.indices[index + 1] ?? 0),
        point(mesh, mesh.indices[index + 2] ?? 0),
      )
    )
      hits += 1;
  }
  return hits % 2 === 1;
}

function rayIntersectsTriangle(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): boolean {
  const edge1 = subtract(b, a);
  const edge2 = subtract(c, a);
  const h = cross(direction, edge2);
  const determinant = dot(edge1, h);
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant;
  const s = subtract(origin, a);
  const u = inverse * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross(s, edge1);
  const v = inverse * dot(direction, q);
  return v >= 0 && u + v <= 1 && inverse * dot(edge2, q) > 1e-10;
}

type Vec3 = readonly [number, number, number];
interface Bounds {
  minimum: [number, number, number];
  maximum: [number, number, number];
}

function validatedBox(mesh: MeshGeometry): Bounds | undefined {
  const validation = validateClosedOrientedSolid(mesh);
  if (!validation.valid) return undefined;
  if (mesh.positions.length !== 8 * 3 || mesh.indices.length !== 12 * 3)
    return undefined;
  const bounds = meshBounds(mesh);
  const extents = bounds.maximum.map(
    (value, axis) => value - (bounds.minimum[axis] ?? value),
  );
  if (extents.some((extent) => !(extent > 0) || !Number.isFinite(extent)))
    return undefined;
  const corners = new Set<string>();
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
    const p = point(mesh, vertex);
    if (
      p.some(
        (value, axis) =>
          value !== bounds.minimum[axis] && value !== bounds.maximum[axis],
      )
    )
      return undefined;
    corners.add(p.join(","));
  }
  if (corners.size !== 8) return undefined;

  const faces = new Map<string, { triangles: number; area: number }>();
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const points = [
      point(mesh, mesh.indices[index] ?? 0),
      point(mesh, mesh.indices[index + 1] ?? 0),
      point(mesh, mesh.indices[index + 2] ?? 0),
    ];
    const planes: string[] = [];
    for (let axis = 0; axis < 3; axis += 1) {
      if (points.every((value) => value[axis] === bounds.minimum[axis]))
        planes.push(`${axis}:min`);
      if (points.every((value) => value[axis] === bounds.maximum[axis]))
        planes.push(`${axis}:max`);
    }
    if (planes.length !== 1) return undefined;
    const key = planes[0] ?? "";
    const face = faces.get(key) ?? { triangles: 0, area: 0 };
    face.triangles += 1;
    face.area += triangleArea(points[0]!, points[1]!, points[2]!);
    faces.set(key, face);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const expectedArea =
      (extents[(axis + 1) % 3] ?? 0) * (extents[(axis + 2) % 3] ?? 0);
    for (const side of ["min", "max"] as const) {
      const face = faces.get(`${axis}:${side}`);
      if (face?.triangles !== 2 || !approximatelyEqual(face.area, expectedArea))
        return undefined;
    }
  }
  const expectedVolume = boundsVolume(bounds);
  if (!approximatelyEqual(Math.abs(validation.signedVolume), expectedVolume))
    return undefined;
  if (!hasSingleTriangleComponent(mesh)) return undefined;
  return bounds;
}

function meshStructureProblems(mesh: MeshGeometry): string[] {
  const reasons: string[] = [];
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0)
    reasons.push("positions must contain nonempty XYZ triples");
  if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0)
    reasons.push("indices must contain nonempty triangles");
  if ([...mesh.positions].some((value) => !Number.isFinite(value)))
    reasons.push("coordinates must be finite");
  const vertexCount = mesh.positions.length / 3;
  if ([...mesh.indices].some((index) => index >= vertexCount))
    reasons.push("triangle index is out of range");
  let degenerateTriangles = 0;
  if (reasons.length === 0) {
    for (let index = 0; index < mesh.indices.length; index += 3) {
      if (
        triangleArea(
          point(mesh, mesh.indices[index] ?? 0),
          point(mesh, mesh.indices[index + 1] ?? 0),
          point(mesh, mesh.indices[index + 2] ?? 0),
        ) === 0
      )
        degenerateTriangles += 1;
    }
  }
  if (degenerateTriangles > 0)
    reasons.push(`${degenerateTriangles} degenerate triangles`);
  return reasons;
}

function assertComparableSurface(mesh: MeshGeometry, label: string): void {
  const problems = meshStructureProblems(mesh);
  if (problems.length > 0)
    throw new Error(`${label} surface is invalid: ${problems.join("; ")}`);
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return Math.sqrt(squaredLength(cross(subtract(b, a), subtract(c, a)))) / 2;
}

function approximatelyEqual(first: number, second: number): boolean {
  const scale = Math.max(1, Math.abs(first), Math.abs(second));
  return Math.abs(first - second) <= scale * 1e-10;
}

function hasSingleTriangleComponent(mesh: MeshGeometry): boolean {
  const triangleCount = mesh.indices.length / 3;
  const trianglesByVertex = new Map<number, number[]>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[triangle * 3 + corner] ?? 0;
      const triangles = trianglesByVertex.get(vertex) ?? [];
      triangles.push(triangle);
      trianglesByVertex.set(vertex, triangles);
    }
  }
  const visited = new Set<number>([0]);
  const pending = [0];
  while (pending.length > 0) {
    const triangle = pending.pop() ?? 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[triangle * 3 + corner] ?? 0;
      for (const neighbor of trianglesByVertex.get(vertex) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
  }
  return visited.size === triangleCount;
}

function meshBounds(mesh: MeshGeometry): Bounds {
  const minimum: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const maximum: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
    const p = point(mesh, vertex);
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(
        minimum[axis] ?? Number.POSITIVE_INFINITY,
        p[axis] ?? 0,
      );
      maximum[axis] = Math.max(
        maximum[axis] ?? Number.NEGATIVE_INFINITY,
        p[axis] ?? 0,
      );
    }
  }
  return { minimum, maximum };
}

function unionBounds(first: Bounds, second: Bounds): Bounds {
  return {
    minimum: first.minimum.map((value, axis) =>
      Math.min(value, second.minimum[axis] ?? value),
    ) as [number, number, number],
    maximum: first.maximum.map((value, axis) =>
      Math.max(value, second.maximum[axis] ?? value),
    ) as [number, number, number],
  };
}

function boundsVolume(bounds: Bounds): number {
  return (
    Math.max(0, bounds.maximum[0] - bounds.minimum[0]) *
    Math.max(0, bounds.maximum[1] - bounds.minimum[1]) *
    Math.max(0, bounds.maximum[2] - bounds.minimum[2])
  );
}

function point(mesh: MeshGeometry, vertex: number): [number, number, number] {
  return [
    mesh.positions[vertex * 3] ?? 0,
    mesh.positions[vertex * 3 + 1] ?? 0,
    mesh.positions[vertex * 3 + 2] ?? 0,
  ];
}
function subtract(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, factor: number): [number, number, number] {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function squaredLength(a: Vec3): number {
  return dot(a, a);
}
