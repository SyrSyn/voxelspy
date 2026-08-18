import type { ModelComparisonPresentationSummary } from "@voxelspy/analysis";
import type { Report, SourceAxis, SourceUnit } from "@voxelspy/contracts";
import { SessionArchiveError } from "@voxelspy/session-archive";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  estimateAnalysisFit,
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import {
  boundedEntityId,
  brandId,
  buildComparisonReport,
  renderReportHtml,
  ReportBuildError,
} from "./report";
import {
  asArrayBufferBacked,
  describeSessionError,
  openSession,
  saveSession,
  sessionImportSpecFor,
  slug,
  SESSION_FILE_MEDIA_TYPE,
  type SavedSession,
  type SessionSourceModels,
} from "./session";
import {
  ANALYSIS_MEMORY_MAX_MIB,
  ANALYSIS_MEMORY_MIN_MIB,
  ANALYSIS_MEMORY_STEP_MIB,
  ComparisonCancelledError,
  DEFAULT_ANALYSIS_MEMORY_MIB,
  reimportSessionModels,
  runComparison,
  type ComparisonProgress,
  type ComparisonSource,
  type CompletedComparison,
} from "./worker-client";

type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;

const Workbench = lazy(async () => {
  const module = await import("./Workbench");
  return { default: module.Workbench };
});

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

type SourceSelection = {
  file: File | null;
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
  frameSource: "default" | "expert";
};

const defaultSourceFrame = {
  unit: "millimetre",
  axis: "right-handed-z-up",
  frameSource: "default",
} as const satisfies Pick<SourceSelection, "unit" | "axis" | "frameSource">;

export function sourceSelectionForFile(file: File | null): SourceSelection {
  return { file, ...defaultSourceFrame };
}

const emptySource = (): SourceSelection => sourceSelectionForFile(null);

/**
 * Server-side prerendering (and the first client render, before hydration
 * settles) has no device signals to read, so this matches exactly what
 * `evaluateCapabilityPreflight` returns for an all-unknown, worker-capable
 * reading -- optimistic about Worker/WebGL support (the overwhelmingly
 * common case) and at today's existing default allowance. The real
 * device-derived preflight replaces this after mount (see the effect in
 * `ComparisonFlow`), which keeps prerendered HTML and the first client
 * render identical and avoids a hydration mismatch.
 */
const INITIAL_CAPABILITY: CapabilityPreflight = {
  recommendedAnalysisMemoryMiB: DEFAULT_ANALYSIS_MEMORY_MIB,
  memoryNotes: [],
  workersAvailable: true,
  webglAvailable: true,
  analysisSupported: true,
  blockingMessage: undefined,
};

export function sourceCapability(selection: SourceSelection) {
  if (!selection.file)
    return { ready: false, message: "Choose a local STL or OBJ file." };
  if (!/\.(?:stl|obj)$/iu.test(selection.file.name))
    return {
      ready: false,
      message: "This release supports STL and OBJ mesh files.",
    };
  if (selection.file.size === 0)
    return { ready: false, message: "The selected file is empty." };
  if (selection.file.size > 32 * 1024 * 1024)
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
        ? "Ready for local comparison using millimetres and right-handed Z-up."
        : "Ready for local comparison using the selected expert source frame.",
  };
}

