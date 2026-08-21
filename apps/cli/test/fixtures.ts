import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandIO } from "../src/io.js";

type Point = readonly [number, number, number];

/**
 * Builds a closed, 12-triangle, facet-local ASCII STL box between `min` and
 * `max`, with consistent outward-facing winding on every face (so a fixture
 * built from this generator alone never trips the "inconsistent-orientation"
 * topology finding). Every one of the 12 box edges is shared by exactly two
 * triangles, so the mesh is always topologically closed.
 */
export function cubeStlAscii(
  min: Point,
  max: Point,
  options: { readonly name?: string; readonly omitTop?: boolean } = {},
): string {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const a: Point = [x0, y0, z0];
  const b: Point = [x1, y0, z0];
  const c: Point = [x1, y1, z0];
  const d: Point = [x0, y1, z0];
  const e: Point = [x0, y0, z1];
  const f: Point = [x1, y0, z1];
  const g: Point = [x1, y1, z1];
  const h: Point = [x0, y1, z1];

  const faces: (readonly [Point, Point, Point, Point])[] = [
    [a, d, c, b], // bottom, outward normal -z
    ...(options.omitTop ? [] : [[e, f, g, h] as const]), // top, outward normal +z
    [a, b, f, e], // front, outward normal -y
    [d, h, g, c], // back, outward normal +y
    [a, e, h, d], // left, outward normal -x
    [b, c, g, f], // right, outward normal +x
  ];

  const triangles: (readonly [Point, Point, Point])[] = [];
  for (const [v0, v1, v2, v3] of faces) {
    triangles.push([v0, v1, v2]);
    triangles.push([v0, v2, v3]);
  }

  const name = options.name ?? "fixture";
  const lines: string[] = [`solid ${name}`];
  for (const [v0, v1, v2] of triangles) {
    lines.push("facet normal 0 0 0");
    lines.push("outer loop");
    lines.push(`vertex ${v0[0]} ${v0[1]} ${v0[2]}`);
    lines.push(`vertex ${v1[0]} ${v1[1]} ${v1[2]}`);
    lines.push(`vertex ${v2[0]} ${v2[1]} ${v2[2]}`);
    lines.push("endloop");
    lines.push("endfacet");
  }
  lines.push(`endsolid ${name}`);
  return `${lines.join("\n")}\n`;
}

/** Appends one isolated, zero-area (collinear-point) triangle, far outside `min`/`max`, to an otherwise-closed cube. */
export function cubeStlWithDegenerateTriangle(min: Point, max: Point): string {
  const closed = cubeStlAscii(min, max, { name: "degenerate-fixture" });
  const degenerate = [
    "facet normal 0 0 0",
    "outer loop",
    "vertex 1000 0 0",
    "vertex 1005 0 0",
    "vertex 1010 0 0",
    "endloop",
    "endfacet",
    "",
  ].join("\n");
  return closed.replace(/endsolid .*$/mu, `${degenerate}endsolid degenerate-fixture\n`);
}

/** A minimal, valid, 12-triangle OBJ box (shared, not facet-local, vertices). */
export function cubeObj(min: Point, max: Point): string {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const vertices: Point[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  // 1-based OBJ face corners, two triangles per face, matching cubeStlAscii's consistent outward winding.
  const faces: (readonly [number, number, number, number])[] = [
    [1, 4, 3, 2], // bottom
    [5, 6, 7, 8], // top
    [1, 2, 6, 5], // front
    [4, 8, 7, 3], // back
    [1, 5, 8, 4], // left
    [2, 3, 7, 6], // right
  ];
  const lines: string[] = vertices.map(([x, y, z]) => `v ${x} ${y} ${z}`);
  for (const [v0, v1, v2, v3] of faces) {
    lines.push(`f ${v0} ${v1} ${v2}`);
    lines.push(`f ${v0} ${v2} ${v3}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface TestWorkspace {
  readonly dir: string;
  writeFile(name: string, content: string): string;
}

export interface CapturedIO {
  readonly io: CommandIO;
  readonly stdout: string[];
  readonly stderr: string[];
}

export function createCapturedIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

export function createTestWorkspace(): TestWorkspace {
  const dir = mkdtempSync(join(tmpdir(), "voxelspy-cli-test-"));
  return {
    dir,
    writeFile(name: string, content: string): string {
      const path = join(dir, name);
      writeFileSync(path, content, "utf8");
      return path;
    },
  };
}
