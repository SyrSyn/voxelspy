import { readFileSync } from "node:fs";
import { join } from "node:path";
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

interface SarifLog {
  readonly runs: readonly {
    readonly results: readonly {
      readonly ruleId: string;
      readonly level: string;
    }[];
  }[];
}

function readSarif(path: string): SarifLog {
  return JSON.parse(readFileSync(path, "utf8")) as SarifLog;
}

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

  describe("--sarif and --markdown", () => {
    it("writes an error-level not-watertight SARIF result and does not change the exit code", async () => {
      const workspace = createTestWorkspace();
      const open = workspace.writeFile(
        "open.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10], { omitTop: true }),
      );
      const sarifPath = join(workspace.dir, "out.sarif");
      const markdownPath = join(workspace.dir, "out.md");

      const { io } = createCapturedIO();
      const code = await inspectCommand(
        [open, "--require-watertight", "--sarif", sarifPath, "--markdown", markdownPath, ...FRAME_ARGS],
        io,
      );
      const withoutOutputs = createCapturedIO();
      const codeWithoutOutputs = await inspectCommand(
        [open, "--require-watertight", ...FRAME_ARGS],
        withoutOutputs.io,
      );

      expect(code).toBe(EXIT_POLICY_FAILED);
      expect(code).toBe(codeWithoutOutputs);

      const sarif = readSarif(sarifPath);
      const results = sarif.runs[0]?.results ?? [];
      const watertightResult = results.find((r) => r.ruleId === "not-watertight");
      expect(watertightResult).toBeDefined();
      expect(watertightResult?.level).toBe("error");

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain("POLICY FAILED");
      expect(markdown).toMatch(/watertight/iu);
    });

    it("maps a --fail-on-degenerate failure to the degenerate-triangles rule", async () => {
      const workspace = createTestWorkspace();
      const degenerate = workspace.writeFile(
        "degenerate.stl",
        cubeStlWithDegenerateTriangle([0, 0, 0], [10, 10, 10]),
      );
      const sarifPath = join(workspace.dir, "out.sarif");
      const { io } = createCapturedIO();

      const code = await inspectCommand(
        [degenerate, "--fail-on-degenerate", "--sarif", sarifPath, ...FRAME_ARGS],
        io,
      );

      expect(code).toBe(EXIT_POLICY_FAILED);
      const sarif = readSarif(sarifPath);
      const results = sarif.runs[0]?.results ?? [];
      const degenerateResult = results.find((r) => r.ruleId === "degenerate-triangles");
      expect(degenerateResult).toBeDefined();
      expect(degenerateResult?.level).toBe("error");
    });

    it("records no findings for a clean model with no policy options (exact findings, not sampled)", async () => {
      const workspace = createTestWorkspace();
      const clean = workspace.writeFile("clean.stl", cubeStlAscii([0, 0, 0], [10, 10, 10]));
      const sarifPath = join(workspace.dir, "out.sarif");
      const markdownPath = join(workspace.dir, "out.md");
      const { io } = createCapturedIO();

      const code = await inspectCommand(
        [clean, "--sarif", sarifPath, "--markdown", markdownPath, ...FRAME_ARGS],
        io,
      );

      expect(code).toBe(EXIT_OK);
      const sarif = readSarif(sarifPath);
      expect(sarif.runs[0]?.results ?? []).toHaveLength(0);
      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain("informational only");
      expect(markdown).toMatch(/exact/iu);
    });

    it("produces byte-identical SARIF for identical inputs", async () => {
      const workspace = createTestWorkspace();
      const open = workspace.writeFile(
        "open.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10], { omitTop: true }),
      );
      const firstPath = join(workspace.dir, "first.sarif");
      const secondPath = join(workspace.dir, "second.sarif");

      await inspectCommand(
        [open, "--require-watertight", "--sarif", firstPath, ...FRAME_ARGS],
        createCapturedIO().io,
      );
      await inspectCommand(
        [open, "--require-watertight", "--sarif", secondPath, ...FRAME_ARGS],
        createCapturedIO().io,
      );

      expect(readFileSync(firstPath, "utf8")).toBe(readFileSync(secondPath, "utf8"));
    });
  });
});
