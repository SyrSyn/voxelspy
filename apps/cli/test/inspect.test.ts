import { describe, expect, it } from "vitest";
import { inspectCommand } from "../src/commands/inspect.js";
import { EXIT_OK, EXIT_POLICY_FAILED, EXIT_USAGE_ERROR } from "../src/exit-codes.js";
import { run } from "../src/run.js";
import {
  createCapturedIO,
  createTestWorkspace,
  cubeStlAscii,
  cubeStlWithDegenerateTriangle,
} from "./fixtures.js";

const FRAME_ARGS = ["--unit", "millimetre", "--axis", "right-handed-z-up"];

describe("inspectCommand", () => {
  it("reports a closed model with no findings and exits 0 with no policy options", async () => {
    const workspace = createTestWorkspace();
    const model = workspace.writeFile("model.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stdout } = createCapturedIO();

    const code = await inspectCommand([model, ...FRAME_ARGS], io);

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("Watertightness: closed"))).toBe(true);
    expect(stdout.some((line) => line.includes("No topology findings"))).toBe(true);
    expect(stdout.some((line) => line.includes("informational only"))).toBe(true);
  });

  it("evaluates --require-watertight against the watertightness verdict", async () => {
    const workspace = createTestWorkspace();
    const closed = workspace.writeFile("closed.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const open = workspace.writeFile(
      "open.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10], { omitTop: true }),
    );

    const { io: passIo } = createCapturedIO();
    expect(await inspectCommand([closed, "--require-watertight", ...FRAME_ARGS], passIo)).toBe(
      EXIT_OK,
    );

    const { io: failIo, stdout: failOut } = createCapturedIO();
    const failCode = await inspectCommand([open, "--require-watertight", ...FRAME_ARGS], failIo);
    expect(failCode).toBe(EXIT_POLICY_FAILED);
    expect(failOut.some((line) => line.includes("Policy result: FAILED"))).toBe(true);
  });

  it("evaluates --fail-on-degenerate against topology findings", async () => {
    const workspace = createTestWorkspace();
    const clean = workspace.writeFile("clean.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const degenerate = workspace.writeFile(
      "degenerate.stl",
      cubeStlWithDegenerateTriangle([0, 0, 0], [10, 10, 10]),
    );

    const { io: passIo } = createCapturedIO();
    expect(await inspectCommand([clean, "--fail-on-degenerate", ...FRAME_ARGS], passIo)).toBe(
      EXIT_OK,
    );

    const { io: failIo } = createCapturedIO();
    const failCode = await inspectCommand(
      [degenerate, "--fail-on-degenerate", ...FRAME_ARGS],
      failIo,
    );
    expect(failCode).toBe(EXIT_POLICY_FAILED);
  });

  it("emits deterministic JSON for identical inputs", async () => {
    const workspace = createTestWorkspace();
    const model = workspace.writeFile("model.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const args = [model, "--json", ...FRAME_ARGS];

    const first = createCapturedIO();
    await inspectCommand(args, first.io);
    const second = createCapturedIO();
    await inspectCommand(args, second.io);

    expect(first.stdout).toEqual(second.stdout);
    const parsed: unknown = JSON.parse(first.stdout.join("\n"));
    expect(parsed).toMatchObject({ command: "inspect" });
  });

  it("fails closed with a specific reason when the source frame is unresolved", async () => {
    const workspace = createTestWorkspace();
    const model = workspace.writeFile("model.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stderr } = createCapturedIO();

    const code = await inspectCommand([model], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("needs-input"))).toBe(true);
  });

  it("rejects an out-of-range option value as a usage error", async () => {
    const workspace = createTestWorkspace();
    const model = workspace.writeFile("model.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stderr } = createCapturedIO();

    const code = await run(
      ["inspect", model, "--max-topology-examples", "99999", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("rejects a missing positional argument as a usage error", async () => {
    const { io, stderr } = createCapturedIO();
    const code = await run(["inspect"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("requires one positional argument"))).toBe(true);
  });
});
