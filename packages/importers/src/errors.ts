export class UnsupportedInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

/**
 * Thrown for a 3MF (OPC/ZIP) container that is structurally dangerous or
 * deliberately excluded for security reasons -- distinct from a merely
 * malformed container (`TypeError`, mapped to `invalid-input`) or a
 * resource-limit violation (`RangeError`, mapped to `resource-limit`).
 * Maps to the `"unsafe-archive"` `ImportFailureCode` (`@voxelspy/contracts`).
 * Covers: encrypted entries, unsupported compression methods, ZIP64
 * sentinels, streamed (data-descriptor) entries, multi-disk archives, path
 * traversal or otherwise unsafe entry names, duplicate entry names,
 * overlapping byte ranges, disagreement between an entry's local and
 * central-directory headers, and trailing bytes after the declared archive
 * end -- every one of these is a container-shape attack surface, not an
 * ordinary data error.
 */
export class UnsafeArchiveError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

/**
 * Thrown by `exportModel` for an unrecognized or unsupported
 * `ExportOptions.targetFormat`. Distinct from `ExportInputError` so a caller
 * (e.g. a format picker in a UI) can distinguish "you asked for a target
 * this package does not know how to write" from any other invalid input.
 */
export class ExportUnsupportedTargetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExportUnsupportedTargetError";
  }
}

/**
 * Thrown by `exportModel` for an invalid model (fails
 * `normalizedModelSchema`), an invalid `targetUnit`/`targetAxis`, or
 * geometry that leaves nothing to write (e.g. every mesh referenced by an
 * instance has zero triangles). A caller programming error or a malformed
 * model, not a data-driven resource limit -- mirrors
 * `packages/analysis/src/simplify.ts`'s `SimplifyInputError`.
 */
export class ExportInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExportInputError";
  }
}

/**
 * Thrown by `exportModel` when the flattened output (summed across every
 * placement instance, before any output bytes are allocated) would exceed
 * `EXPORTER_SAFETY_LIMITS`. Mirrors
 * `packages/analysis/src/simplify.ts`'s `SimplifyResourceLimitError`.
 */
export class ExportResourceLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExportResourceLimitError";
  }
}
