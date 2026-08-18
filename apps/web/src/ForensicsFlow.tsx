import type {
  ContractWarning,
  SourceAxis,
  SourceUnit,
} from "@voxelspy/contracts";
import {
  IMPORTER_SAFETY_LIMITS,
  importerDescriptor,
} from "@voxelspy/importers";
import { useEffect, useRef, useState } from "react";
import {
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import {
  forensicsSourceAsync,
  InspectionCancelledError,
  type ForensicsOutcome,
  type InspectSource,
} from "./inspect-worker-client";
import { ToolShell } from "./ToolShell";
import { DEFAULT_ANALYSIS_MEMORY_MIB } from "./worker-client";

/**
 * `/tools/file-forensics/`: the structural and provenance truth of one local
 * STL or OBJ file, as distinct from `/tools/inspect/`'s geometric
 * measurements. Both tools import the same file through the same
 * `@voxelspy/importers` `importModel` and the same dedicated worker channel
 * (`inspect-worker-client.ts`'s `"forensics"` message kind); this page never
 * runs a second importer or a separate validator, and never claims to answer
 * "is this file valid" in general -- only "what did *this* importer see".
 */

type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;

// ---------------------------------------------------------------------------
// Source selection. Deliberately duplicated from InspectFlow.tsx/
// ComparisonFlow.tsx rather than imported: each tool keeps its own copy of
// this small, pure, file-picker precondition logic (see InspectFlow.tsx's
// own note on duplicating small pure helpers), so this file has no
// dependency on either of those tool-specific UIs.
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

/** Same preconditions as Inspect's and Compare's own `*Capability` checks
 *  (this release's one importer applies uniformly), phrased for a forensics
 *  report rather than a measurement report or a comparison. */
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
        ? "Ready for local analysis using millimetres and right-handed Z-up."
        : "Ready for local analysis using the selected expert source frame.",
  };
}

