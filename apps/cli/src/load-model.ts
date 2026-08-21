import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ImportResult } from "@voxelspy/contracts";
import { IMPORTER_SAFETY_LIMITS, importModel, inferFormat } from "@voxelspy/importers";
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
  | { readonly ok: true; readonly path: string; readonly sourceName: string; readonly result: Extract<ImportResult, { ok: true }> }
  | { readonly ok: false; readonly path: string; readonly sourceName: string; readonly result: Extract<ImportResult, { ok: false }> | LocalResourceLimit };

/** Reads `path`, infers its format from the extension, and imports it into `targetModelId`. Never throws for an ordinary import failure -- only for a usage problem (unreadable file, unrecognized extension). */
export async function loadModel(
  path: string,
  targetModelId: string,
  options: LoadModelOptions,
  filePrefix: string,
): Promise<LoadModelResult> {
  const sourceName = basename(path);
  let bytes: Uint8Array;
  try {
    const buffer = readFileSync(path);
    // `readFileSync` can return a view into a pooled, larger ArrayBuffer.
    // The import contract requires the byte view to own one complete,
    // exactly-sized transferable ArrayBuffer, so always copy.
    bytes = Uint8Array.from(buffer);
  } catch (error) {
    throw new CliUsageError(
      `${filePrefix} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const format = inferFormat(sourceName);
  if (format === undefined) {
    throw new CliUsageError(
      `${filePrefix} "${path}" has an unrecognized extension; supported formats: stl, obj.`,
    );
  }

  const maxInputBytes = Math.min(
    options.maxInputBytes ?? IMPORTER_SAFETY_LIMITS.inputBytes,
    IMPORTER_SAFETY_LIMITS.inputBytes,
  );
  if (bytes.byteLength > maxInputBytes) {
    return {
      ok: false,
      path,
      sourceName,
      result: {
        ok: false,
        code: "resource-limit",
        message: `${filePrefix} "${path}" is ${bytes.byteLength} bytes, which exceeds the configured --max-input-bytes limit of ${maxInputBytes} bytes.`,
        warnings: [],
      },
    };
  }
  const maxTriangles = Math.min(
    options.maxTriangles ?? IMPORTER_SAFETY_LIMITS.triangleCount,
    IMPORTER_SAFETY_LIMITS.triangleCount,
  );

  const result = await importModel({
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
