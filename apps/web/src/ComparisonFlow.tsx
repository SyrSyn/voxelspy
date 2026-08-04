import type { SourceAxis, SourceUnit } from "@voxelspy/contracts";
import { lazy, Suspense, useMemo, useState } from "react";
import {
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
};

const emptySource = (): SourceSelection => ({ file: null, unit: "", axis: "" });

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
    message: "Supported mesh format with an explicit source frame.",
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
            update({
              ...selection,
              file: event.currentTarget.files?.[0] ?? null,
            })
          }
        />
        <span className="button button-secondary" aria-hidden="true">
          Browse this device
        </span>
      </label>
      <div className="source-frame">
        <label>
          Source unit
          <select
            value={selection.unit}
            onChange={(event) =>
              update({
                ...selection,
                unit: event.currentTarget.value as SourceSelection["unit"],
              })
            }
          >
            <option value="">Choose unit</option>
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
              })
            }
          >
            <option value="">Choose axis</option>
            {axes.map((axis) => (
              <option key={axis.value} value={axis.value}>
                {axis.label}
              </option>
            ))}
          </select>
        </label>
      </div>
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
  const [result, setResult] = useState<CompletedComparison>();
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
    setError(undefined);
    setProgress({ stage: "starting", message: "Starting local comparison" });
    try {
      const next = await runComparison(
        baseline as ComparisonSource,
        candidate as ComparisonSource,
        setProgress,
      );
      setResult(next);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Comparison failed safely.",
      );
    } finally {
      setProgress(undefined);
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
          onReset={() => {
            setResult(undefined);
            setError(undefined);
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
          <h2 id="choose-title">Choose and interpret source files</h2>
          <p>
            STL and OBJ do not carry authoritative units or up-axis metadata.
            Confirm both explicitly before analysis.
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
        </section>
        <div className="comparison-status" aria-live="polite">
          <span className={ready ? "status-ready" : ""}>
            {progress?.message ??
              (ready
                ? "Inputs pass capability preflight"
                : "Complete both source interpretations")}
          </span>
          <button
            className="button button-primary"
            type="button"
            disabled={!ready}
            onClick={() => void compare()}
          >
            {progress ? "Comparing locally…" : "Validate and compare"}
          </button>
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
