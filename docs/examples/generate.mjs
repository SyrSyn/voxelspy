// Original synthetic demo geometry, distributed under the repository MIT license.
// Run from the repository root: node docs/examples/generate.mjs
import { writeFileSync } from "node:fs";

function sleeve(height, radius) {
  const profile = [
    [23, 0],
    [23, 5],
    [radius, 5],
    [radius, height],
    [10, height],
    [10, 0],
  ];
  const n = 96;
  let lines = ["solid sleeve"];
  const v = (j, i) => {
    const [r, z] = profile[j % profile.length],
      a = (2 * Math.PI * (i % n)) / n;
    return [r * Math.cos(a), r * Math.sin(a), z].map((x) => +x.toFixed(6));
  };
  for (let j = 0; j < profile.length; j++)
    for (let i = 0; i < n; i++) {
      const a = v(j, i),
        b = v(j, i + 1),
        c = v(j + 1, i + 1),
        d = v(j + 1, i);
      for (const t of [
        [a, b, c],
        [a, c, d],
      ])
        lines.push(
          "facet normal 0 0 0",
          "outer loop",
          ...t.map((p) => "vertex " + p.join(" ")),
          "endloop",
          "endfacet",
        );
    }
  lines.push("endsolid sleeve");
  return Buffer.from(lines.join("\n"));
}

for (const [name, height, radius] of [
  ["mounting-sleeve-rev-a.stl", 28, 15],
  ["mounting-sleeve-rev-b.stl", 33, 17],
]) {
  writeFileSync(new URL(name, import.meta.url), sleeve(height, radius));
}
