/**
 * `@voxelspy/react` must stay usable inside a browser bundle -- both its
 * main entry point (consumed on the main thread) and its `./worker` entry
 * point (consumed inside a Web Worker) -- per `AGENTS.md`'s "keep browser
 * comparison ... independent of ... browser-only file types" spirit and
 * this package's own README. A single accidental `node:`-scheme import
 * anywhere in the built output would break a consumer's bundle at build
 * time, so this is asserted directly against `dist/`, mirroring
 * `packages/analysis/test/browser-safety.test.ts`.
 *
 * Relies on the `pretest` script rebuilding `dist/` first, so the assertion
 * is always against current output.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

async function jsFilesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return jsFilesBelow(path);
      return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
    }),
  );
  return files.flat();
}

describe("built output stays browser-safe", () => {
  it("contains no node: scheme import/require anywhere in dist/**/*.js", async () => {
    const files = await jsFilesBelow(distDirectory);
    expect(files.length).toBeGreaterThan(0);

    const offenders: { file: string; line: string }[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const line of contents.split("\n")) {
        if (/\bnode:[a-z/-]+/.test(line)) {
          offenders.push({ file, line: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps worker.js free of any reference to 'react'", async () => {
    const contents = await readFile(`${distDirectory}/worker.js`, "utf8");
    expect(contents).not.toMatch(/["']react["']/);
  });
});
