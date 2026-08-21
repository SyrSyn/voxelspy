import type { SourceAxis, SourceUnit } from "@voxelspy/contracts";
import {
  importerDescriptor,
  inferFormat,
  type SupportedFormat,
} from "@voxelspy/importers";

export type { SupportedFormat };
export { inferFormat };

export type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
export type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;
export type FrameSource = "default" | "expert";

/**
 * Single source of truth for "which model file formats does this build of
 * VoxelSpy accept", read directly from `@voxelspy/importers`'s own
 * `importerDescriptor.extensions` -- itself kept in lockstep with that
 * package's `SupportedFormat` union -- rather than restated as a second,
 * hand-maintained list in this app. Every tool's file-input `accept`
 * attribute, every "is this file supported" capability check, and every
 * "what does this release support" line of copy in this app reads from this
 * one module, so widening the importer automatically widens every tool
 * instead of leaving some still hard-coded to a stale format list -- the bug
 * voxelspy-ft9.6.13 exists to fix.
 */
export const ACCEPTED_UPLOAD_EXTENSIONS: readonly string[] =
  importerDescriptor.extensions;

/** `accept` attribute value for every `<input type="file">` that reads a
 *  model file in this app, e.g. `".stl,.obj,.gltf,.glb,.3mf"`. */
export const ACCEPTED_UPLOAD_ACCEPT = ACCEPTED_UPLOAD_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");

/** Human-readable label for the supported format subset, for tool copy and
 *  capability-preflight messages. Kept as one literal (rather than joining
 *  `ACCEPTED_UPLOAD_EXTENSIONS` into a sentence) so the wording reads
 *  naturally; update this alongside the importer's own supported-format list
 *  if it ever changes. */
export const ACCEPTED_FORMATS_LABEL = "STL, OBJ, glTF, GLB, or 3MF";

/** True when a file name's extension is one this importer accepts. Delegates
 *  to `inferFormat` -- the importer's own extension parser -- rather than a
 *  second regular expression that could drift from it. */
export function hasAcceptedExtension(fileName: string): boolean {
  return inferFormat(fileName) !== undefined;
}

/** Honest refusal message naming what IS supported, for a file whose
 *  extension `inferFormat` did not recognize. */
export function unsupportedFormatMessage(): string {
  return `This release supports ${ACCEPTED_FORMATS_LABEL} mesh files (${ACCEPTED_UPLOAD_EXTENSIONS.map(
    (extension) => `.${extension}`,
  ).join(", ")}).`;
}

/**
 * `inferFormat`, but throwing an honest, user-facing error naming the
 * supported subset instead of returning `undefined` -- for worker-client call
 * sites that need a `SupportedFormat` or a clear failure, not an `undefined`
 * to branch on separately. Every tool's own capability preflight already
 * refuses an unsupported file before a run can start; this is the same
 * refusal restated as a thrown error for the handful of call sites that build
 * a wire request directly from a `File`.
 */
export function requireSupportedFormat(fileName: string): SupportedFormat {
  const format = inferFormat(fileName);
  if (!format)
    throw new Error(
      `${fileName} is not a supported file. ${unsupportedFormatMessage()}`,
    );
  return format;
}

/**
 * True for formats whose own specification authoritatively declares a source
 * unit and/or up-axis -- glTF/GLB (always metres, right-handed Y-up per
 * spec) and 3MF (its own declared `<model unit="...">`, defaulting to
 * millimetre; always right-handed Z-up per the Core spec's coordinate-space
 * section) -- as opposed to STL/OBJ, which declare neither and require this
 * app to supply a default the user can override. See
 * `packages/importers/README.md`'s "glTF 2.0 / GLB inputs" and "3MF Core
 * inputs" sections. The interface must not present a "you must choose"
 * unit/axis control for a format that already answered the question, and
 * must not claim the user chose a value the file itself declared.
 */
export function formatDeclaresOwnFrame(
  format: SupportedFormat | undefined,
): boolean {
  return format === "gltf" || format === "glb" || format === "3mf";
}

