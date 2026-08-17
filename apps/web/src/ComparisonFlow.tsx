import type { SourceAxis, SourceUnit } from "@voxelspy/contracts";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ANALYSIS_MEMORY_MAX_MIB,
  ANALYSIS_MEMORY_MIN_MIB,
  ANALYSIS_MEMORY_STEP_MIB,
  ComparisonCancelledError,
  DEFAULT_ANALYSIS_MEMORY_MIB,
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

export function ComparisonFlow() {
  const [baseline, setBaseline] = useState(emptySource);
  const [candidate, setCandidate] = useState(emptySource);
  const [progress, setProgress] = useState<ComparisonProgress>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [result, setResult] = useState<CompletedComparison>();
  const [analysisMemoryMiB, setAnalysisMemoryMiB] = useState(
    DEFAULT_ANALYSIS_MEMORY_MIB,
  );
  const activeRunRef = useRef<AbortController | null>(null);
  const baselineCapability = useMemo(
    () => sourceCapability(baseline),
    [baseline],
  );
  const candidateCapability = useMemo(
    () => sourceCapability(candidate),
    [candidate],
  );
  const ready =
    baselineCapability.ready && candidateCapability.ready && !progress;

  useEffect(() => {
    return () => {
      activeRunRef.current?.abort();
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
    const controller = new AbortController();
    activeRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setProgress({ stage: "starting", message: "Starting local comparison" });
    try {
      const next = await runComparison(
        baseline as ComparisonSource,
        candidate as ComparisonSource,
        setProgress,
        analysisMemoryMiB,
        controller.signal,
      );
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
          onReset={() => {
            setResult(undefined);
            setError(undefined);
            setNotice(undefined);
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
              aria-describedby="analysis-memory-help"
            />
            <small id="analysis-memory-help">
              This is a ceiling, not preallocated memory. Raising it also gives
              the local worker more compute time; large settings may slow or
              destabilize this tab.
            </small>
          </div>
        </section>
        <div className="comparison-status" aria-live="polite">
          <span className={ready ? "status-ready" : ""}>
            {progress?.message ??
              notice ??
              (ready
                ? "Inputs pass capability preflight"
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