function ModelSourceCard({
  selection,
  update,
}: {
  selection: ModelSourceSelection;
  update: (selection: ModelSourceSelection) => void;
}) {
  const capability = modelSourceCapability(selection);
  return (
    <fieldset className="source-card">
      <legend>Model</legend>
      <label className="source-file" htmlFor="forensics-model-file">
        <span>{selection.file?.name ?? "Choose a model"}</span>
        <small>
          {selection.file
            ? `${(selection.file.size / 1024).toFixed(1)} KiB · local file`
            : "STL or OBJ, up to 32 MiB"}
        </small>
        <input
          id="forensics-model-file"
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
          This affects the applied source-to-model transform reported below, not
          just how the model looks.
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

/** Matrix and other exact numeric fields: up to 6 fraction digits, enough to
 *  show a micrometre-scale factor (0.001) exactly without noise on the
 *  common integer entries (0, 1, -1, 25.4, 304.8, …). */
function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(value);
}

function unitLabel(unit: string): string {
  const known = units.find((entry) => entry.value === unit)?.label;
  if (known) return known;
  return unit === "unknown" ? "not declared by the file" : unit;
}

function axisLabel(axis: string): string {
  const known = axes.find((entry) => entry.value === axis)?.label;
  if (known) return known;
  return axis === "unknown" ? "not declared by the file" : axis;
}

function originLabel(origin: "embedded" | "declared" | "user"): string {
  if (origin === "embedded") return "embedded in the file";
  if (origin === "declared") return "import default";
  return "expert override";
}

function severityLabel(severity: ContractWarning["severity"]): string {
  if (severity === "error") return "Error";
  return severity === "warning" ? "Warning" : "Info";
}

function detailValueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Static "what this importer supports" panel -- reads `importerDescriptor`
// and `IMPORTER_SAFETY_LIMITS` directly from `@voxelspy/importers`, never a
// second, hand-maintained copy of those limits, so this list cannot drift
// from what the importer actually enforces. Shown regardless of whether a
// file has been chosen: it is context for every report below, not part of
// one.
// ---------------------------------------------------------------------------

function ImporterSupportPanel() {
  return (
    <section
      className="comparison-card importer-support"
      aria-labelledby="forensics-importer-title"
    >
      <h2 id="forensics-importer-title">What this importer supports</h2>
      <p>
        Read directly from {importerDescriptor.id} v{importerDescriptor.version}
        , the one importer this page (and Inspect) uses, so this list cannot
        drift from what it actually enforces. This describes VoxelSpy&rsquo;s
        own importer, not either file format in general: a file this importer
        accepts may still be rejected elsewhere, and a file it refuses may be
        perfectly valid input for another tool.
      </p>
      <dl className="provenance-list">
        <div>
          <dt>Supported formats</dt>
          <dd>
            {importerDescriptor.formats.map((f) => f.toUpperCase()).join(", ")}
          </dd>
        </div>
        <div>
          <dt>Accepted extensions</dt>
          <dd>
            {importerDescriptor.extensions.map((ext) => `.${ext}`).join(", ")}
          </dd>
        </div>
        <div>
          <dt>Accepted media types</dt>
          <dd>{importerDescriptor.mediaTypes.join(", ")}</dd>
        </div>
        <div>
          <dt>Assemblies</dt>
          <dd>
            {importerDescriptor.capabilities.assemblies
              ? "Supported"
              : "Not supported"}
          </dd>
        </div>
        <div>
          <dt>Tessellation provenance</dt>
          <dd>
            {importerDescriptor.capabilities.tessellationProvenance
              ? "Supported"
              : "Not supported"}
          </dd>
        </div>
        <div>
          <dt>External resources</dt>
          <dd>
            {importerDescriptor.capabilities.externalResources
              ? "Supported"
              : "Not supported"}
          </dd>
        </div>
        <div>
          <dt>Input size ceiling</dt>
          <dd>{formatFileSize(IMPORTER_SAFETY_LIMITS.inputBytes)}</dd>
        </div>
        <div>
          <dt>Triangle ceiling</dt>
          <dd>{formatCount(IMPORTER_SAFETY_LIMITS.triangleCount)} triangles</dd>
        </div>
        <div>
          <dt>OBJ vertex ceiling</dt>
          <dd>
            {formatCount(IMPORTER_SAFETY_LIMITS.vertexCount)} vertices (OBJ
            only)
          </dd>
        </div>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function ForensicsReport({
  outcome,
  sourceMeta,
  onReset,
}: {
  outcome: ForensicsOutcome;
  sourceMeta: { name: string; size: number };
  onReset: () => void;
}) {
  const { provenance, warnings } = outcome;
  const extension = sourceMeta.name.includes(".")
    ? sourceMeta.name.slice(sourceMeta.name.lastIndexOf(".") + 1)
    : undefined;
  const totalTriangles = outcome.meshes.reduce(
    (sum, mesh) => sum + mesh.triangleCount,
    0,
  );
  const totalVertices = outcome.meshes.reduce(
    (sum, mesh) => sum + mesh.vertexCount,
    0,
  );
  const hasRefusals = warnings.length > 0 || provenance.notes.length > 0;

  return (
    <div className="inspect-report">
      <header className="inspect-report-header">
        <div>
          <h2>{sourceMeta.name}</h2>
          <p>
            {formatFileSize(sourceMeta.size)} · {provenance.formatId} · this
            importer&rsquo;s own report, not a general format validator
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={onReset}
        >
          Analyze another file
        </button>
      </header>

      <section aria-labelledby="forensics-identity-title">
        <h3 id="forensics-identity-title">File identity</h3>
        <dl className="provenance-list">
          <div>
            <dt>Detected format</dt>
            <dd>
              {provenance.formatId.toUpperCase()}
              {extension
                ? ` (the file name ends in ".${extension}")`
                : " (detected by file extension)"}
            </dd>
          </div>
          <div>
            <dt>Input size</dt>
            <dd>
              {formatFileSize(sourceMeta.size)} of the importer&rsquo;s{" "}
              {formatFileSize(IMPORTER_SAFETY_LIMITS.inputBytes)} input-size
              ceiling
            </dd>
          </div>
          <div>
            <dt>Content digest (SHA-256)</dt>
            <dd>{provenance.sourceDigest?.value ?? "Not computed"}</dd>
          </div>
          <div>
            <dt>Importer</dt>
            <dd>
              {provenance.importerId} v{provenance.importerVersion}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="forensics-structure-title">
        <h3 id="forensics-structure-title">Mesh &amp; instance structure</h3>
        <p>
          Placement:{" "}
          {outcome.placementKind === "flat"
            ? "flat (no assembly hierarchy)"
            : "hierarchical assembly"}{" "}
          · {outcome.meshes.length} mesh
          {outcome.meshes.length === 1 ? "" : "es"} · {outcome.instances.length}{" "}
          instance{outcome.instances.length === 1 ? "" : "s"}
        </p>
        <div className="geometry-table" role="table">
          <div className="geometry-table-head" role="row">
            <span role="columnheader">Mesh</span>
            <span role="columnheader">Triangles</span>
            <span role="columnheader">Vertices</span>
          </div>
          {outcome.meshes.map((mesh) => (
            <div role="row" key={mesh.meshId}>
              <strong role="rowheader">{mesh.meshId}</strong>
              <span>{formatCount(mesh.triangleCount)}</span>
              <span>{formatCount(mesh.vertexCount)}</span>
            </div>
          ))}
        </div>
        <p>
          {formatCount(totalTriangles)} triangle
          {totalTriangles === 1 ? "" : "s"} placed of the importer&rsquo;s{" "}
          {formatCount(IMPORTER_SAFETY_LIMITS.triangleCount)}-triangle ceiling.
          {provenance.formatId === "obj" && (
            <>
              {" "}
              {formatCount(totalVertices)} vertices parsed of the
              importer&rsquo;s {formatCount(IMPORTER_SAFETY_LIMITS.vertexCount)}
              -vertex ceiling for OBJ.
            </>
          )}
        </p>
        <dl className="provenance-list">
          {outcome.instances.map((instance) => (
            <div key={instance.instanceId}>
              <dt>{instance.instanceId}</dt>
              <dd>
                mesh {instance.meshId} · {instance.transformKind} transform:{" "}
                <code>{instance.transform.map(formatNumber).join(" ")}</code>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="forensics-frame-title">
        <h3 id="forensics-frame-title">Unit &amp; axis interpretation</h3>
        <dl className="provenance-list">
          <div>
            <dt>Detected source unit</dt>
            <dd>{unitLabel(provenance.detectedSourceUnit)}</dd>
          </div>
          <div>
            <dt>Detected source axis</dt>
            <dd>{axisLabel(provenance.detectedSourceAxis)}</dd>
          </div>
          <div>
            <dt>Resolved source unit</dt>
            <dd>
              {unitLabel(provenance.sourceUnit)} (
              {originLabel(provenance.sourceResolution.unit)})
            </dd>
          </div>
          <div>
            <dt>Resolved source axis</dt>
            <dd>
              {axisLabel(provenance.sourceAxis)} (
              {originLabel(provenance.sourceResolution.axis)})
            </dd>
          </div>
          <div>
            <dt>Applied source-to-model transform</dt>
            <dd>
              <code>
                {provenance.appliedSourceToModel.map(formatNumber).join(" ")}
              </code>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="forensics-refusals-title">
        <h3 id="forensics-refusals-title">What this importer did not accept</h3>
        {!hasRefusals ? (
          <p className="empty-findings">
            No warnings or notes were recorded for this import: nothing was
            skipped, approximated, merged, or ignored.
          </p>
        ) : (
          <>
            {warnings.length > 0 && (
              <div className="provenance-warnings">
                <strong>Import warnings</strong>
                <ul>
                  {warnings.map((warning, index) => (
                    <li key={index}>
                      <span
                        className={
                          warning.severity === "error"
                            ? "severity-error"
                            : undefined
                        }
                      >
                        {severityLabel(warning.severity)}
                      </span>{" "}
                      <code>{warning.code}</code> — {warning.message}
                      {warning.details && (
                        <ul>
                          {Object.entries(warning.details).map(
                            ([key, value]) => (
                              <li key={key}>
                                {key}: {detailValueText(value)}
                              </li>
                            ),
                          )}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {provenance.notes.length > 0 && (
              <div className="provenance-warnings">
                <strong>Importer notes</strong>
                <ul>
                  {provenance.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Same rationale as `InspectFlow`'s/`ComparisonFlow`'s own `INITIAL_CAPABILITY`:
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

export function ForensicsFlow() {
  const [selection, setSelection] = useState(modelSourceSelectionForFile(null));
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [outcome, setOutcome] = useState<ForensicsOutcome>();
  const [sourceMeta, setSourceMeta] = useState<{
    name: string;
    size: number;
  }>();
  const [capability, setCapability] =
    useState<CapabilityPreflight>(INITIAL_CAPABILITY);
  useEffect(() => {
    setCapability(evaluateCapabilityPreflight(readEnvironmentReadings()));
  }, []);
  const activeRunRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => activeRunRef.current?.abort();
  }, []);

  const capabilityCheck = modelSourceCapability(selection);
  const ready =
    capabilityCheck.ready && !progress && capability.analysisSupported;

  const analyze = async () => {
    if (!ready || !selection.file || !selection.unit || !selection.axis) return;
    activeRunRef.current?.abort();
    const controller = new AbortController();
    activeRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setProgress("Reading and analyzing the file locally");
    try {
      const result = await forensicsSourceAsync(
        selection as InspectSource,
        controller.signal,
      );
      setSourceMeta({ name: selection.file.name, size: selection.file.size });
      setOutcome(result);
    } catch (reason) {
      if (reason instanceof InspectionCancelledError) {
        setNotice("Analysis cancelled.");
      } else {
        setError(
          reason instanceof Error ? reason.message : "Analysis failed safely.",
        );
      }
    } finally {
      setProgress(undefined);
      if (activeRunRef.current === controller) activeRunRef.current = null;
    }
  };

  const cancel = () => activeRunRef.current?.abort();

  const reset = () => {
    setOutcome(undefined);
    setSourceMeta(undefined);
    setError(undefined);
    setNotice(undefined);
    setSelection(modelSourceSelectionForFile(null));
  };

  return (
    <ToolShell
      eyebrow="File Forensics"
      title="What is actually inside this file?"
      description="Load one local STL or OBJ file and see its structural and provenance truth: the format this importer detected, the structure it built, and everything it warned about, refused, or could not represent. This is not a repeat of Inspect's dimensions and volume, and not a general file-format validator -- a file this tool accepts may still be rejected elsewhere, and a file it refuses may be valid input for another tool."
    >
      <ImporterSupportPanel />
      {outcome && sourceMeta ? (
        <ForensicsReport
          outcome={outcome}
          sourceMeta={sourceMeta}
          onReset={reset}
        />
      ) : (
        <section
          className="comparison-card"
          aria-labelledby="forensics-choose-title"
        >
          <div className="section-heading">
            <span className="step">Step 01</span>
            <h2 id="forensics-choose-title">Choose a model</h2>
            <p>
              Select one supported file to analyze immediately using common
              millimetre and right-handed Z-up defaults. If the source uses a
              different frame, adjust its Expert settings first.
            </p>
          </div>
          {!capability.analysisSupported && (
            <div className="comparison-error" role="alert">
              <strong>Local analysis is unavailable in this browser</strong>
              <p>{capability.blockingMessage}</p>
            </div>
          )}
          <div className="inspect-model-field">
            <ModelSourceCard selection={selection} update={setSelection} />
          </div>
          <div className="comparison-status" aria-live="polite">
            <span className={ready ? "status-ready" : ""}>
              {progress ??
                notice ??
                (ready
                  ? "Inputs pass capability preflight"
                  : !capability.analysisSupported
                    ? "Analysis disabled: see the browser support notice above"
                    : "Choose a source file")}
            </span>
            <div className="actions">
              {progress && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={cancel}
                >
                  Cancel analysis
                </button>
              )}
              <button
                className="button button-primary"
                type="button"
                disabled={!ready}
                onClick={() => void analyze()}
              >
                {progress ? "Analyzing locally…" : "Validate and analyze"}
              </button>
            </div>
          </div>
          {error && (
            <div className="comparison-error" role="alert">
              <strong>Analysis could not continue</strong>
              <p>{error}</p>
            </div>
          )}
          <p className="boundary-note">
            <strong>Local boundary:</strong> the source file and its geometry
            stay inside this browser's dedicated analysis worker; only the
            structured report leaves the worker, and nothing is uploaded.
          </p>
        </section>
      )}
    </ToolShell>
  );
}
