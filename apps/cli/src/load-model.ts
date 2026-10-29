import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { importStepInWorker } from "./step-import.js";
import { basename } from "node:path";
import type { ImportResult } from "@voxelspy/contracts";
import {
  IMPORTER_SAFETY_LIMITS,
  importModel,
  inferFormat,
} from "@voxelspy/importers";
import { CliUsageError } from "./cli-error.js";
import type { ResolvedSourceAxis, ResolvedSourceUnit } from "./parsing.js";

/**
 * Every field is required (never `?:`) but its value type explicitly
 * includes `undefined`, so a caller with an unset CLI option can always pass
 * `undefined` here directly -- `exactOptionalPropertyTypes` only restricts
 * *optional* (`?:`) properties, not required ones typed as `T | undefined`.
 */
export interface LoadModelOptions {
  readonly unit: ResolvedSourceUnit | undefined;
  readonly axis: ResolvedSourceAxis | undefined;
  readonly maxInputBytes: number | undefined;
  readonly maxTriangles: number | undefined;
}

/**
 * A resource-limit refusal detected by the CLI itself, before handing the
 * request to `importModel` -- specifically, the file is larger than the
 * effective `--max-input-bytes` ceiling the caller configured (or the
 * package's own fixed `IMPORTER_SAFETY_LIMITS.inputBytes`, whichever is
 * smaller). Reported as its own code so it never reads as the generic
 * "Import request did not satisfy the public contract" message `importModel`
 * would otherwise produce for the same underlying cause.
 */
export interface LocalResourceLimit {
  readonly ok: false;
  readonly code: "resource-limit";
  readonly message: string;
  readonly warnings: readonly [];
}

export type LoadModelResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly sourceName: string;
      readonly result: Extract<ImportResult, { ok: true }>;
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly sourceName: string;
      readonly result:
        Extract<ImportResult, { ok: false }> | LocalResourceLimit;
    };

/** Reads `path`, infers its format from the extension, and imports it into `targetModelId`. Never throws for an ordinary import failure -- only for a usage problem (unreadable file, unrecognized extension). */
export async function loadModel(
  path: string,
  targetModelId: string,
  options: LoadModelOptions,
  filePrefix: string,
): Promise<LoadModelResult> {
  const sourceName = basename(path);
  const format = inferFormat(sourceName);
  if (format === undefined) {
    throw new CliUsageError(
      `${filePrefix} "${path}" has an unrecognized extension; supported formats: stl, obj, gltf, glb, 3mf, step, stp.`,
    );
  }

  const maxInputBytes = Math.min(
    options.maxInputBytes ?? IMPORTER_SAFETY_LIMITS.inputBytes,
    IMPORTER_SAFETY_LIMITS.inputBytes,
  );
  const resourceLimit = (byteLength: number): LoadModelResult => ({
    ok: false,
    path,
    sourceName,
    result: {
      ok: false,
      code: "resource-limit",
      message: `${filePrefix} "${path}" is at least ${byteLength} bytes, which exceeds the configured --max-input-bytes limit of ${maxInputBytes} bytes.`,
      warnings: [],
    },
  });

  let bytes: Uint8Array;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    // Check the opened file rather than a path that could be replaced between
    // stat and read. Never allocate or read an already oversized input.
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("Input must be a regular file.");
    }
    if (stat.size > maxInputBytes) return resourceLimit(stat.size);

    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    // A file can grow after fstat. Read at most the ceiling plus one sentinel
    // byte, so concurrent growth cannot bypass the allocation guard.
    while (byteLength <= maxInputBytes) {
      const chunk = new Uint8Array(
        Math.min(64 * 1024, maxInputBytes - byteLength + 1),
      );
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      byteLength += count;
      if (byteLength > maxInputBytes) return resourceLimit(byteLength);
      chunks.push(chunk.subarray(0, count));
    }
    // Own one exact-size transferable ArrayBuffer, never a pooled or partial
    // view. Assembly is also bounded by the effective input ceiling.
    bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (error) {
    throw new CliUsageError(
      `${filePrefix} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const maxTriangles = Math.min(
    options.maxTriangles ?? IMPORTER_SAFETY_LIMITS.triangleCount,
    IMPORTER_SAFETY_LIMITS.triangleCount,
  );

  const result = await (format === "step" ? importStepInWorker : importModel)({
    contractVersion: 1,
    targetModelId,
    format,
    sourceName,
    bytes,
    options: {
      ...(options.unit === undefined ? {} : { userUnit: options.unit }),
      ...(options.axis === undefined ? {} : { userAxis: options.axis }),
      limits: {
        inputBytes: maxInputBytes,
        triangleCount: maxTriangles,
      },
    },
  });

  if (result.ok) return { ok: true, path, sourceName, result };
  return { ok: false, path, sourceName, result };
}
