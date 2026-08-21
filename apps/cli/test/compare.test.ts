import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareCommand } from "../src/commands/compare.js";
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
  cubeObj,
  cubeStlAscii,
} from "./fixtures.js";

function readFigure(path: string): string {
  return readFileSync(path, "utf8");
}

interface SarifLog {
  readonly version: string;
  readonly runs: readonly {
    readonly results: readonly {
      readonly ruleId: string;
      readonly level: string;
      readonly message: { readonly text: string };
    }[];
  }[];
}

function readSarif(path: string): SarifLog {
  return JSON.parse(readFileSync(path, "utf8")) as SarifLog;
}

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
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("informational only"))).toBe(
      true,
    );
    expect(stdout.some((line) => line.includes("Sample spacing bound"))).toBe(
      true,
    );
  });

  it("compares an OBJ baseline against an STL candidate", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile(
      "baseline.obj",
      cubeObj([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("informational only"))).toBe(
      true,
    );
  });

  it("passes --max-deviation when the true maximum distance is within bounds", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 12]),
    );
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [
        baseline,
        candidate,
        "--tolerance",
        "0.01",
        "--max-deviation",
        "5",
        ...FRAME_ARGS,
      ],
      io,
    );

    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("Policy result: PASSED"))).toBe(
      true,
    );
  });

  it("fails --max-deviation when the true maximum distance exceeds the bound", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 12]),
    );
    const { io, stdout } = createCapturedIO();

    const code = await compareCommand(
      [
        baseline,
        candidate,
        "--tolerance",
        "0.01",
        "--max-deviation",
        "1",
        ...FRAME_ARGS,
      ],
      io,
    );

    expect(code).toBe(EXIT_POLICY_FAILED);
    expect(stdout.some((line) => line.includes("Policy result: FAILED"))).toBe(
      true,
    );
    expect(
      stdout.some((line) => /\[FAIL\] maximum deviation/u.test(line)),
    ).toBe(true);
  });

  it("evaluates --fail-on-regions against the true detected region count", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 12]),
    );
    const { io: passIo } = createCapturedIO();
    const passCode = await compareCommand(
      [
        baseline,
        candidate,
        "--tolerance",
        "0.01",
        "--fail-on-regions",
        "10",
        ...FRAME_ARGS,
      ],
      passIo,
    );
    expect(passCode).toBe(EXIT_OK);

    const { io: failIo } = createCapturedIO();
    const failCode = await compareCommand(
      [
        baseline,
        candidate,
        "--tolerance",
        "0.01",
        "--fail-on-regions",
        "0",
        ...FRAME_ARGS,
      ],
      failIo,
    );
    expect(failCode).toBe(EXIT_POLICY_FAILED);
  });

  it("evaluates --require-watertight against both mesh assessments", async () => {
    const workspace = createTestWorkspace();
    const closedA = workspace.writeFile(
      "closed-a.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const closedB = workspace.writeFile(
      "closed-b.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const open = workspace.writeFile(
      "open.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10], { omitTop: true }),
    );

    const { io: passIo } = createCapturedIO();
    const passCode = await compareCommand(
      [
        closedA,
        closedB,
        "--tolerance",
        "0.01",
        "--require-watertight",
        ...FRAME_ARGS,
      ],
      passIo,
    );
    expect(passCode).toBe(EXIT_OK);

    const { io: failIo } = createCapturedIO();
    const failCode = await compareCommand(
      [
        closedA,
        open,
        "--tolerance",
        "0.01",
        "--require-watertight",
        ...FRAME_ARGS,
      ],
      failIo,
    );
    expect(failCode).toBe(EXIT_POLICY_FAILED);
  });

  it("emits deterministic JSON for identical inputs", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 12]),
    );
    const args = [
      baseline,
      candidate,
      "--tolerance",
      "0.01",
      "--json",
      ...FRAME_ARGS,
    ];

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
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 12]),
    );

    const { io: defaultIo, stdout: defaultOut } = createCapturedIO();
    const defaultCode = await compareCommand(
      [
        baseline,
        candidate,
        "--tolerance",
        "0.01",
        "--max-work-units",
        "1",
        ...FRAME_ARGS,
      ],
      defaultIo,
    );
    expect(defaultCode).toBe(EXIT_INDETERMINATE);
    expect(defaultOut.some((line) => line.includes("INDETERMINATE"))).toBe(
      true,
    );

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
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const { io, stderr } = createCapturedIO();

    const code = await compareCommand(
      [baseline, candidate, "--tolerance", "0.01"],
      io,
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("needs-input"))).toBe(true);
  });

  it("fails closed with a specific reason for an unrecognized format", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile("baseline.txt", "not a model");
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const { io, stderr } = createCapturedIO();

    const code = await run(
      ["compare", baseline, candidate, "--tolerance", "0.01", ...FRAME_ARGS],
      io,
    );

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("unrecognized extension"))).toBe(
      true,
    );
  });

  it("rejects missing positional arguments as a usage error", async () => {
    const { io, stderr } = createCapturedIO();
    const code = await run(["compare", "--tolerance", "0.01"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(
      stderr.some((line) => line.includes("requires two positional arguments")),
    ).toBe(true);
  });

  it("rejects a missing --tolerance as a usage error", async () => {
    const workspace = createTestWorkspace();
    const baseline = workspace.writeFile(
      "baseline.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
    const candidate = workspace.writeFile(
      "candidate.stl",
      cubeStlAscii([0, 0, 0], [10, 10, 10]),
    );
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

  describe("--sarif and --markdown", () => {
    it("writes an error-level SARIF result for a failing --max-deviation check, without changing the exit code", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const sarifPath = join(workspace.dir, "out.sarif");
      const markdownPath = join(workspace.dir, "out.md");
      const { io } = createCapturedIO();
      const withoutOutputs = createCapturedIO();

      const code = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--max-deviation",
          "1",
          "--sarif",
          sarifPath,
          "--markdown",
          markdownPath,
          ...FRAME_ARGS,
        ],
        io,
      );
      const codeWithoutOutputs = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--max-deviation",
          "1",
          ...FRAME_ARGS,
        ],
        withoutOutputs.io,
      );

      expect(code).toBe(EXIT_POLICY_FAILED);
      expect(code).toBe(codeWithoutOutputs);

      const sarif = readSarif(sarifPath);
      expect(sarif.version).toBe("2.1.0");
      const results = sarif.runs[0]?.results ?? [];
      const deviationResult = results.find(
        (r) => r.ruleId === "deviation-exceeds-threshold",
      );
      expect(deviationResult).toBeDefined();
      expect(deviationResult?.level).toBe("error");

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain("POLICY FAILED");
      expect(markdown).toMatch(/maximum deviation/u);
    });

    it("always records an approximate-result finding -- an undersampled pass is never recorded as bare 'clean'", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const sarifPath = join(workspace.dir, "out.sarif");
      const markdownPath = join(workspace.dir, "out.md");
      const { io } = createCapturedIO();

      // No policy options: this run exits 0 unconditionally. A very tight
      // tolerance relative to the fixture's 10mm triangles guarantees the
      // sample-spacing bound exceeds it (undersampled), so the "no findings
      // at all" case never applies here.
      const code = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.0001",
          "--sarif",
          sarifPath,
          "--markdown",
          markdownPath,
          ...FRAME_ARGS,
        ],
        io,
      );
      expect(code).toBe(EXIT_OK);

      const sarif = readSarif(sarifPath);
      const results = sarif.runs[0]?.results ?? [];
      expect(results.length).toBeGreaterThan(0);
      const approximate = results.find(
        (r) => r.ruleId === "approximate-result",
      );
      expect(approximate).toBeDefined();
      expect(approximate?.level).toBe("note");
      const undersampled = results.find(
        (r) => r.ruleId === "undersampled-region",
      );
      expect(undersampled).toBeDefined();
      expect(undersampled?.level).toBe("warning");

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toMatch(/APPROXIMATE/u);
      expect(markdown).toMatch(/UNDERSAMPLED/u);
    });

    it("maps an indeterminate outcome to an error-level indeterminate-analysis finding, independent of --fail-on-indeterminate", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );

      for (const failOnIndeterminate of [false, true]) {
        const sarifPath = join(
          workspace.dir,
          `indeterminate-${String(failOnIndeterminate)}.sarif`,
        );
        const { io } = createCapturedIO();
        const args = [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--max-work-units",
          "1",
          "--sarif",
          sarifPath,
          ...FRAME_ARGS,
        ];
        if (failOnIndeterminate) args.push("--fail-on-indeterminate");

        const code = await compareCommand(args, io);
        expect(code).toBe(
          failOnIndeterminate ? EXIT_POLICY_FAILED : EXIT_INDETERMINATE,
        );

        const sarif = readSarif(sarifPath);
        const results = sarif.runs[0]?.results ?? [];
        expect(results).toHaveLength(1);
        expect(results[0]?.ruleId).toBe("indeterminate-analysis");
        expect(results[0]?.level).toBe("error");
      }
    });

    it("produces byte-identical SARIF and Markdown output for identical inputs", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const args = (sarifPath: string, markdownPath: string) => [
        baseline,
        candidate,
        "--tolerance",
        "0.01",
        "--max-deviation",
        "1",
        "--sarif",
        sarifPath,
        "--markdown",
        markdownPath,
        ...FRAME_ARGS,
      ];

      const firstSarif = join(workspace.dir, "first.sarif");
      const firstMarkdown = join(workspace.dir, "first.md");
      await compareCommand(
        args(firstSarif, firstMarkdown),
        createCapturedIO().io,
      );

      const secondSarif = join(workspace.dir, "second.sarif");
      const secondMarkdown = join(workspace.dir, "second.md");
      await compareCommand(
        args(secondSarif, secondMarkdown),
        createCapturedIO().io,
      );

      expect(readFileSync(firstSarif, "utf8")).toBe(
        readFileSync(secondSarif, "utf8"),
      );
      expect(readFileSync(firstMarkdown, "utf8")).toBe(
        readFileSync(secondMarkdown, "utf8"),
      );
    });

    it("still writes SARIF/Markdown and exits non-zero for a --require-watertight failure", async () => {
      const workspace = createTestWorkspace();
      const closed = workspace.writeFile(
        "closed.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const open = workspace.writeFile(
        "open.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10], { omitTop: true }),
      );
      const sarifPath = join(workspace.dir, "watertight.sarif");
      const { io } = createCapturedIO();

      const code = await compareCommand(
        [
          closed,
          open,
          "--tolerance",
          "0.01",
          "--require-watertight",
          "--sarif",
          sarifPath,
          ...FRAME_ARGS,
        ],
        io,
      );

      expect(code).toBe(EXIT_POLICY_FAILED);
      const sarif = readSarif(sarifPath);
      const results = sarif.runs[0]?.results ?? [];
      const watertightResult = results.find(
        (r) => r.ruleId === "not-watertight",
      );
      expect(watertightResult).toBeDefined();
      expect(watertightResult?.level).toBe("error");
    });
  });

  describe("--figure", () => {
    it("writes a valid SVG figure with real changed-region geometry, without changing the exit code", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const figurePath = join(workspace.dir, "out.svg");
      const { io } = createCapturedIO();
      const withoutFigure = createCapturedIO();

      const code = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--figure",
          figurePath,
          ...FRAME_ARGS,
        ],
        io,
      );
      const codeWithoutFigure = await compareCommand(
        [baseline, candidate, "--tolerance", "0.01", ...FRAME_ARGS],
        withoutFigure.io,
      );

      expect(code).toBe(EXIT_OK);
      expect(code).toBe(codeWithoutFigure);

      const svg = readFigure(figurePath);
      expect(svg).toContain("<svg");
      expect(svg).toContain("viewBox=");
      expect(svg).toContain("<title>");
      expect(svg).toContain("<desc>");
      expect(svg).toContain(">Legend<");
      expect(svg).toMatch(/Added \(present in candidate only/u);
      expect(svg).toMatch(/Removed \(present in baseline only/u);
      // The height change produces at least one real changed region drawn
      // from resolved triangle geometry (not merely a bounds-only box).
      expect(svg).toContain('data-region-shape="triangle"');
    });

    it("does not change the exit code on a policy failure", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const figurePath = join(workspace.dir, "failing.svg");
      const { io } = createCapturedIO();

      const code = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--max-deviation",
          "1",
          "--figure",
          figurePath,
          ...FRAME_ARGS,
        ],
        io,
      );

      expect(code).toBe(EXIT_POLICY_FAILED);
      expect(readFigure(figurePath)).toContain("POLICY FAILED");
    });

    it("still produces a valid figure that states there are no changed regions, for identical cubes", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const figurePath = join(workspace.dir, "no-changes.svg");
      const { io } = createCapturedIO();

      const code = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--figure",
          figurePath,
          ...FRAME_ARGS,
        ],
        io,
      );

      expect(code).toBe(EXIT_OK);
      const svg = readFigure(figurePath);
      expect(svg).toContain("<svg");
      expect(svg).toContain(
        "No changed regions were detected within tolerance.",
      );
    });

    it("still writes a valid figure and does not change the exit code for an indeterminate (work-budget-exhausted) run, honestly falling back when the same tiny budget also blocks the figure's own geometry lookup", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const figurePath = join(workspace.dir, "indeterminate.svg");
      const { io } = createCapturedIO();
      const withoutFigure = createCapturedIO();

      // --max-work-units 1 is deliberately far too small for
      // analyzeModelPair to complete (indeterminate) -- and, since --figure
      // reuses the same caller-supplied execution budget for its own
      // flatten/locate work (this CLI never grants --figure a looser
      // ceiling than the caller configured), it is too small for the figure
      // step too. The figure step must fail closed to its own
      // "unavailable" SVG rather than crash the process or change the exit
      // code either way.
      const code = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--max-work-units",
          "1",
          "--figure",
          figurePath,
          ...FRAME_ARGS,
        ],
        io,
      );
      const codeWithoutFigure = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--max-work-units",
          "1",
          ...FRAME_ARGS,
        ],
        withoutFigure.io,
      );

      expect(code).toBe(EXIT_INDETERMINATE);
      expect(code).toBe(codeWithoutFigure);
      const svg = readFigure(figurePath);
      expect(svg).toContain("<svg");
      expect(svg).toContain("<title>Comparison figure unavailable</title>");
      expect(svg).toMatch(
        /does not affect the comparison&apos;s own result or exit code/u,
      );
    });

    it("draws real baseline/candidate bounding boxes for an indeterminate outcome that still permits the figure's own bounded geometry lookup", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const figurePath = join(workspace.dir, "indeterminate-with-figure.svg");
      const { io } = createCapturedIO();

      // A work budget too small for the full surface-distance analysis
      // (which scans every candidate/baseline triangle against a spatial
      // index of the other) but ample for the figure step's own much
      // cheaper flatten-only locator lookups.
      const code = await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--max-work-units",
          "200",
          "--figure",
          figurePath,
          ...FRAME_ARGS,
        ],
        io,
      );

      expect(code).toBe(EXIT_INDETERMINATE);
      const svg = readFigure(figurePath);
      expect(svg).toContain("Verdict: INDETERMINATE");
      expect(svg).toContain(
        "No changed regions were detected within tolerance.",
      );
    });

    it("produces byte-identical figures for identical inputs", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const firstPath = join(workspace.dir, "first.svg");
      const secondPath = join(workspace.dir, "second.svg");

      await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--figure",
          firstPath,
          ...FRAME_ARGS,
        ],
        createCapturedIO().io,
      );
      await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--figure",
          secondPath,
          ...FRAME_ARGS,
        ],
        createCapturedIO().io,
      );

      expect(readFigure(firstPath)).toBe(readFigure(secondPath));
    });

    it("references the figure from the Markdown summary", async () => {
      const workspace = createTestWorkspace();
      const baseline = workspace.writeFile(
        "baseline.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 10]),
      );
      const candidate = workspace.writeFile(
        "candidate.stl",
        cubeStlAscii([0, 0, 0], [10, 10, 12]),
      );
      const figurePath = join(workspace.dir, "referenced.svg");
      const markdownPath = join(workspace.dir, "referenced.md");

      await compareCommand(
        [
          baseline,
          candidate,
          "--tolerance",
          "0.01",
          "--figure",
          figurePath,
          "--markdown",
          markdownPath,
          ...FRAME_ARGS,
        ],
        createCapturedIO().io,
      );

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain(`![Comparison figure](${figurePath})`);
    });
  });
});
