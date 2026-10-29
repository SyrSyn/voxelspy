import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/run.js";
import {
  createCapturedIO,
  createTestWorkspace,
  cubeStlAscii,
} from "./fixtures.js";
const FRAME = ["--unit", "millimetre", "--axis", "right-handed-z-up"];
const directories: string[] = [];
function fixture() {
  const workspace = createTestWorkspace();
  directories.push(workspace.dir);
  return workspace.writeFile("cube.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function execute(command: string, path: string, args: string[]) {
  const captured = createCapturedIO();
  const code = await run([command, path, ...FRAME, ...args], captured.io);
  return { ...captured, code };
}
const queries = [
  ["measure", ["--kind", "bounding-extent"]],
  ["section", ["--point", "0,0,5", "--normal", "0,0,1"]],
  ["printability", []],
] as const;

describe("headless analysis tools", () => {
  it("measures cube extents and preserves deterministic source/placement evidence", async () => {
    const path = fixture();
    const a = await execute("measure", path, [
      "--kind",
      "bounding-extent",
      "--json",
    ]);
    const b = await execute("measure", path, [
      "--kind",
      "bounding-extent",
      "--json",
    ]);
    expect(a.code).toBe(0);
    expect(a.stdout).toEqual(b.stdout);
    const report = JSON.parse(a.stdout.join("\n"));
    expect(report.outputVersion).toBe(1);
    expect(report.result.bounds.dimensionsMillimetres).toEqual([10, 10, 10]);
    expect(report.model.provenance.sourceUnit).toBe("millimetre");
    expect(report.request.options.modelToComparison).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
  });
  it("answers independent distance and closest-surface oracles", async () => {
    const path = fixture();
    const first = await execute("measure", path, [
      "--kind",
      "point-to-point",
      "--first",
      "0,0,0",
      "--second",
      "3,4,0",
      "--json",
    ]);
    expect(JSON.parse(first.stdout.join("\n")).result.distanceMillimetres).toBe(
      5,
    );
    const surface = await execute("measure", path, [
      "--kind",
      "point-to-surface",
      "--point",
      "5,5,13",
      "--json",
    ]);
    expect(
      JSON.parse(surface.stdout.join("\n")).result.distanceMillimetres,
    ).toBe(3);
  });
  it("supports point snaps and missed rays without inventing a failed policy", async () => {
    const path = fixture();
    const point = await execute("measure", path, [
      "--kind",
      "snap-point",
      "--point",
      "0,0,1",
      "--json",
    ]);
    expect(point.code).toBe(0);
    const hit = JSON.parse(point.stdout.join("\n")).result.outcome;
    expect(hit.hit).toBe(true);
    const ray = await execute("measure", path, [
      "--kind",
      "snap-point",
      "--ray-origin",
      "20,20,20",
      "--ray-direction",
      "1,0,0",
      "--json",
    ]);
    expect(ray.code).toBe(0);
    expect(JSON.parse(ray.stdout.join("\n")).result.outcome.hit).toBe(false);
  });
  it("cuts a cube with exact perimeter/area and bounded return points", async () => {
    const path = fixture();
    const output = await execute("section", path, [
      "--point",
      "0,0,5",
      "--normal",
      "0,0,2",
      "--max-loop-points",
      "2",
      "--json",
    ]);
    expect(output.code).toBe(0);
    const result = JSON.parse(output.stdout.join("\n")).result;
    expect(result.plane.unitNormal).toEqual([0, 0, 1]);
    expect(result.loops.loopCount).toBe(1);
    expect(result.loops.loops[0]).toMatchObject({
      closed: true,
      perimeterMillimetres: 40,
      pointsTruncated: true,
      area: { available: true, absoluteSquareMillimetres: 100 },
    });
    expect(result.loops.loops[0].pointsMillimetres).toHaveLength(2);
  });
  it("reports build-volume failure and sparse probe caveats as informational evidence", async () => {
    const output = await execute("printability", fixture(), [
      "--build-volume",
      "5,5,5",
      "--max-sample-triangles",
      "1",
      "--json",
    ]);
    expect(output.code).toBe(0);
    const result = JSON.parse(output.stdout.join("\n")).result;
    expect(result.buildVolume.fitsInAnyOrientation).toBe(false);
    expect(result.wallThickness.unsampledTriangleCount).toBe(11);
    expect(result.wallThickness.semantics).toBe(
      "approximate-directional-probe",
    );
    expect(result.disclaimer).toContain("not a printability verdict");
  });
  it.each(queries)(
    "%s refuses exhausted execution and import budgets",
    async (command, args) => {
      const path = fixture();
      const budgetArgs =
        command === "measure"
          ? ["--kind", "point-to-surface", "--point", "5,5,13"]
          : [...args];
      const exhausted = await execute(command, path, [
        ...budgetArgs,
        "--max-work-units",
        "1",
        "--json",
      ]);
      expect(exhausted.code).toBe(2);
      expect(JSON.parse(exhausted.stdout.join("\n")).error.code).toBe(
        "resource-limit",
      );
      expect(
        (
          await execute(command, path, [
            ...budgetArgs,
            "--max-work-units",
            "1",
            "--fail-on-indeterminate",
          ])
        ).code,
      ).toBe(1);
      expect(
        (await execute(command, path, [...args, "--max-input-bytes", "1"]))
          .code,
      ).toBe(2);
      expect(
        (await execute(command, path, [...args, "--max-memory-bytes", "1"]))
          .code,
      ).toBe(2);
      const fullA = await execute(command, path, [...args, "--json"]);
      const fullB = await execute(command, path, [...args, "--json"]);
      expect(fullA.stdout).toEqual(fullB.stdout);
      const unresolved = createCapturedIO();
      expect(await run([command, path, ...args], unresolved.io)).toBe(3);
    },
  );
  it.each([
    ["measure", ["--kind", "bounding-extent", "--point", "0,0,0"]],
    ["measure", ["--kind", "point-to-point", "--first", "0,0,0"]],
    ["measure", ["--kind", "point-to-surface", "--point", "1,,3"]],
    [
      "measure",
      ["--kind", "snap-point", "--point", "0,0,0", "--ray-origin", "0,0,0"],
    ],
    [
      "measure",
      [
        "--kind",
        "snap-point",
        "--ray-origin",
        "0,0,0",
        "--ray-direction",
        "0,0,0",
      ],
    ],
    ["section", ["--point", "0,0,0", "--normal", "0,0,0"]],
    [
      "section",
      ["--point", "0,0,0", "--normal", "0,0,1", "--max-loops", "2001"],
    ],
    ["printability", ["--build-volume", "5,-1,5"]],
    ["printability", ["--overhang-angle", "91"]],
    ["printability", ["--build-direction", "0,0,0"]],
    ["printability", ["--max-sample-triangles", "200001"]],
  ])(
    "%s rejects malformed or inapplicable options %j",
    async (command, args) => {
      const output = await execute(
        command as string,
        fixture(),
        args as string[],
      );
      expect(output.code).toBe(3);
      expect(output.stderr.length).toBeGreaterThan(0);
    },
  );
  it.each(queries)(
    "%s is discoverable and rejects excess positionals",
    async (command, args) => {
      const help = createCapturedIO();
      expect(await run([command, "--help"], help.io)).toBe(0);
      expect(help.stdout.join("\n")).toContain(`Usage: voxelspy ${command}`);
      expect(
        (await execute(command, fixture(), [...args, "extra.stl"])).code,
      ).toBe(3);
    },
  );
});