function SourceCard({
  role,
  selection,
  update,
}: {
  role: "Baseline" | "Candidate";
  selection: SourceSelection;
  update: (selection: SourceSelection) => void;
}) {
  const capability = sourceCapability(selection);
  const id = role.toLocaleLowerCase("en-US");
  return (
    <fieldset className="source-card">
      <legend>{role}</legend>
      <label className="source-file" htmlFor={`${id}-file`}>
        <span>{selection.file?.name ?? "Choose a model"}</span>
        <small>
          {selection.file
            ? `${(selection.file.size / 1024).toFixed(1)} KiB · local file`
            : "STL or OBJ, up to 32 MiB"}
        </small>
        <input
          id={`${id}-file`}
          type="file"
          accept=".stl,.obj"
          onChange={(event) =>
            update(
              sourceSelectionForFile(event.currentTarget.files?.[0] ?? null),
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
          The selected values are recorded with the comparison.
        </p>
        <div className="source-frame">
          <label>
            Source unit
            <select
              value={selection.unit}
              onChange={(event) =>
                update({
                  ...selection,
                  unit: event.currentTarget.value as SourceSelection["unit"],
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
                  axis: event.currentTarget.value as SourceSelection["axis"],
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

/** Downloads a saved session as a `.voxelspy` file via a revocable Blob URL. */
function downloadSessionArchive(saved: SavedSession) {
  const blob = new Blob([asArrayBufferBacked(saved.bytes)], {
    type: SESSION_FILE_MEDIA_TYPE,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = saved.fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can race the download the click() just started in
  // some browsers; a 0ms macrotask lets that navigation begin first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function describeSessionFailure(reason: unknown, action: "open" | "save") {
  if (reason instanceof SessionArchiveError)
    return describeSessionError(reason);
  if (reason instanceof Error) return reason.message;
  return action === "open"
    ? "The session could not be opened safely."
    : "The session could not be saved safely.";
}

/** File name for a downloaded report export: mirrors `sessionFileName`'s convention. */
function reportFileName(report: Report): string {
  const baseline = report.models.find((model) => model.role === "baseline");
  const candidate = report.models.find((model) => model.role === "candidate");
  return `voxelspy-report-${slug(baseline?.sourceName)}-vs-${slug(candidate?.sourceName)}.html`;
}

/** Downloads a rendered report as a self-contained `.html` file via a revocable Blob URL. */
function downloadReportHtml(report: Report, html: string) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = reportFileName(report);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // See `downloadSessionArchive` above for why the revoke is deferred.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function describeReportFailure(reason: unknown): string {
  if (reason instanceof ReportBuildError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return "The report could not be built safely.";
}

export function ComparisonFlow() {
  const [baseline, setBaseline] = useState(emptySource);
  const [candidate, setCandidate] = useState(emptySource);
  const [progress, setProgress] = useState<ComparisonProgress>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [result, setResult] = useState<CompletedComparison>();
  const [sourceModels, setSourceModels] = useState<SessionSourceModels>();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const [saveError, setSaveError] = useState<string>();
  const [exportStatus, setExportStatus] = useState<
    "idle" | "exporting" | "error"
  >("idle");
  const [exportError, setExportError] = useState<string>();
  const [openProgress, setOpenProgress] = useState<ComparisonProgress>();
  const [openError, setOpenError] = useState<string>();
  const [analysisMemoryMiB, setAnalysisMemoryMiB] = useState(
    DEFAULT_ANALYSIS_MEMORY_MIB,
  );
  const [capability, setCapability] =
    useState<CapabilityPreflight>(INITIAL_CAPABILITY);
  useEffect(() => {
    // Device signals (deviceMemory, hardwareConcurrency, pointer coarseness,
    // Worker/WebGL support) only exist client-side, so the recommended
    // allowance is applied once after mount rather than during the initial
    // render -- see `INITIAL_CAPABILITY` for why that keeps prerendered HTML
    // and the first client render identical. Running once on mount also
    // guarantees this never overwrites a value the user has since chosen on
    // the slider themselves.
    const preflight = evaluateCapabilityPreflight(readEnvironmentReadings());
    setCapability(preflight);
    setAnalysisMemoryMiB(preflight.recommendedAnalysisMemoryMiB);
  }, []);
  const activeRunRef = useRef<AbortController | null>(null);
  const activeOpenRunRef = useRef<AbortController | null>(null);
  const saveInFlightRef = useRef(false);
  const exportInFlightRef = useRef(false);
  const baselineCapability = useMemo(
    () => sourceCapability(baseline),
    [baseline],
  );
  const candidateCapability = useMemo(
    () => sourceCapability(candidate),
    [candidate],
  );
  const fitEstimate = useMemo(() => {
    if (!baseline.file || !candidate.file) return undefined;
    return estimateAnalysisFit(
      baseline.file.size + candidate.file.size,
      analysisMemoryMiB,
    );
  }, [baseline.file, candidate.file, analysisMemoryMiB]);
  const ready =
    baselineCapability.ready &&
    candidateCapability.ready &&
    !progress &&
    capability.analysisSupported;

  useEffect(() => {
    return () => {
      activeRunRef.current?.abort();
      activeOpenRunRef.current?.abort();
    };
  }, []);

  const compare = async () => {
    if (
      !ready ||
      !baseline.file ||
      !baseline.unit ||
      !baseline.axis ||
      !candidate.file ||
      !candidate.unit ||
      !candidate.axis
    )
      return;
    // A new run replaces any in-flight one; make sure it is stopped first.
    activeRunRef.current?.abort();
    activeOpenRunRef.current?.abort();
    const controller = new AbortController();
    activeRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setOpenError(undefined);
    setProgress({ stage: "starting", message: "Starting local comparison" });
    try {
      const next = await runComparison(
        baseline as ComparisonSource,
        candidate as ComparisonSource,
        setProgress,
        analysisMemoryMiB,
        controller.signal,
      );
      // Re-read the original files (Blobs are immutable and freely
      // re-readable) so a portable session can be saved later without
      // holding the import's transferred bytes in memory the whole time.
      const [baselineBytes, candidateBytes] = await Promise.all([
        baseline.file.arrayBuffer(),
        candidate.file.arrayBuffer(),
      ]);
      setSourceModels({
        baseline: new Uint8Array(baselineBytes),
        candidate: new Uint8Array(candidateBytes),
      });
      setSaveStatus("idle");
      setSaveError(undefined);
      setExportStatus("idle");
      setExportError(undefined);
      setResult(next);
    } catch (reason) {
      if (reason instanceof ComparisonCancelledError) {
        setNotice("Comparison cancelled.");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Comparison failed safely.",
        );
      }
    } finally {
      setProgress(undefined);
      if (activeRunRef.current === controller) activeRunRef.current = null;
    }
  };

  const cancel = () => {
    activeRunRef.current?.abort();
  };

  const openSessionFile = async (file: File) => {
    activeRunRef.current?.abort();
    activeOpenRunRef.current?.abort();
    const controller = new AbortController();
    activeOpenRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setOpenError(undefined);
    setOpenProgress({ stage: "starting", message: "Reading session file" });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const opened = await openSession(bytes);
      const report = opened.exchange.bundle.report;
      const baselineModel = report.models.find(
        (model) => model.role === "baseline",
      );
      const candidateModel = report.models.find(
        (model) => model.role === "candidate",
      );
      if (!baselineModel || !candidateModel)
        throw new Error(
          "The session archive is missing a required model entry.",
        );
      const baselineBytes = opened.resources.get(baselineModel.sourcePath);
      const candidateBytes = opened.resources.get(candidateModel.sourcePath);
      if (!baselineBytes || !candidateBytes)
        throw new Error(
          "The session archive is missing a required model resource.",
        );
      const { baseline: baselineModelResult, candidate: candidateModelResult } =
        await reimportSessionModels(
          sessionImportSpecFor(baselineModel, baselineBytes),
          sessionImportSpecFor(candidateModel, candidateBytes),
          setOpenProgress,
          controller.signal,
        );
      setSourceModels({ baseline: baselineBytes, candidate: candidateBytes });
      setSaveStatus("idle");
      setSaveError(undefined);
      setExportStatus("idle");
      setExportError(undefined);
      setResult({
        baseline: baselineModelResult,
        candidate: candidateModelResult,
        analysis: report.analysis.result,
      });
    } catch (reason) {
      if (reason instanceof ComparisonCancelledError) {
        setNotice("Session open cancelled.");
      } else {
        setOpenError(describeSessionFailure(reason, "open"));
      }
    } finally {
      setOpenProgress(undefined);
      if (activeOpenRunRef.current === controller)
        activeOpenRunRef.current = null;
    }
  };

  const handleSaveSession = (summary: ModelComparisonPresentationSummary) => {
    if (!result || !sourceModels || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaveStatus("saving");
    setSaveError(undefined);
    void (async () => {
      try {
        const saved = await saveSession({
          baseline: result.baseline,
          candidate: result.candidate,
          analysis: result.analysis,
          summary,
          sourceModels,
        });
        downloadSessionArchive(saved);
        setSaveStatus("idle");
      } catch (reason) {
        setSaveStatus("error");
        setSaveError(describeSessionFailure(reason, "save"));
      } finally {
        saveInFlightRef.current = false;
      }
    })();
  };

  // Building and rendering a `Report` (`buildComparisonReport` and
  // `renderReportHtml`) is synchronous and pure; the only asynchronous
  // dependency is the presentation summary the caller already waited for
  // before invoking this. `id` uses a fresh `crypto.randomUUID()` -- unlike
  // a saved session, an interactive export has no determinism requirement,
  // and each export is a distinct document the user is choosing to create
  // right now -- mapped into the contract's entity-id format with the
  // report engine's own `boundedEntityId` helper. `createdAt` is the real
  // wall-clock time: the engine itself never reads a clock, so supplying it
  // here is exactly the caller-side policy `buildComparisonReport` expects,
  // and "when this document was produced" is honest, useful metadata for an
  // exported artifact (unlike a session archive, which must stay
  // byte-identical across resaves; see `session.ts`).
  const handleExportReport = (summary: ModelComparisonPresentationSummary) => {
    if (!result || exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setExportStatus("exporting");
    setExportError(undefined);
    try {
      const report = buildComparisonReport({
        id: brandId<Report["id"]>(
          boundedEntityId("report", crypto.randomUUID()),
        ),
        createdAt: new Date().toISOString(),
        baseline: result.baseline,
        candidate: result.candidate,
        analysis: result.analysis,
        summary,
      });
      downloadReportHtml(report, renderReportHtml(report));
      setExportStatus("idle");
    } catch (reason) {
      setExportStatus("error");
      setExportError(describeReportFailure(reason));
    } finally {
      exportInFlightRef.current = false;
    }
  };

  if (result)
    return (
      <Suspense
        fallback={
          <div className="workbench-loading" role="status">
            Preparing synchronized 3D views…
          </div>
        }
      >
        <Workbench
          baseline={result.baseline}
          candidate={result.candidate}
          analysis={result.analysis}
          sessionPanel={{
            onSave: handleSaveSession,
            status: saveStatus,
            error: saveError,
          }}
          reportPanel={{
            onExport: handleExportReport,
            status: exportStatus,
            error: exportError,
          }}
          onReset={() => {
            setResult(undefined);
            setError(undefined);
            setNotice(undefined);
            setOpenError(undefined);
            setSourceModels(undefined);
            setSaveStatus("idle");
            setSaveError(undefined);
            setExportStatus("idle");
            setExportError(undefined);
          }}
        />
      </Suspense>
    );

  return (
    <div className="page shell">
      <header className="page-hero">
        <span className="eyebrow">Private comparison</span>
        <h1>Start with two models</h1>
        <p>
          Choose a trusted baseline and a candidate revision. Import and
          analysis run in a dedicated browser worker; model data is not
          uploaded.
        </p>
      </header>
      <section
        className="session-open-card"
        aria-labelledby="session-open-title"
      >
        <div className="section-heading">
          <span className="step">Optional</span>
          <h2 id="session-open-title">Reopen a saved session</h2>
          <p>
            Already saved a comparison as a <code>.voxelspy</code> file? Open it
            to restore the workbench directly, with the same models and analysis
            result, without re-running the analysis.
          </p>
        </div>
        <label className="session-open-input" htmlFor="session-open-file">
          <span>
            {openProgress
              ? openProgress.message
              : "Choose a .voxelspy session file"}
          </span>
          <input
            id="session-open-file"
            type="file"
            accept=".voxelspy"
            disabled={Boolean(progress) || Boolean(openProgress)}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void openSessionFile(file);
            }}
          />
          <span className="button button-secondary" aria-hidden="true">
            Browse this device
          </span>
        </label>
        {openError && (
          <div className="comparison-error" role="alert">
            <strong>Session could not be opened</strong>
            <p>{openError}</p>
          </div>
        )}
      </section>
      <section className="comparison-card" aria-labelledby="choose-title">
        <div className="section-heading">
          <span className="step">Step 01</span>
          <h2 id="choose-title">Choose source files</h2>
          <p>
            Select two supported files to compare immediately using common
            millimetre and right-handed Z-up defaults. If a source uses a
            different frame, adjust its Expert settings first.
          </p>
        </div>
        {!capability.analysisSupported && (
          <div className="comparison-error" role="alert">
            <strong>Local comparison is unavailable in this browser</strong>
            <p>{capability.blockingMessage}</p>
          </div>
        )}
        <div className="file-grid">
          <SourceCard
            role="Baseline"
            selection={baseline}
            update={setBaseline}
          />
          <SourceCard
            role="Candidate"
            selection={candidate}
            update={setCandidate}
          />
        </div>
        <section className="method-card" aria-labelledby="method-title">
          <div>
            <span className="eyebrow">Analysis method</span>
            <h3 id="method-title">Sampled surface distance</h3>
          </div>
          <p>
            Approximate, tessellation-dependent comparison at a 0.1 mm distance
            tolerance. Preconditions and uncertainty remain attached to the
            result.
          </p>
          <div className="analysis-capacity">
            <label htmlFor="analysis-memory">
              Analysis RAM allowance
              <output htmlFor="analysis-memory">{analysisMemoryMiB} MiB</output>
            </label>
            <input
              id="analysis-memory"
              type="range"
              min={ANALYSIS_MEMORY_MIN_MIB}
              max={ANALYSIS_MEMORY_MAX_MIB}
              step={ANALYSIS_MEMORY_STEP_MIB}
              value={analysisMemoryMiB}
              onChange={(event) =>
                setAnalysisMemoryMiB(Number(event.currentTarget.value))
              }
              aria-describedby={
                capability.memoryNotes.length > 0
                  ? "analysis-memory-help analysis-memory-recommendation"
                  : "analysis-memory-help"
              }
            />
            <small id="analysis-memory-help">
              This is a ceiling, not preallocated memory. Raising it also gives
              the local worker more compute time; large settings may slow or
              destabilize this tab. The starting value above is a recommendation
              for this device, not a hard limit -- move the slider to use any
              allowance in its range.
            </small>
            {capability.memoryNotes.length > 0 && (
              <small id="analysis-memory-recommendation">
                {capability.memoryNotes.join(" ")}
              </small>
            )}
            {fitEstimate?.likelyExceedsAllowance && (
              <p className="capability" role="status">
                <i />
                Estimated analysis memory need is roughly{" "}
                {fitEstimate.estimatedMiB} MiB for the selected files, above the{" "}
                {analysisMemoryMiB} MiB allowance. This is a rough estimate, not
                a guarantee -- raise the allowance or expect the comparison to
                stop with a resource-budget message.
              </p>
            )}
          </div>
        </section>
        <div className="comparison-status" aria-live="polite">
          <span className={ready ? "status-ready" : ""}>
            {progress?.message ??
              notice ??
              (ready
                ? "Inputs pass capability preflight"
                : !capability.analysisSupported
                  ? "Comparison disabled: see the browser support notice above"
                  : "Choose both source files")}
          </span>
          <div className="actions">
            {progress && (
              <button
                className="button button-secondary"
                type="button"
                onClick={cancel}
              >
                Cancel comparison
              </button>
            )}
            <button
              className="button button-primary"
              type="button"
              disabled={!ready}
              onClick={() => void compare()}
            >
              {progress ? "Comparing locally…" : "Validate and compare"}
            </button>
          </div>
        </div>
        {error && (
          <div className="comparison-error" role="alert">
            <strong>Comparison could not continue</strong>
            <p>{error}</p>
          </div>
        )}
        <p className="boundary-note">
          <strong>Local boundary:</strong> source bytes, normalized geometry,
          and analysis remain in this browser. No network-backed model service
          is part of this workflow.
        </p>
      </section>
    </div>
  );
}
