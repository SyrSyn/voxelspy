import { describe, expect, it } from "vitest";
import { compareCommand } from "../src/commands/compare.js";
import { EXIT_INDETERMINATE, EXIT_OK, EXIT_POLICY_FAILED, EXIT_USAGE_ERROR } from "../src/exit-codes.js";
import { run } from "../src/run.js";
import { createCapturedIO, createTestWorkspace, cubeObj, cubeStlAscii } from "./fixtures.js";

const FRAME_ARGS = [
  "--baseline-unit",
  "millimetre",
  "--baseline-axis",
  "right-handed-z-up",
  "--candidate-unit",
  "millimetre",
  "--candidate-axis",
  "right-handed-z-up",
];

describe("compareCommand", () => {
  it("reports no changes and exits 0 for identical cubes with no policy options", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("informational only"))).toBe(true);
    expect(stdout.some((line) => line.includes("Sample spacing bound"))).toBe(true);
  });

  it("compares an OBJ baseline against an STL candidate", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.obj", cubeObj([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("informational only"))).toBe(true);
  });

  it("passes --max-deviation when the true maximum distance is within bounds", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 12]));
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", "--max-deviation", "5", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("Policy result: PASSED"))).toBe(true);
  });

  it("fails --max-deviation when the true maximum distance exceeds the bound", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 12]));
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", "--max-deviation", "1", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_POLICY_FAILED);
    expect(stdout.some((line) => line.includes("Policy result: FAILED"))).toBe(true);
    expect(stdout.some((line) => /\[FAIL\] maximum deviation/u.test(line))).toBe(true);
  });

  it("evaluates --fail-on-regions against the true detected region count", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 12]));
    const { io: passIo } = createCapturedIO();
    const passCode = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", "--fail-on-regions", "10", ...FRAME_ARGS],
      passIo,
    );
    expect(passCode).toBe(EXIT_OK);

    const { io: failIo } = createCapturedIO();
    const failCode = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", "--fail-on-regions", "0", ...FRAME_ARGS],
      failIo,
    );
    expect(failCode).toBe(EXIT_POLICY_FAILED);
  });

  it("evaluates --require-watertight against both mesh assessments", async () => {
    const workspace = createTestWorkspace();
    const closedA = workspace.writeFile("closed-a.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const closedB = workspace.writeFile("closed-b.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const open = workspace.writeFile(
      "open.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10], { omitTop: true }),
    );

    const { io: passIo } = createCapturedIO();
    const passCode = await compareCommand(
      [closedA, closedB, "--tolerance", "0.01", "--require-watertight", ...FRAME_ARGS],
      passIo,
    );
    expect(passCode).toBe(EXIT_OK);

    const { io: failIo } = createCapturedIO();
    const failCode = await compareCommand(
      [closedA, open, "--tolerance", "0.01", "--require-watertight", ...FRAME_ARGS],
      failIo,
    );
    expect(failCode).toBe(EXIT_POLICY_FAILED);
  });

  it("emits deterministic JSON for identical inputs", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 12]));
    const args = [baseline, candidate, "--tolerance", "0.01", "--json", ...FRAME_ARGS];

    const first = createCapturedIO();
    await compareCommand(args, first.io);
    const second = createCapturedIO();
    await compareCommand(args, second.io);

    expect(first.stdout).toEqual(second.stdout);
    expect(first.stdout.join("\n")).toContain('"command": "compare"');
    const parsed: unknown = JSON.parse(first.stdout.join("\n"));
    expect(parsed).toMatchObject({ command: "compare" });
  });

  it("reports indeterminate and fails closed when the work budget is exhausted", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 12]));

    const { io: defaultIo, stdout: defaultOut } = createCapturedIO();
    const defaultCode = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", "--max-work-units", "1", ...FRAME_ARGS],
      defaultIo,
    );
    expect(defaultCode).toBe(EXIT_INDETERMINATE);
    expect(defaultOut.some((line) => line.includes("INDETERMINATE"))).toBe(true);

    const { io: strictIo } = createCapturedIO();
    const strictCode = await compareCommand(
      [
        baseline,
        candidate,
        "--tolerance",
        "0.01",
        "--max-work-units",
        "1",
        "--fail-on-indeterminate",
        ...FRAME_ARGS,
      ],
      strictIo,
    );
    expect(strictCode).toBe(EXIT_POLICY_FAILED);
  });

  it("fails closed with a specific reason when the source frame is unresolved", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stderr } = createCapturedIO();

    const code = await compareCommand([baseline, candidate, "--tolerance", "0.01"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("needs-input"))).toBe(true);
  });

  it("fails closed with a specific reason for an unrecognized format", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.txt", "not a model");
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stderr } = createCapturedIO();

    const code = await run(
      ["compare", baseline, candidate, "--tolerance", "0.01", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("unrecognized extension"))).toBe(true);
  });

  it("rejects missing positional arguments as a usage error", async () => {
    const { io, stderr } = createCapturedIO();
    const code = await run(["compare", "--tolerance", "0.01"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("requires two positional arguments"))).toBe(true);
  });

  it("rejects a missing --tolerance as a usage error", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const candidate = workspace.writeFile("candidate.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
    const { io, stderr } = createCapturedIO();

    const code = await run(["compare", baseline, candidate, ...FRAME_ARGS], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("--tolerance"))).toBe(true);
  });

  it("rejects an unknown flag as a usage error", async () => {
    const { io, stderr } = createCapturedIO();
    const code = await run(["compare", "--bogus-flag"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
