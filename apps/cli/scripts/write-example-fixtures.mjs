#!/usr/bin/env node
// Writes two tiny, synthetic ASCII-STL cube fixtures for the example
// `.github/workflows/geometry-check.yml` workflow to compare -- the same
// kind of fixture `apps/cli/test/fixtures.ts` generates in-process for
// vitest, duplicated here in plain JS (no TypeScript build step, no test
// framework) so a CI job can call it with a bare `node` invocation before
// the workspace is built.
//
// This intentionally never reads or writes a real, versioned model asset:
// see the workflow file's own comment for why these two files exist only
// to demonstrate the CLI's automation-output options, not to guard any
// actual geometry in this repository.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function cubeStlAscii(min, max, name) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const a = [x0, y0, z0];
  const b = [x1, y0, z0];
  const c = [x1, y1, z0];
  const d = [x0, y1, z0];
  const e = [x0, y0, z1];
  const f = [x1, y0, z1];
  const g = [x1, y1, z1];
  const h = [x0, y1, z1];

  const faces = [
    [a, d, c, b], // bottom, outward normal -z
    [e, f, g, h], // top, outward normal +z
    [a, b, f, e], // front, outward normal -y
    [d, h, g, c], // back, outward normal +y
    [a, e, h, d], // left, outward normal -x
    [b, c, g, f], // right, outward normal +x
  ];

  const lines = [`solid ${name}`];
  for (const [v0, v1, v2, v3] of faces) {
    for (const [p0, p1, p2] of [
      [v0, v1, v2],
      [v0, v2, v3],
    ]) {
      lines.push("facet normal 0 0 0");
      lines.push("outer loop");
      lines.push(`vertex ${p0[0]} ${p0[1]} ${p0[2]}`);
      lines.push(`vertex ${p1[0]} ${p1[1]} ${p1[2]}`);
      lines.push(`vertex ${p2[0]} ${p2[1]} ${p2[2]}`);
      lines.push("endloop");
      lines.push("endfacet");
    }
  }
  lines.push(`endsolid ${name}`);
  return `${lines.join("\n")}\n`;
}

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error("Usage: write-example-fixtures.mjs <output-directory>");
  process.exit(3);
}

mkdirSync(outDir, { recursive: true });
// A 10mm cube, and a revision of it stretched 2mm taller in Z -- enough of
// a deviation that `--max-deviation 0.5` (used by the example workflow)
// fails, so the workflow's "fail the job on a policy failure" step has
// something real to demonstrate.
writeFileSync(
  join(outDir, "baseline.stl"),
  cubeStlAscii([0, 0, 0], [10, 10, 10], "baseline"),
  "utf8",
);
writeFileSync(
  join(outDir, "candidate.stl"),
  cubeStlAscii([0, 0, 0], [10, 10, 12], "candidate"),
  "utf8",
);
console.log(`Wrote example fixtures to ${outDir}`);
