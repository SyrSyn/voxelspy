export class UnsupportedInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
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
