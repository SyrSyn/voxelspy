/**
 * `@voxelspy/analysis` must stay usable inside a browser bundle -- it is
 * consumed directly by browser Web Workers in `apps/web` (see
 * `AGENTS.md`'s "keep core analysis ... independent of ... browser-only
 * file types, hosting, identity, and persistence" and this package's own
 * README resource model). A single accidental `node:`-scheme import
 * anywhere in the built output would break every one of those bundles at
 * build time, so this is asserted directly against `dist/`, not inferred
 * from source review.
 *
 * This scans the actual built JavaScript (not `.d.ts`/`.d.ts.map`/source
 * files), the same artifact a consumer's bundler resolves through this
 * package's `exports` map. Like `test/consumer-entry.test.ts`, this relies
 * on the `pretest` script rebuilding `dist/` first, so the assertion is
 * always against current output.
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
    // Sanity check on the scan itself: fail loudly if the build didn't run,
    // rather than this test passing vacuously over zero files.
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
});
