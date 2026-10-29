import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPORTER_SAFETY_LIMITS } from "@voxelspy/importers";
import { loadModel } from "../src/load-model.js";
import { cubeStlAscii } from "./fixtures.js";

const readObservation = vi.hoisted(() => ({
  calls: 0,
  bytes: 0,
  beforeRead: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readSync: (...args: Parameters<typeof original.readSync>) => {
      readObservation.calls += 1;
      readObservation.beforeRead?.();
      const count = original.readSync(...args);
      readObservation.bytes += count;
      return count;
    },
  };
});
const directories: string[] = [];
function fixture(name: string, content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "voxelspy-input-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}
const options = {
  unit: "millimetre",
  axis: "right-handed-z-up",
  maxInputBytes: undefined,
  maxTriangles: undefined,
} as const;
afterEach(() => {
  readObservation.calls = 0;
  readObservation.bytes = 0;
  readObservation.beforeRead = undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("bounded model input", () => {
  it("rejects an oversized sparse file without reading its contents", async () => {
    const path = fixture("oversized.stl", "");
    truncateSync(path, IMPORTER_SAFETY_LIMITS.inputBytes + 1);
    const result = await loadModel(path, "model.test", options, "Model");
    expect(result).toMatchObject({
      ok: false,
      result: { code: "resource-limit" },
    });
    expect(readObservation.calls).toBe(0);
  });

  it("enforces a caller's lower ceiling before reading", async () => {
    const path = fixture("small.stl", "12345");
    const result = await loadModel(
      path,
      "model.test",
      { ...options, maxInputBytes: 4 },
      "Model",
    );
    expect(result).toMatchObject({
      ok: false,
      result: { code: "resource-limit" },
    });
    expect(readObservation.calls).toBe(0);
  });

  it("caps reads at the ceiling plus one byte when the open file grows", async () => {
    const path = fixture("growing.stl", "tiny");
    readObservation.beforeRead = () => {
      readObservation.beforeRead = undefined;
      appendFileSync(path, new Uint8Array(100_000));
    };
    const result = await loadModel(
      path,
      "model.test",
      { ...options, maxInputBytes: 20 },
      "Model",
    );
    expect(result).toMatchObject({
      ok: false,
      result: { code: "resource-limit" },
    });
    expect(readObservation.bytes).toBe(21);
  });

  it("imports a valid file exactly at the configured ceiling", async () => {
    const content = cubeStlAscii([0, 0, 0], [1, 1, 1]);
    const path = fixture("valid.stl", content);
    const result = await loadModel(
      path,
      "model.test",
      { ...options, maxInputBytes: Buffer.byteLength(content) },
      "Model",
    );
    expect(result.ok).toBe(true);
    expect(readObservation.bytes).toBe(Buffer.byteLength(content));
  });

  it("names every accepted extension in an unsupported-format diagnostic", async () => {
    const path = fixture("unsupported.fbx", "");
    await expect(
      loadModel(path, "model.test", options, "Model"),
    ).rejects.toThrow("supported formats: stl, obj, gltf, glb, 3mf, step, stp");
    expect(readObservation.calls).toBe(0);
  });
});
