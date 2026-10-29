import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/run.js";
import {
  createCapturedIO,
  createTestWorkspace,
  cubeStlAscii,
} from "./fixtures.js";
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const FRAME = [
  "--first-unit",
  "millimetre",
  "--first-axis",
  "right-handed-z-up",
  "--second-unit",
  "millimetre",
  "--second-axis",
  "right-handed-z-up",
  "--clearance",
  "2",
];
describe("explicit clearance placement", () => {
  it("separates coincident cubes by a rigid translation and records it in each output", async () => {
    const workspace = createTestWorkspace();
    try {
      const path = workspace.writeFile(
        "cube.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const translation = [...IDENTITY];
      translation[12] = 15;
      const sarif = join(workspace.dir, "check.sarif");
      const markdown = join(workspace.dir, "check.md");
      const output = createCapturedIO();
      expect(
        await run(
          [
            "clearance",
            path,
            path,
            ...FRAME,
            "--second-transform",
            translation.join(","),
            "--json",
            "--sarif",
            sarif,
            "--markdown",
            markdown,
          ],
          output.io,
        ),
      ).toBe(0);
      const report = JSON.parse(output.stdout.join("\n"));
      expect(report.result.minimumDistanceMillimetres).toBe(5);
      expect(report.result.state).toBe("clear");
      expect(report.second.modelToComparison).toEqual(translation);
      expect(
        JSON.parse(readFileSync(sarif, "utf8")).runs[0].properties.placements
          .second,
      ).toEqual(translation);
      expect(readFileSync(markdown, "utf8")).toContain(
        JSON.stringify(translation),
      );
      const original = createCapturedIO();
      expect(await run(["clearance", path, path, ...FRAME], original.io)).toBe(
        1,
      );
    } finally {
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });
  it.each([
    [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [1, 2, 3],
  ])("refuses non-rigid or malformed placements %j", async (...matrix) => {
    const output = createCapturedIO();
    expect(
      await run(
        [
          "clearance",
          "first.stl",
          "second.stl",
          ...FRAME,
          `--first-transform=${matrix.join(",")}`,
        ],
        output.io,
      ),
    ).toBe(3);
    expect(output.stderr.join("\n")).toContain("proper rigid transform");
  });
});
