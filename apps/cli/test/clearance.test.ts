import { describe, expect, it } from "vitest";
import { clearanceCommand } from "../src/commands/clearance.js";
import { EXIT_INDETERMINATE, EXIT_OK, EXIT_POLICY_FAILED, EXIT_USAGE_ERROR } from "../src/exit-codes.js";
import { run } from "../src/run.js";
import { createCapturedIO, createTestWorkspace, cubeStlAscii } from "./fixtures.js";

const FRAME_ARGS = [
  "--first-unit",
  "millimetre",
  "--first-axis",
  "right-handed-z-up",
  "--second-unit",
  "millimetre",
  "--second-axis",
  "right-handed-z-up",
];

describe("clearanceCommand", () => {
  it("reports state clear and exits 0 for well-separated parts", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile("first.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const second = workspace.writeFile("second.stl", cubeStlAscii([100, 0, 0], [110, 10, 10]));
    const { io, stdout } = createCapturedIO();

    const code = await clearanceCommand(
      [first, second, "--clearance", "1", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.startsWith("State: clear"))).toBe(true);
    expect(stdout.some((line) => line.includes("Sample spacing bound"))).toBe(true);
  });

  it("reports state tight and fails by default, but passes with --allow-tight", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile("first.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const second = workspace.writeFile("second.stl", cubeStlAscii([10.5, 0, 0], [20.5, 10, 10]));

    const { io: strictIo, stdout: strictOut } = createCapturedIO();
    const strictCode = await clearanceCommand(
      [first, second, "--clearance", "1", ...FRAME_ARGS],
      strictIo,
    );
    expect(strictCode).toBe(EXIT_POLICY_FAILED);
    expect(strictOut.some((line) => line.startsWith("State: tight"))).toBe(true);

    const { io: lenientIo } = createCapturedIO();
    const lenientCode = await clearanceCommand(
      [first, second, "--clearance", "1", "--allow-tight", ...FRAME_ARGS],
      lenientIo,
    );
    expect(lenientCode).toBe(EXIT_OK);
  });

  it("reports state interfering with exact triangle-pair evidence", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile("first.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const second = workspace.writeFile("second.stl", cubeStlAscii([5, 0, 0], [15, 10, 10]));
    const { io, stdout } = createCapturedIO();

    const code = await clearanceCommand(
      [first, second, "--clearance", "1", "--allow-tight", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_POLICY_FAILED);
    expect(stdout.some((line) => line.startsWith("State: interfering"))).toBe(true);
    expect(
      stdout.some((line) => /Interference: [1-9]\d* intersecting triangle pair/u.test(line)),
    ).toBe(true);
  });

  it("emits deterministic JSON for identical inputs", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile("first.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const second = workspace.writeFile("second.stl", cubeStlAscii([10.5, 0, 0], [20.5, 10, 10]));
    const args = [first, second, "--clearance", "1", "--json", ...FRAME_ARGS];

    const one = createCapturedIO();
    await clearanceCommand(args, one.io);
    const two = createCapturedIO();
    await clearanceCommand(args, two.io);

    expect(one.stdout).toEqual(two.stdout);
    const parsed: unknown = JSON.parse(one.stdout.join("\n"));
    expect(parsed).toMatchObject({ command: "clearance" });
  });

  it("reports indeterminate and fails closed when the work budget is exhausted", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile("first.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const second = workspace.writeFile("second.stl", cubeStlAscii([100, 0, 0], [110, 10, 10]));

    const { io, stdout } = createCapturedIO();
    const code = await clearanceCommand(
      [first, second, "--clearance", "1", "--max-work-units", "1", ...FRAME_ARGS],
      io,
    );
    expect(code).toBe(EXIT_INDETERMINATE);
    expect(stdout.some((line) => line.includes("INDETERMINATE"))).toBe(true);
  });

  it("fails closed with a specific reason when the source frame is unresolved", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile("first.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const second = workspace.writeFile("second.stl", cubeStlAscii([100, 0, 0], [110, 10, 10]));
    const { io, stderr } = createCapturedIO();

    const code = await clearanceCommand([first, second, "--clearance", "1"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("needs-input"))).toBe(true);
  });

  it("rejects a missing --clearance as a usage error", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile("first.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const second = workspace.writeFile("second.stl", cubeStlAscii([100, 0, 0], [110, 10, 10]));
    const { io, stderr } = createCapturedIO();

    const code = await run(["clearance", first, second, ...FRAME_ARGS], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("--clearance"))).toBe(true);
  });

  it("rejects missing positional arguments as a usage error", async () => {
    const { io, stderr } = createCapturedIO();
    const code = await run(["clearance", "--clearance", "1"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("requires two positional arguments"))).toBe(true);
  });
});
