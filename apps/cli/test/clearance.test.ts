import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearanceCommand } from "../src/commands/clearance.js";
import {
  EXIT_INDETERMINATE,
  EXIT_OK,
  EXIT_POLICY_FAILED,
  EXIT_USAGE_ERROR,
} from "../src/exit-codes.js";
import { run } from "../src/run.js";
import {
  createCapturedIO,
  createTestWorkspace,
  cubeStlAscii,
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
    const first = workspace.writeFile(
      "first.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const second = workspace.writeFile(
      "second.stl",
      cubeStlAscii([100, 0, 0], [110, 10, 10]),
    );
    const { io, stdout } = createCapturedIO();

    const code = await clearanceCommand(
      [first, second, "--clearance", "1", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.startsWith("State: clear"))).toBe(true);
    expect(stdout.some((line) => line.includes("Sample spacing bound"))).toBe(
      true,
    );
  });

  it("reports state tight and fails by default, but passes with --allow-tight", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile(
      "first.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const second = workspace.writeFile(
      "second.stl",
      cubeStlAscii([10.5, 0, 0], [20.5, 10, 10]),
    );

    const { io: strictIo, stdout: strictOut } = createCapturedIO();
    const strictCode = await clearanceCommand(
      [first, second, "--clearance", "1", ...FRAME_ARGS],
      strictIo,
    );
    expect(strictCode).toBe(EXIT_POLICY_FAILED);
    expect(strictOut.some((line) => line.startsWith("State: tight"))).toBe(
      true,
    );

    const { io: lenientIo } = createCapturedIO();
    const lenientCode = await clearanceCommand(
      [first, second, "--clearance", "1", "--allow-tight", ...FRAME_ARGS],
      lenientIo,
    );
    expect(lenientCode).toBe(EXIT_OK);
  });

  it("reports state interfering with exact triangle-pair evidence", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile(
      "first.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const second = workspace.writeFile(
      "second.stl",
      cubeStlAscii([5, 0, 0], [15, 10, 10]),
    );
    const { io, stdout } = createCapturedIO();

    const code = await clearanceCommand(
      [first, second, "--clearance", "1", "--allow-tight", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_POLICY_FAILED);
    expect(stdout.some((line) => line.startsWith("State: interfering"))).toBe(
      true,
    );
    expect(
      stdout.some((line) =>
        /Interference: [1-9]\d* intersecting triangle pair/u.test(line),
      ),
    ).toBe(true);
  });

  it("emits deterministic JSON for identical inputs", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile(
      "first.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const second = workspace.writeFile(
      "second.stl",
      cubeStlAscii([10.5, 0, 0], [20.5, 10, 10]),
    );
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
    const first = workspace.writeFile(
      "first.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const second = workspace.writeFile(
      "second.stl",
      cubeStlAscii([100, 0, 0], [110, 10, 10]),
    );

    const { io, stdout } = createCapturedIO();
    const code = await clearanceCommand(
      [
        first,
        second,
        "--clearance",
        "1",
        "--max-work-units",
        "1",
        ...FRAME_ARGS,
      ],
      io,
    );
    expect(code).toBe(EXIT_INDETERMINATE);
    expect(stdout.some((line) => line.includes("INDETERMINATE"))).toBe(true);
  });

  it("fails closed with a specific reason when the source frame is unresolved", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile(
      "first.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const second = workspace.writeFile(
      "second.stl",
      cubeStlAscii([100, 0, 0], [110, 10, 10]),
    );
    const { io, stderr } = createCapturedIO();

    const code = await clearanceCommand(
      [first, second, "--clearance", "1"],
      io,
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("needs-input"))).toBe(true);
  });

  it("rejects a missing --clearance as a usage error", async () => {
    const workspace = createTestWorkspace();
    const first = workspace.writeFile(
      "first.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const second = workspace.writeFile(
      "second.stl",
      cubeStlAscii([100, 0, 0], [110, 10, 10]),
    );
    const { io, stderr } = createCapturedIO();

    const code = await run(["clearance", first, second, ...FRAME_ARGS], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("--clearance"))).toBe(true);
  });

  it("rejects missing positional arguments as a usage error", async () => {
    const { io, stderr } = createCapturedIO();
    const code = await run(["clearance", "--clearance", "1"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(
      stderr.some((line) => line.includes("requires two positional arguments")),
    ).toBe(true);
  });

  describe("--sarif and --markdown", () => {
    it("writes an error-level clearance-violation result for a tight state, without changing the exit code", async () => {
      const workspace = createTestWorkspace();
      const first = workspace.writeFile(
        "first.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const second = workspace.writeFile(
        "second.stl",
        cubeStlAscii([10.5, 0, 0], [20.5, 10, 10]),
      );
      const sarifPath = join(workspace.dir, "out.sarif");
      const markdownPath = join(workspace.dir, "out.md");

      const { io } = createCapturedIO();
      const code = await clearanceCommand(
        [
          first,
          second,
          "--clearance",
          "1",
          "--sarif",
          sarifPath,
          "--markdown",
          markdownPath,
          ...FRAME_ARGS,
        ],
        io,
      );
      const withoutOutputs = createCapturedIO();
      const codeWithoutOutputs = await clearanceCommand(
        [first, second, "--clearance", "1", ...FRAME_ARGS],
        withoutOutputs.io,
      );

      expect(code).toBe(EXIT_POLICY_FAILED);
      expect(code).toBe(codeWithoutOutputs);

      const sarif = readSarif(sarifPath);
      const results = sarif.runs[0]?.results ?? [];
      const violation = results.find((r) => r.ruleId === "clearance-violation");
      expect(violation).toBeDefined();
      expect(violation?.level).toBe("error");
      const approximate = results.find(
        (r) => r.ruleId === "approximate-result",
      );
      expect(approximate).toBeDefined();
      expect(approximate?.level).toBe("note");

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain("POLICY FAILED");
      expect(markdown).toMatch(/APPROXIMATE/u);
    });

    it("always records an approximate-result finding for a passing 'clear' state -- never a bare clean pass", async () => {
      const workspace = createTestWorkspace();
      const first = workspace.writeFile(
        "first.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const second = workspace.writeFile(
        "second.stl",
        cubeStlAscii([100, 0, 0], [110, 10, 10]),
      );
      const sarifPath = join(workspace.dir, "out.sarif");
      const { io } = createCapturedIO();

      const code = await clearanceCommand(
        [
          first,
          second,
          "--clearance",
          "1",
          "--sarif",
          sarifPath,
          ...FRAME_ARGS,
        ],
        io,
      );

      expect(code).toBe(EXIT_OK);
      const sarif = readSarif(sarifPath);
      const results = sarif.runs[0]?.results ?? [];
      const approximate = results.find(
        (r) => r.ruleId === "approximate-result",
      );
      expect(approximate).toBeDefined();
      expect(approximate?.level).toBe("note");
      expect(results.some((r) => r.ruleId === "clearance-violation")).toBe(
        false,
      );
    });

    it("maps an indeterminate outcome to an error-level indeterminate-analysis finding", async () => {
      const workspace = createTestWorkspace();
      const first = workspace.writeFile(
        "first.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const second = workspace.writeFile(
        "second.stl",
        cubeStlAscii([100, 0, 0], [110, 10, 10]),
      );
      const sarifPath = join(workspace.dir, "out.sarif");
      const { io } = createCapturedIO();

      const code = await clearanceCommand(
        [
          first,
          second,
          "--clearance",
          "1",
          "--max-work-units",
          "1",
          "--sarif",
          sarifPath,
          ...FRAME_ARGS,
        ],
        io,
      );

      expect(code).toBe(EXIT_INDETERMINATE);
      const sarif = readSarif(sarifPath);
      const results = sarif.runs[0]?.results ?? [];
      expect(results).toHaveLength(1);
      expect(results[0]?.ruleId).toBe("indeterminate-analysis");
      expect(results[0]?.level).toBe("error");
    });

    it("produces byte-identical SARIF for identical inputs", async () => {
      const workspace = createTestWorkspace();
      const first = workspace.writeFile(
        "first.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const second = workspace.writeFile(
        "second.stl",
        cubeStlAscii([10.5, 0, 0], [20.5, 10, 10]),
      );
      const firstPath = join(workspace.dir, "first.sarif");
      const secondPath = join(workspace.dir, "second.sarif");

      await clearanceCommand(
        [
          first,
          second,
          "--clearance",
          "1",
          "--sarif",
          firstPath,
          ...FRAME_ARGS,
        ],
        createCapturedIO().io,
      );
      await clearanceCommand(
        [
          first,
          second,
          "--clearance",
          "1",
          "--sarif",
          secondPath,
          ...FRAME_ARGS,
        ],
        createCapturedIO().io,
      );

      expect(readFileSync(firstPath, "utf8")).toBe(
        readFileSync(secondPath, "utf8"),
      );
    });
  });
});
