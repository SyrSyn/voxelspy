import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE_ERROR } from "../src/exit-codes.js";
import { run } from "../src/run.js";
import { createCapturedIO } from "./fixtures.js";

describe("run", () => {
  it("prints top-level help and exits 0 for --help", async () => {
    const { io, stdout } = createCapturedIO();
    const code = await run(["--help"], io);
    expect(code).toBe(EXIT_OK);
    expect(stdout.some((line) => line.includes("Usage: voxelspy"))).toBe(true);
  });

  it("exits with a usage error and prints help for a missing command", async () => {
    const { io, stdout, stderr } = createCapturedIO();
    const code = await run([], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes("Missing command"))).toBe(true);
    expect(stdout.some((line) => line.includes("Usage: voxelspy"))).toBe(true);
  });

  it("exits with a usage error for an unknown command", async () => {
    const { io, stderr } = createCapturedIO();
    const code = await run(["frobnicate"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.some((line) => line.includes('Unknown command "frobnicate"'))).toBe(true);
  });
});