/** The unit/axis a fresh selection of this format should start from: empty
 *  ("no explicit choice") for a format that declares its own frame, so the
 *  interface never implies a value the user did not pick -- only an explicit
 *  edit to the unit/axis control becomes a real override, sent as
 *  `userUnit`/`userAxis`. STL/OBJ keep this release's existing millimetre,
 *  right-handed Z-up starting point, since neither format declares one. */
export function defaultFrameForFormat(format: SupportedFormat | undefined): {
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
} {
  if (formatDeclaresOwnFrame(format)) return { unit: "", axis: "" };
  return { unit: "millimetre", axis: "right-handed-z-up" };
}

/** Plain-language description of what a format-declared frame guarantees,
 *  for the pre-import "Expert settings" panel. Deliberately does not claim a
 *  specific 3MF unit before import -- 3MF's unit is read from the file
 *  itself and can only be shown once import has resolved it (every tool's
 *  post-import provenance panel surfaces the detected/resolved value and its
 *  origin). */
export function formatFrameDeclarationSummary(
  format: SupportedFormat | undefined,
): string | undefined {
  if (format === "gltf" || format === "glb")
    return "glTF/GLB declares metres and right-handed Y-up by specification. Leave the fields below on “Use the file's declared value” unless this particular file's frame should be reinterpreted anyway.";
  if (format === "3mf")
    return "3MF declares its own unit (read from the file; millimetre if the file does not specify one) and right-handed Z-up by specification. Leave the fields below on “Use the file's declared value” unless this particular file's frame should be reinterpreted anyway.";
  return undefined;
}

/**
 * The single place every tool's spec-building code decides which import
 * option fields to send for one selected source, mirroring
 * `resolveFrame`/`userOrDeclaredSourceFrameOverride` in
 * `@voxelspy/importers`:
 *
 * - For a format that declares its own frame (glTF/GLB/3MF), `unit`/`axis`
 *   resolve independently: an empty value means "use the file's own
 *   declaration" (sends neither `declaredUnit` nor `userUnit` for that
 *   field, so `importModel` resolves it as `"embedded"`), and a non-empty
 *   value is an explicit user override, sent as `userUnit`/`userAxis` --
 *   never `declaredUnit`/`declaredAxis`, since for these formats *any*
 *   supplied `declaredUnit` registers as overriding an authoritative value
 *   and raises the importer's `user-source-frame` warning even when the
 *   supplied value happens to match the embedded one.
 * - For STL/OBJ (no embedded value), `frameSource` distinguishes this
 *   interface's own millimetre/right-handed-Z-up starting point (sent as
 *   `declaredUnit`/`declaredAxis`, `frameSource: "default"`) from an
 *   explicit user choice (sent as `userUnit`/`userAxis`,
 *   `frameSource: "expert"`) -- unchanged from this release's original
 *   behavior.
 */
export function resolveFrameOptions(
  format: SupportedFormat,
  frameSource: FrameSource,
  unit: ResolvedSourceUnit | "",
  axis: ResolvedSourceAxis | "",
): {
  declaredUnit?: ResolvedSourceUnit;
  declaredAxis?: ResolvedSourceAxis;
  userUnit?: ResolvedSourceUnit;
  userAxis?: ResolvedSourceAxis;
} {
  if (formatDeclaresOwnFrame(format)) {
    return {
      ...(unit ? { userUnit: unit } : {}),
      ...(axis ? { userAxis: axis } : {}),
    };
  }
  // STL/OBJ: `unit`/`axis` are always non-empty in practice (every source
  // selection for these formats starts from the millimetre/Z-up default),
  // but the type stays `| ""` to match every call site's shared selection
  // shape; an empty value here would mean an incomplete form the caller's
  // own capability preflight already refused to run.
  if (frameSource === "expert")
    return {
      ...(unit ? { userUnit: unit } : {}),
      ...(axis ? { userAxis: axis } : {}),
    };
  return {
    ...(unit ? { declaredUnit: unit } : {}),
    ...(axis ? { declaredAxis: axis } : {}),
  };
}
