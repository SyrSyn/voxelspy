import { MAX_SIMPLIFY_INPUT_TRIANGLES } from "@voxelspy/analysis";
import type {
  DirectionalDeviation,
  SimplificationCertification,
  SimplifyTarget,
} from "@voxelspy/analysis";
import { IMPORTER_SAFETY_LIMITS } from "@voxelspy/importers";
import type { ExportFormat } from "@voxelspy/importers";
import { useEffect, useRef, useState } from "react";
import {
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import {
  ConvertSessionCancelledError,
  openConvertSession,
  type ConvertExportOutcome,
  type ConvertSession,
  type ConvertSimplifyOutcome,
  type ConvertSource,
  type ResolvedSourceAxis,
  type ResolvedSourceUnit,
} from "./convert-worker-client";
import { ToolShell } from "./ToolShell";
import { DEFAULT_ANALYSIS_MEMORY_MIB } from "./worker-client";

/**
 * `/tools/convert/`: loads one local model, offers optional simplification
 * (`simplifyModel`, `@voxelspy/analysis`) and export (`exportModel`,
 * `@voxelspy/importers`) as two composable steps against it, entirely in a
 * dedicated worker.
 *
 * **The certified claim is the headline.** Simplification's own point is not
 * decimation (a commodity) but the measured, honestly-qualified bound on how
 * far the result deviates from the input -- see `simplifyModel`'s doc
 * comment. This page never shows a bare "reduced by X%" without the measured
 * maximum deviation and `certification.disclaimer` right next to it, and
 * never hides a `targetReached: false` partial result -- see
 * `SimplifyHeadline`/`CertificationDisclaimer` below.
 *
 * **Export honesty.** Neither STL nor OBJ can declare a unit or axis inside
 * the file (`exportModel`'s `export.unit-not-declared` warning, always
 * present); this page states that plainly next to the export report, along
 * with the exact unit/axis a re-import must declare to recover this
 * geometry, and surfaces flattening, degenerate-normal, and precision
 * warnings rather than only a download link.
 *
 * **No 3D view.** Unlike Inspect, Printability, or Measure & Section, this
 * tool draws no viewport: simplification and export are both reported as
 * text (counts, certification, warnings), and neither imported model's
 * typed-array geometry ever leaves `convert.worker.ts` -- see
 * `convert-worker-client.ts`'s module doc comment. The textual report is the
 * deliverable.
 *
 * **Worker choice.** A dedicated session worker (`convert.worker.ts`,
 * opened by `openConvertSession`), shaped like `measure-worker-client.ts`'s
 * small persistent session rather than `inspect.worker.ts`'s
 * spin-up-per-call pattern: one model is imported once, then any number of
 * `simplify`/`export` calls can run against it (and a later `export` can
 * select either the original load or the most recent simplification)
 * without re-parsing the source file.
 */

// ---------------------------------------------------------------------------
// Source selection. Deliberately duplicated from ForensicsFlow.tsx/
// InspectFlow.tsx rather than imported -- see ForensicsFlow.tsx's own note
// on why each tool keeps its own copy of this small, pure, file-picker
// precondition logic.
// ---------------------------------------------------------------------------

const units: { value: ResolvedSourceUnit; label: string }[] = [
  { value: "millimetre", label: "Millimetres" },
  { value: "centimetre", label: "Centimetres" },
  { value: "metre", label: "Metres" },
  { value: "micrometre", label: "Micrometres" },
  { value: "inch", label: "Inches" },
  { value: "foot", label: "Feet" },
];
const axes: { value: ResolvedSourceAxis; label: string }[] = [
  { value: "right-handed-z-up", label: "Right-handed, Z up" },
  { value: "right-handed-y-up", label: "Right-handed, Y up" },
];
const exportFormats: { value: ExportFormat; label: string }[] = [
  { value: "stl-binary", label: "Binary STL" },
  { value: "stl-ascii", label: "ASCII STL" },
  { value: "obj", label: "OBJ" },
];

type ModelSourceSelection = {
  file: File | null;
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
  frameSource: "default" | "expert";
};

const defaultSourceFrame = {
  unit: "millimetre",
  axis: "right-handed-z-up",
  frameSource: "default",
} as const satisfies Pick<
  ModelSourceSelection,
  "unit" | "axis" | "frameSource"
>;

export function modelSourceSelectionForFile(
  file: File | null,
): ModelSourceSelection {
  return { file, ...defaultSourceFrame };
}

/** Same preconditions as Inspect's/Forensics'/Compare's own `*Capability`
 *  checks (this release's one importer applies uniformly), phrased for a
 *  conversion session rather than a measurement report. */
export function modelSourceCapability(selection: ModelSourceSelection) {
  if (!selection.file)
    return { ready: false, message: "Choose a local STL or OBJ file." };
  if (!/\.(?:stl|obj)$/iu.test(selection.file.name))
    return {
      ready: false,
      message: "This release supports STL and OBJ mesh files.",
    };
  if (selection.file.size === 0)
    return { ready: false, message: "The selected file is empty." };
  if (selection.file.size > IMPORTER_SAFETY_LIMITS.inputBytes)
    return {
      ready: false,
      message: "The selected file exceeds the 32 MiB importer safety ceiling.",
    };
  if (!selection.unit || !selection.axis)
    return {
      ready: false,
      message:
        "Choose the source unit and up-axis; this format does not declare them authoritatively.",
    };
  return {
    ready: true,
    message:
      selection.frameSource === "default"
        ? "Ready to load locally using millimetres and right-handed Z-up."
        : "Ready to load locally using the selected expert source frame.",
  };
}

function ModelSourceCard({
  selection,
  update,
  disabled,
}: {
  selection: ModelSourceSelection;
  update: (selection: ModelSourceSelection) => void;
  disabled: boolean;
}) {
  const capability = modelSourceCapability(selection);
  return (
    <fieldset className="source-card" disabled={disabled}>
      <legend>Model</legend>
      <label className="source-file" htmlFor="model-file">
        <span>{selection.file?.name ?? "Choose a model"}</span>
        <small>
          {selection.file
            ? `${(selection.file.size / 1024).toFixed(1)} KiB · local file`
            : "STL or OBJ, up to 32 MiB"}
        </small>
        <input
          id="model-file"
          type="file"
          accept=".stl,.obj"
          onChange={(event) =>
            update(
              modelSourceSelectionForFile(
                event.currentTarget.files?.[0] ?? null,
              ),
            )
          }
        />
        <span className="button button-secondary" aria-hidden="true">
          Browse this device
        </span>
      </label>
      <details>
        <summary>Expert settings</summary>
        <p>
          Change these only when the source uses a different unit or up-axis.
          This affects the applied source-to-model transform, not just how the
          model looks.
        </p>
        <div className="source-frame">
          <label>
            Source unit
            <select
              value={selection.unit}
              onChange={(event) =>
                update({
                  ...selection,
                  unit: event.currentTarget
                    .value as ModelSourceSelection["unit"],
                  frameSource: "expert",
                })
              }
            >
              {units.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source up-axis
            <select
              value={selection.axis}
              onChange={(event) =>
                update({
                  ...selection,
                  axis: event.currentTarget
                    .value as ModelSourceSelection["axis"],
                  frameSource: "expert",
                })
              }
            >
              {axes.map((axis) => (
                <option key={axis.value} value={axis.value}>
                  {axis.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
      <p
        className={
          capability.ready ? "capability capability-ready" : "capability"
        }
      >
        <i />
        {capability.message}
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** Sub-millimetre certification figures need more headroom than the 6
 *  fraction digits other tools' generic `formatNumber` uses -- a simplified
 *  model can legitimately measure a maximum deviation of a few thousandths
 *  of a millimetre, which 6 digits would still show, but this keeps the
 *  convention self-documenting for this tool's own numbers. */
function formatMillimetres(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value)} mm`;
}

function formatPercent(ratio: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(ratio);
}

/** Matrix and other exact numeric fields: up to 6 fraction digits, matching
 *  Forensics' own convention for the same kind of value. */
function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(value);
}

/**
 * Structural shape both `ContractWarning` (`@voxelspy/contracts`, used by
 * `ConvertLoadOutcome.warnings` and `ConvertExportOutcome.warnings`) and
 * `SimplifyWarning` (`@voxelspy/analysis`, used by
 * `ConvertSimplifyOutcome.warnings`) already satisfy -- so `WarningsList`
 * renders either without a conversion step, and without widening either
 * engine's own warning type into the other's (`SimplifyWarning.severity` has
 * no `"error"`; `ContractWarning.code` is branded and its `details` values
 * are JSON, not just numbers -- this type only requires what rendering
 * actually reads from both).
 */
interface DisplayWarning {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

function severityLabel(severity: DisplayWarning["severity"]): string {
  if (severity === "error") return "Error";
  return severity === "warning" ? "Warning" : "Info";
}

function detailValueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function WarningsList({ warnings }: { warnings: readonly DisplayWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="provenance-warnings">
      <strong>Warnings</strong>
      <ul>
        {warnings.map((warning, index) => (
          <li key={index}>
            <span
              className={
                warning.severity === "error" ? "severity-error" : undefined
              }
            >
              {severityLabel(warning.severity)}
            </span>{" "}
            <code>{warning.code}</code> — {warning.message}
            {warning.details && (
              <ul>
                {Object.entries(warning.details).map(([key, value]) => (
                  <li key={key}>
                    {key}: {detailValueText(value)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simplification: target form, pure resolution, and report
// ---------------------------------------------------------------------------

type SimplifyMode = "skip" | "triangle-count" | "reduction-ratio";

interface SimplifyForm {
  readonly mode: SimplifyMode;
  readonly triangleCountText: string;
  readonly reductionPercentText: string;
  readonly collapseBoundaryEdges: boolean;
}

const initialSimplifyForm: SimplifyForm = {
  mode: "skip",
  triangleCountText: "",
  reductionPercentText: "50",
  collapseBoundaryEdges: false,
};

/**
 * Pure resolution from the simplify form's text inputs to a `SimplifyTarget`
 * (or a plain-language reason it cannot be built yet), checked against
 * `originalTriangleCount` (this session's loaded, placed triangle count --
 * exactly what `simplifyModel` itself validates a `triangle-count` target
 * against, see `convert-worker-client.ts`'s `PlacedGeometryCounts` doc
 * comment) so an invalid target is caught before the worker call rather than
 * surfaced only as a worker error.
 */
export function resolveSimplifyTarget(
  form: SimplifyForm,
  originalTriangleCount: number,
): { target: SimplifyTarget } | { error: string } {
  if (form.mode === "triangle-count") {
    const value = Number(form.triangleCountText);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      return { error: "Enter a positive whole target triangle count." };
    }
    if (value >= originalTriangleCount) {
      return {
        error: `The target (${value}) must be smaller than the loaded model's ${originalTriangleCount} triangles.`,
      };
    }
    return { target: { kind: "triangle-count", triangleCount: value } };
  }
  if (form.mode === "reduction-ratio") {
    const percent = Number(form.reductionPercentText);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
      return {
        error: "Enter a reduction percentage strictly between 0 and 100.",
      };
    }
    return {
      target: { kind: "reduction-ratio", reductionRatio: percent / 100 },
    };
  }
  return { error: "Choose a simplification target, or skip simplification." };
}

/**
 * True when the certified sample-spacing bound is large enough, relative to
 * what was actually measured, to call out as its own caveat rather than
 * leave folded into the general disclaimer -- see `simplifyModel`'s
 * `CERTIFICATION_DISCLAIMER`: a genuine deviation smaller than this bound,
 * confined to one triangle's interior, could be missed. The bound meeting or
 * exceeding the measured maximum is the concrete case where "a same-size or
 * larger undetected deviation is plausible" stops being a background caveat
 * and becomes something the measured number itself cannot rule out.
 */
export function spacingBoundIsLargeRelativeToMax(
  certification: Pick<
    SimplificationCertification,
    "sampleSpacingUpperBoundMillimetres" | "maximumDistanceMillimetres"
  >,
): boolean {
  return (
    certification.sampleSpacingUpperBoundMillimetres >=
    certification.maximumDistanceMillimetres
  );
}

function SimplifyHeadline({ outcome }: { outcome: ConvertSimplifyOutcome }) {
  const { reduction, certification } = outcome;
  const reached = reduction.targetReached;
  return (
    <div
      className={
        reached
          ? "watertight-badge watertight-closed"
          : "watertight-badge watertight-not-closed"
      }
    >
      <i aria-hidden="true" />
      <p>
        <strong>
          {formatPercent(reduction.triangleReductionRatio)} fewer triangles ·{" "}
          {formatMillimetres(certification.maximumDistanceMillimetres)} maximum
          measured deviation
        </strong>
        <span>
          {reached
            ? `Target reached: ${formatCount(outcome.simplified.triangleCount)} of the original ${formatCount(outcome.original.triangleCount)} triangles remain.`
            : `Target not fully reached: ${formatCount(outcome.simplified.triangleCount)} triangles remain (requested ${formatCount(outcome.parameters.effectiveTargetTriangleCount)}) -- see the warning below for why.`}
        </span>
      </p>
    </div>
  );
}

function CertificationDisclaimer({
  certification,
}: {
  certification: SimplificationCertification;
}) {
  const spacingCaveat = spacingBoundIsLargeRelativeToMax(certification);
  return (
    <>
      <div className="convert-disclaimer">
        <strong>
          This is a sampled, approximate measurement, not a guaranteed maximum.
        </strong>
        <p>{certification.disclaimer}</p>
      </div>
      {spacingCaveat && (
        <div className="clearance-caveat">
          <strong>Sampling bound is large relative to what was measured</strong>
          <p>
            The worst-case sample spacing (
            {formatMillimetres(
              certification.sampleSpacingUpperBoundMillimetres,
            )}
            ) is at least as large as the measured maximum deviation (
            {formatMillimetres(certification.maximumDistanceMillimetres)}), so a
            real deviation at least this large could exist between sampled
            points and go unreported.
          </p>
        </div>
      )}
    </>
  );
}

function DirectionalDeviationRows({
  label,
  deviation,
}: {
  label: string;
  deviation: DirectionalDeviation;
}) {
  return (
    <>
      <div role="row">
        <strong role="rowheader">{label}: max deviation</strong>
        <span>{formatMillimetres(deviation.maximumDistanceMillimetres)}</span>
      </div>
      <div role="row">
        <strong role="rowheader">{label}: mean deviation</strong>
        <span>{formatMillimetres(deviation.meanDistanceMillimetres)}</span>
      </div>
      <div role="row">
        <strong role="rowheader">{label}: sample spacing bound</strong>
        <span>
          {formatMillimetres(deviation.sampleSpacingUpperBoundMillimetres)}
        </span>
      </div>
    </>
  );
}

function SimplifyReport({ outcome }: { outcome: ConvertSimplifyOutcome }) {
  const { original, simplified, reduction, parameters, certification } =
    outcome;
  return (
    <div className="geometry-summary" aria-labelledby="convert-simplify-title">
      <h3 id="convert-simplify-title">Simplification result</h3>
      <SimplifyHeadline outcome={outcome} />
      <CertificationDisclaimer certification={certification} />
      <div className="geometry-table geometry-table-2col" role="table">
        <div className="geometry-table-head" role="row">
          <span role="columnheader">Measure</span>
          <span role="columnheader">Value</span>
        </div>
        <div role="row">
          <strong role="rowheader">Original triangles</strong>
          <span>{formatCount(original.triangleCount)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Simplified triangles</strong>
          <span>{formatCount(simplified.triangleCount)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Triangles removed</strong>
          <span>{formatCount(reduction.triangleCountRemoved)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Reduction achieved</strong>
          <span>{formatPercent(reduction.triangleReductionRatio)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Target reached</strong>
          <span>{reduction.targetReached ? "Yes" : "No"}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Requested target</strong>
          <span>
            {parameters.requestedTarget.kind === "triangle-count"
              ? `${formatCount(parameters.requestedTarget.triangleCount)} triangles`
              : formatPercent(parameters.requestedTarget.reductionRatio)}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Collapse boundary edges</strong>
          <span>
            {parameters.collapseBoundaryEdges ? "Yes (opted in)" : "No"}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Combined maximum deviation</strong>
          <span>
            {formatMillimetres(certification.maximumDistanceMillimetres)}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Combined mean deviation</strong>
          <span>
            {formatMillimetres(certification.meanDistanceMillimetres)}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Combined sample spacing bound</strong>
          <span>
            {formatMillimetres(
              certification.sampleSpacingUpperBoundMillimetres,
            )}
          </span>
        </div>
        <DirectionalDeviationRows
          label="Original → simplified"
          deviation={certification.originalToSimplified}
        />
        <DirectionalDeviationRows
          label="Simplified → original"
          deviation={certification.simplifiedToOriginal}
        />
        <div role="row">
          <strong role="rowheader">Certification method</strong>
          <span>
            {certification.method.id} v{certification.method.version}
          </span>
        </div>
      </div>
      <WarningsList warnings={outcome.warnings} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export: format/unit/axis form, filename, precision note, and report
// ---------------------------------------------------------------------------

interface ExportForm {
  readonly format: ExportFormat | "";
  readonly unit: ResolvedSourceUnit | "";
  readonly axis: ResolvedSourceAxis | "";
  readonly source: "original" | "simplified";
}

const initialExportForm: ExportForm = {
  format: "",
  unit: "",
  axis: "",
  source: "original",
};

/** Every field is required with no default -- see `ExportOptions`'s own doc
 *  comment on why `exportModel` never silently picks a format, unit, or
 *  axis. */
export function exportFormReady(
  form: ExportForm,
): { ready: true } | { ready: false; message: string } {
  if (!form.format)
    return { ready: false, message: "Choose an export format." };
  if (!form.unit) return { ready: false, message: "Choose an output unit." };
  if (!form.axis) return { ready: false, message: "Choose an output up-axis." };
  return { ready: true };
}

/** Named from the loaded source and target format, e.g.
 *  `bracket.simplified.stl` or `bracket.obj` -- never a bare, unlabelled
 *  download. */
export function exportFileName(
  sourceName: string,
  format: ExportFormat,
  source: "original" | "simplified",
): string {
  const dot = sourceName.lastIndexOf(".");
  const base = (dot > 0 ? sourceName.slice(0, dot) : sourceName) || "model";
  const suffix = source === "simplified" ? ".simplified" : "";
  const extension = format === "obj" ? "obj" : "stl";
  return `${base}${suffix}.${extension}`;
}

/** Static, format-inherent precision behavior -- not a per-export warning,
 *  since it holds regardless of what any particular model measures. See
 *  `exportModel`'s own doc comment ("Round-trip exactness"). */
export function precisionNote(
  format: ExportFormat,
  targetUnit: ResolvedSourceUnit,
): string {
  if (format === "stl-binary") {
    return "Binary STL stores each coordinate as a 32-bit float, so this file's round-trip precision is bounded by float32's roughly 1.2e-7 relative precision, regardless of unit.";
  }
  if (targetUnit === "millimetre") {
    return "This text format's number encoding round-trips exactly, and millimetre is this model's own canonical unit, so re-importing this exact file at millimetre recovers bit-identical geometry.";
  }
  return "This text format's number encoding round-trips exactly, but converting to a non-millimetre unit and back is ordinary floating-point division and multiplication -- expect equality to only a few ULPs (roughly 1e-15 relative), not bit-identical geometry.";
}

function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can race the download the click() just started in
  // some browsers; a 0ms macrotask lets that navigation begin first -- same
  // rationale as ComparisonFlow.tsx's own `downloadSessionArchive`.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ExportReport({
  outcome,
  sourceName,
}: {
  outcome: ConvertExportOutcome;
  sourceName: string;
}) {
  const unitWarning = outcome.warnings.find(
    (warning) => warning.code === "export.unit-not-declared",
  );
  const otherWarnings = outcome.warnings.filter(
    (warning) => warning.code !== "export.unit-not-declared",
  );
  return (
    <div className="geometry-summary" aria-labelledby="convert-export-title">
      <h3 id="convert-export-title">Export result</h3>
      <p>
        Exported the{" "}
        {outcome.source === "simplified" ? "simplified" : "original"} model as{" "}
        {exportFormats.find((f) => f.value === outcome.format)?.label},{" "}
        {formatCount(outcome.geometry.triangleCount)} triangles,{" "}
        {formatFileSize(outcome.bytes.byteLength)}.
      </p>
      <div className="convert-disclaimer">
        <strong>This file cannot record its own unit or axis.</strong>
        <p>
          {unitWarning?.message ??
            `Neither STL nor OBJ can declare a unit or axis convention. This export was written in ${outcome.targetUnit}, ${outcome.targetAxis}; to recover equivalent geometry, re-import this file and declare it as ${outcome.targetUnit}, ${outcome.targetAxis} again.`}
        </p>
      </div>
      <p className="inspect-semantics-note">
        {precisionNote(outcome.format, outcome.targetUnit)}
      </p>
      <div className="geometry-table geometry-table-2col" role="table">
        <div className="geometry-table-head" role="row">
          <span role="columnheader">Measure</span>
          <span role="columnheader">Value</span>
        </div>
        <div role="row">
          <strong role="rowheader">Format</strong>
          <span>
            {exportFormats.find((f) => f.value === outcome.format)?.label}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Source model</strong>
          <span>
            {outcome.source === "simplified"
              ? "Simplified"
              : "Original (unmodified)"}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Output unit</strong>
          <span>
            {units.find((u) => u.value === outcome.targetUnit)?.label}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Output up-axis</strong>
          <span>{axes.find((a) => a.value === outcome.targetAxis)?.label}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Triangles written</strong>
          <span>{formatCount(outcome.geometry.triangleCount)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Vertices written</strong>
          <span>{formatCount(outcome.geometry.vertexCount)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">File size</strong>
          <span>{formatFileSize(outcome.bytes.byteLength)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Content digest (SHA-256)</strong>
          <span>{outcome.digest.value}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Applied model-to-target transform</strong>
          <span>
            <code>
              {outcome.appliedModelToTarget.map(formatNumber).join(" ")}
            </code>
          </span>
        </div>
      </div>
      <WarningsList warnings={otherWarnings} />
      {outcome.notes.length > 0 && (
        <div className="provenance-warnings">
          <strong>Notes</strong>
          <ul>
            {outcome.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="actions">
        <button
          className="button button-primary"
          type="button"
          onClick={() =>
            downloadBytes(
              outcome.bytes,
              exportFileName(sourceName, outcome.format, outcome.source),
            )
          }
        >
          Download {exportFileName(sourceName, outcome.format, outcome.source)}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Same rationale as `ForensicsFlow`'s/`InspectFlow`'s own `INITIAL_CAPABILITY`:
 *  no device signals exist during server-side prerendering or before the
 *  first client effect runs, so this matches exactly what
 *  `evaluateCapabilityPreflight` returns for an all-unknown, worker-capable
 *  reading, keeping prerendered HTML and the first client render identical. */
const INITIAL_CAPABILITY: CapabilityPreflight = {
  recommendedAnalysisMemoryMiB: DEFAULT_ANALYSIS_MEMORY_MIB,
  memoryNotes: [],
  workersAvailable: true,
  webglAvailable: true,
  analysisSupported: true,
  blockingMessage: undefined,
};

export function ConvertFlow() {
  const [selection, setSelection] = useState(modelSourceSelectionForFile(null));
  const [loadProgress, setLoadProgress] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [loadNotice, setLoadNotice] = useState<string>();
  const [session, setSession] = useState<ConvertSession>();
  const [sourceMeta, setSourceMeta] = useState<{
    name: string;
    size: number;
  }>();

  const [simplifyForm, setSimplifyForm] = useState(initialSimplifyForm);
  const [simplifyProgress, setSimplifyProgress] = useState<string>();
  const [simplifyError, setSimplifyError] = useState<string>();
  const [simplifyOutcome, setSimplifyOutcome] =
    useState<ConvertSimplifyOutcome>();

  const [exportForm, setExportForm] = useState(initialExportForm);
  const [exportProgress, setExportProgress] = useState<string>();
  const [exportError, setExportError] = useState<string>();
  const [exportOutcome, setExportOutcome] = useState<ConvertExportOutcome>();

  const [capability, setCapability] =
    useState<CapabilityPreflight>(INITIAL_CAPABILITY);
  useEffect(() => {
    setCapability(evaluateCapabilityPreflight(readEnvironmentReadings()));
  }, []);

  const sessionRef = useRef<ConvertSession | undefined>(undefined);
  const activeLoadRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      activeLoadRef.current?.abort();
      sessionRef.current?.close();
    };
  }, []);

  const capabilityCheck = modelSourceCapability(selection);
  const ready =
    capabilityCheck.ready && !loadProgress && capability.analysisSupported;

  const load = async () => {
    if (!ready || !selection.file || !selection.unit || !selection.axis) return;
    activeLoadRef.current?.abort();
    sessionRef.current?.close();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    setLoadError(undefined);
    setLoadNotice(undefined);
    setLoadProgress("Reading and loading the model locally");
    try {
      const opened = await openConvertSession(
        selection as ConvertSource,
        controller.signal,
      );
      sessionRef.current = opened;
      setSession(opened);
      setSourceMeta({ name: selection.file.name, size: selection.file.size });
    } catch (reason) {
      if (reason instanceof ConvertSessionCancelledError) {
        setLoadNotice("Loading cancelled.");
      } else {
        setLoadError(
          reason instanceof Error ? reason.message : "Loading failed safely.",
        );
      }
    } finally {
      setLoadProgress(undefined);
      if (activeLoadRef.current === controller) activeLoadRef.current = null;
    }
  };

  const cancelLoad = () => activeLoadRef.current?.abort();

  const reset = () => {
    sessionRef.current?.close();
    sessionRef.current = undefined;
    setSession(undefined);
    setSourceMeta(undefined);
    setLoadError(undefined);
    setLoadNotice(undefined);
    setSelection(modelSourceSelectionForFile(null));
    setSimplifyForm(initialSimplifyForm);
    setSimplifyOutcome(undefined);
    setSimplifyError(undefined);
    setExportForm(initialExportForm);
    setExportOutcome(undefined);
    setExportError(undefined);
  };

  const runSimplify = async () => {
    if (!session || !sourceMeta) return;
    const resolved = resolveSimplifyTarget(
      simplifyForm,
      session.load.counts.triangleCount,
    );
    if ("error" in resolved) {
      setSimplifyError(resolved.error);
      return;
    }
    setSimplifyError(undefined);
    setSimplifyProgress("Simplifying and certifying the result locally");
    try {
      const outcome = await session.simplify({
        target: resolved.target,
        collapseBoundaryEdges: simplifyForm.collapseBoundaryEdges,
      });
      setSimplifyOutcome(outcome);
      // A fresh simplification supersedes any export report already shown
      // for the previous simplified model -- never leave a stale export next
      // to a report that no longer matches the model it would export.
      setExportOutcome(undefined);
      setExportForm((current) => ({ ...current, source: "simplified" }));
    } catch (reason) {
      setSimplifyError(
        reason instanceof Error
          ? reason.message
          : "Simplification failed safely.",
      );
    } finally {
      setSimplifyProgress(undefined);
    }
  };

  const runExport = async () => {
    if (!session || !sourceMeta) return;
    const check = exportFormReady(exportForm);
    if (!check.ready) {
      setExportError(check.message);
      return;
    }
    setExportError(undefined);
    setExportProgress("Exporting locally");
    try {
      const outcome = await session.export(exportForm.source, {
        targetFormat: exportForm.format as ExportFormat,
        targetUnit: exportForm.unit as ResolvedSourceUnit,
        targetAxis: exportForm.axis as ResolvedSourceAxis,
      });
      setExportOutcome(outcome);
      downloadBytes(
        outcome.bytes,
        exportFileName(sourceMeta.name, outcome.format, outcome.source),
      );
    } catch (reason) {
      setExportError(
        reason instanceof Error ? reason.message : "Export failed safely.",
      );
    } finally {
      setExportProgress(undefined);
    }
  };

  return (
    <ToolShell
      eyebrow="Convert"
      title="Simplify and convert a model, with the deviation this introduced"
      description="Load one local model, optionally simplify it toward a triangle-count or reduction-ratio target with a measured, disclaimed certification of how far the result deviates from the original, then export the result (or the untouched original) to binary STL, ASCII STL, or OBJ in the unit and axis you choose explicitly. Runs entirely in your browser -- no 3D view, just the textual report and the downloaded file."
    >
      {!capability.analysisSupported && (
        <div className="comparison-error" role="alert">
          <strong>Local conversion is unavailable in this browser</strong>
          <p>{capability.blockingMessage}</p>
        </div>
      )}

      <section
        className="comparison-card"
        aria-labelledby="convert-choose-title"
      >
        <div className="section-heading">
          <span className="step">Step 01</span>
          <h2 id="convert-choose-title">Choose a model</h2>
          <p>
            Select one supported file to load locally using common millimetre
            and right-handed Z-up defaults. If the source uses a different
            frame, adjust its Expert settings first. Loading requires no network
            step; the file and its geometry stay inside this browser&rsquo;s
            dedicated conversion worker.
          </p>
        </div>
        <div className="inspect-model-field">
          <ModelSourceCard
            selection={selection}
            update={setSelection}
            disabled={Boolean(session)}
          />
        </div>
        <p className="inspect-semantics-note">
          Simplification&rsquo;s implementation ceiling is{" "}
          {formatCount(MAX_SIMPLIFY_INPUT_TRIANGLES)} placed triangles (below
          the importer&rsquo;s own{" "}
          {formatCount(IMPORTER_SAFETY_LIMITS.triangleCount)}
          -triangle ceiling); a larger model can still be loaded and exported
          unsimplified.
        </p>
        {!session ? (
          <>
            <div className="comparison-status" aria-live="polite">
              <span className={ready ? "status-ready" : ""}>
                {loadProgress ??
                  loadNotice ??
                  (ready
                    ? "Inputs pass capability preflight"
                    : !capability.analysisSupported
                      ? "Conversion disabled: see the browser support notice above"
                      : "Choose a source file")}
              </span>
              <div className="actions">
                {loadProgress && (
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={cancelLoad}
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="button button-primary"
                  type="button"
                  disabled={!ready}
                  onClick={() => void load()}
                >
                  {loadProgress ? "Loading locally…" : "Load model"}
                </button>
              </div>
            </div>
            {loadError && (
              <div className="comparison-error" role="alert">
                <strong>Loading could not continue</strong>
                <p>{loadError}</p>
              </div>
            )}
          </>
        ) : (
          <div className="comparison-status" aria-live="polite">
            <span className="status-ready">
              Loaded {sourceMeta?.name} —{" "}
              {formatCount(session.load.counts.triangleCount)} triangles,{" "}
              {formatCount(session.load.counts.vertexCount)} vertices across{" "}
              {session.load.counts.meshCount} mesh
              {session.load.counts.meshCount === 1 ? "" : "es"} and{" "}
              {session.load.counts.instanceCount} instance
              {session.load.counts.instanceCount === 1 ? "" : "s"}.
            </span>
            <div className="actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={reset}
              >
                Convert another model
              </button>
            </div>
          </div>
        )}
        {session && <WarningsList warnings={session.load.warnings} />}
        <p className="boundary-note">
          <strong>Local boundary:</strong> the source file and its geometry stay
          inside this browser&rsquo;s dedicated conversion worker; only the
          structured reports below, and the file you explicitly download, ever
          leave it.
        </p>
      </section>

      {session && sourceMeta && (
        <section
          className="comparison-card"
          aria-labelledby="convert-simplify-heading"
        >
          <div className="section-heading">
            <span className="step">Step 02</span>
            <h2 id="convert-simplify-heading">Simplify (optional)</h2>
            <p>
              Decimate toward a triangle-count or reduction-ratio target, then
              see the certified, measured deviation this introduced -- or skip
              this step and export the model unmodified below.
            </p>
          </div>
          <fieldset className="source-card">
            <legend>Target</legend>
            <div className="source-frame">
              <label>
                Mode
                <select
                  id="convert-simplify-mode"
                  value={simplifyForm.mode}
                  onChange={(event) => {
                    const mode = event.currentTarget.value as SimplifyMode;
                    setSimplifyForm((current) => ({ ...current, mode }));
                  }}
                >
                  <option value="skip">Skip simplification</option>
                  <option value="triangle-count">Target triangle count</option>
                  <option value="reduction-ratio">
                    Target reduction percentage
                  </option>
                </select>
              </label>
              {simplifyForm.mode === "triangle-count" && (
                <label>
                  Target triangle count
                  <input
                    id="convert-target-triangle-count"
                    type="number"
                    min={1}
                    max={session.load.counts.triangleCount - 1}
                    step={1}
                    value={simplifyForm.triangleCountText}
                    onChange={(event) => {
                      const triangleCountText = event.currentTarget.value;
                      setSimplifyForm((current) => ({
                        ...current,
                        triangleCountText,
                      }));
                    }}
                  />
                </label>
              )}
              {simplifyForm.mode === "reduction-ratio" && (
                <label>
                  Reduction percentage
                  <input
                    id="convert-target-reduction-percent"
                    type="number"
                    min={1}
                    max={99}
                    step={1}
                    value={simplifyForm.reductionPercentText}
                    onChange={(event) => {
                      const reductionPercentText = event.currentTarget.value;
                      setSimplifyForm((current) => ({
                        ...current,
                        reductionPercentText,
                      }));
                    }}
                  />
                </label>
              )}
            </div>
            {simplifyForm.mode !== "skip" && (
              <>
                <label>
                  <input
                    id="convert-collapse-boundary-edges"
                    type="checkbox"
                    checked={simplifyForm.collapseBoundaryEdges}
                    onChange={(event) => {
                      const collapseBoundaryEdges = event.currentTarget.checked;
                      setSimplifyForm((current) => ({
                        ...current,
                        collapseBoundaryEdges,
                      }));
                    }}
                  />
                  Allow boundary edges to collapse
                </label>
                {simplifyForm.collapseBoundaryEdges && (
                  <p className="inspect-semantics-note">
                    Off by default, this preserves every open boundary loop
                    exactly (same count, same edges, same positions). Opting in
                    lets boundary vertices collapse like any other, which can
                    change a boundary loop&rsquo;s count, length, or shape.
                  </p>
                )}
              </>
            )}
          </fieldset>
          <div className="comparison-status" aria-live="polite">
            <span>
              {simplifyProgress ??
                (simplifyForm.mode === "skip"
                  ? "Simplification skipped"
                  : "Ready to simplify")}
            </span>
            <div className="actions">
              <button
                className="button button-primary"
                type="button"
                disabled={
                  simplifyForm.mode === "skip" || Boolean(simplifyProgress)
                }
                onClick={() => void runSimplify()}
              >
                {simplifyProgress
                  ? "Simplifying locally…"
                  : "Run simplification"}
              </button>
            </div>
          </div>
          {simplifyError && (
            <div className="comparison-error" role="alert">
              <strong>Simplification could not continue</strong>
              <p>{simplifyError}</p>
            </div>
          )}
          {simplifyOutcome && <SimplifyReport outcome={simplifyOutcome} />}
        </section>
      )}

      {session && sourceMeta && (
        <section
          className="comparison-card"
          aria-labelledby="convert-export-heading"
        >
          <div className="section-heading">
            <span className="step">Step 03</span>
            <h2 id="convert-export-heading">Export</h2>
            <p>
              Choose a format, output unit, and output up-axis explicitly --
              none of them default. Export the simplified result once it exists,
              or the untouched original at any time.
            </p>
          </div>
          <fieldset className="source-card">
            <legend>Output</legend>
            {simplifyOutcome && (
              <div className="source-frame">
                <label>
                  Export
                  <select
                    id="convert-export-source"
                    value={exportForm.source}
                    onChange={(event) => {
                      const source = event.currentTarget.value as
                        "original" | "simplified";
                      setExportForm((current) => ({ ...current, source }));
                    }}
                  >
                    <option value="simplified">The simplified model</option>
                    <option value="original">
                      The original, unmodified model
                    </option>
                  </select>
                </label>
              </div>
            )}
            <div className="source-frame">
              <label>
                Format
                <select
                  id="convert-export-format"
                  value={exportForm.format}
                  onChange={(event) => {
                    const format = event.currentTarget.value as
                      ExportFormat | "";
                    setExportForm((current) => ({ ...current, format }));
                  }}
                >
                  <option value="">Choose a format…</option>
                  {exportFormats.map((format) => (
                    <option key={format.value} value={format.value}>
                      {format.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Output unit
                <select
                  id="convert-export-unit"
                  value={exportForm.unit}
                  onChange={(event) => {
                    const unit = event.currentTarget.value as
                      ResolvedSourceUnit | "";
                    setExportForm((current) => ({ ...current, unit }));
                  }}
                >
                  <option value="">Choose a unit…</option>
                  {units.map((unit) => (
                    <option key={unit.value} value={unit.value}>
                      {unit.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Output up-axis
                <select
                  id="convert-export-axis"
                  value={exportForm.axis}
                  onChange={(event) => {
                    const axis = event.currentTarget.value as
                      ResolvedSourceAxis | "";
                    setExportForm((current) => ({ ...current, axis }));
                  }}
                >
                  <option value="">Choose an axis…</option>
                  {axes.map((axis) => (
                    <option key={axis.value} value={axis.value}>
                      {axis.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
          <div className="comparison-status" aria-live="polite">
            <span>{exportProgress ?? "Ready to export"}</span>
            <div className="actions">
              <button
                className="button button-primary"
                type="button"
                disabled={Boolean(exportProgress)}
                onClick={() => void runExport()}
              >
                {exportProgress ? "Exporting locally…" : "Export and download"}
              </button>
            </div>
          </div>
          {exportError && (
            <div className="comparison-error" role="alert">
              <strong>Export could not continue</strong>
              <p>{exportError}</p>
            </div>
          )}
          {exportOutcome && sourceMeta && (
            <ExportReport
              outcome={exportOutcome}
              sourceName={sourceMeta.name}
            />
          )}
        </section>
      )}
    </ToolShell>
  );
}
