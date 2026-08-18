import type { ClearanceState, ClearanceTightRegion } from "@voxelspy/analysis";
import type { Mat4, SourceAxis, SourceUnit, Vec3 } from "@voxelspy/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import {
  buildPlacementMatrix,
  IDENTITY_PLACEMENT,
  isIdentityPlacement,
  type PartPlacement,
} from "./clearance-placement";
import {
  checkClearanceAsync,
  ClearanceCancelledError,
  type CheckClearanceSource,
  type ClearanceOutcome,
} from "./clearance-worker-client";
import { ToolShell } from "./ToolShell";
import { DEFAULT_ANALYSIS_MEMORY_MIB } from "./worker-client";

/**
 * `/tools/clearance-fit/`: will two independently, deliberately placed parts
 * fit? Imports both parts through the same `@voxelspy/importers` `importModel`
 * every other tool in this app uses, then runs `checkClearance`
 * (`@voxelspy/analysis`) in its own dedicated worker channel
 * (`clearance-worker-client.ts`). Placement is always explicit: both parts
 * start at the identity transform and only move in response to a numeric
 * translation/rotation the user enters -- this page never auto-positions or
 * auto-aligns either part, matching `checkClearance`'s own contract.
 */

const ClearanceViewer = lazy(async () => {
  const module = await import("./ClearanceViewer");
  return { default: module.ClearanceViewer };
});

type ResolvedSourceUnit = Exclude<SourceUnit, "unknown">;
type ResolvedSourceAxis = Exclude<SourceAxis, "unknown">;

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

interface PartSelection {
  file: File | null;
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
  frameSource: "default" | "expert";
  placement: PartPlacement;
}

const defaultSourceFrame = {
  unit: "millimetre",
  axis: "right-handed-z-up",
  frameSource: "default",
} as const satisfies Pick<PartSelection, "unit" | "axis" | "frameSource">;

/** Choosing (or replacing) a file always starts from a clean slate: import
 *  defaults and the identity placement, exactly like every other tool in
 *  this app resets its unit/axis defaults on file choice. Placement is never
 *  carried over from a previous file. */
export function partSelectionForFile(file: File | null): PartSelection {
  return { file, ...defaultSourceFrame, placement: IDENTITY_PLACEMENT };
}

function placementIsNumeric(placement: PartPlacement): boolean {
  return [
    ...placement.translationMillimetres,
    ...placement.rotationDegrees,
  ].every((value) => Number.isFinite(value));
}

/** Same preconditions as Inspect's, Forensics', and Compare's own
 *  `*Capability` checks (this release's one importer applies uniformly),
 *  plus a placement precondition none of those tools have: every
 *  translation/rotation field must hold a real number before a run starts. */
export function partSourceCapability(selection: PartSelection) {
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
  if (!placementIsNumeric(selection.placement))
    return {
      ready: false,
      message:
        "Enter a numeric value for every translation and rotation field.",
    };
  return {
    ready: true,
    message: isIdentityPlacement(selection.placement)
      ? "Ready, at the identity placement (not moved)."
      : "Ready, at the placement set below.",
  };
}

export function desiredClearanceCapability(value: number) {
  if (!Number.isFinite(value))
    return {
      ready: false,
      message: "Enter the desired clearance in millimetres.",
    };
  if (value < 0)
    return {
      ready: false,
      message: "Desired clearance must be zero or greater.",
    };
  return { ready: true, message: "" };
}

// ---------------------------------------------------------------------------
// Presentation helpers. Deliberately duplicated from (rather than imported
// out of) InspectFlow.tsx/ForensicsFlow.tsx, matching the precedent those two
// already set for this small, pure formatting logic.
// ---------------------------------------------------------------------------

function conciseNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  }).format(value);
}

/** Matrix display: up to 6 fraction digits, enough to show a sub-millimetre
 *  translation or a rotated axis component exactly without noise on the
 *  common integer entries (0, 1, -1). Matches ForensicsFlow's own
 *  `formatNumber`. */
function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(
    value,
  );
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
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

function pointLabel(point: Vec3): string {
  return `(${point.map(conciseNumber).join(", ")}) mm`;
}

function partLabel(part: "first" | "second"): string {
  return part === "first" ? "First part" : "Second part";
}

function clearanceStatePresentation(state: ClearanceState): {
  className: string;
  label: string;
  detail: string;
} {
  if (state === "clear")
    return {
      className: "clearance-clear",
      label: "Clear",
      detail:
        "The sampled minimum distance meets or exceeds the requested clearance.",
    };
  if (state === "tight")
    return {
      className: "clearance-tight",
      label: "Tight",
      detail:
        "The sampled minimum distance is positive but below the requested clearance.",
    };
  return {
    className: "clearance-interfering",
    label: "Interfering",
    detail:
      "An exact triangle-triangle intersection was found, or the sampled minimum distance is exactly zero.",
  };
}

function indeterminateCodeLabel(code: string): string {
  return (
    {
      "invalid-desired-clearance": "Invalid desired clearance",
      "resource-budget-exceeded": "Resource budget exceeded",
      "clearance-precondition-failed": "Clearance preconditions failed",
      "comparison-transform-failed": "Placement transform failed",
      "numeric-range-exceeded": "Numeric range exceeded",
      "internal-error": "Unexpected internal error",
    }[code] ?? code.replaceAll("-", " ")
  );
}

// ---------------------------------------------------------------------------
// Source + placement card
// ---------------------------------------------------------------------------

const translationAxes: { label: string; index: 0 | 1 | 2 }[] = [
  { label: "X", index: 0 },
  { label: "Y", index: 1 },
  { label: "Z", index: 2 },
];

function PlacementFields({
  idBase,
  placement,
  update,
}: {
  idBase: string;
  placement: PartPlacement;
  update: (placement: PartPlacement) => void;
}) {
  const identity = isIdentityPlacement(placement);
  const matrix = buildPlacementMatrix(placement);
  const setAxisValue = (
    field: "translationMillimetres" | "rotationDegrees",
    index: 0 | 1 | 2,
    value: number,
  ) => {
    const next: Vec3 = [...placement[field]];
    next[index] = value;
    update({ ...placement, [field]: next });
  };
  return (
    <details className="placement-card" open={!identity}>
      <summary>Placement (optional)</summary>
      <p>
        This part starts at the identity placement -- not moved -- unless you
        set a translation or rotation below. VoxelSpy never auto-positions or
        auto-aligns either part: this is the only way a part&rsquo;s placement
        changes, and the resulting transform is shown below for audit.
      </p>
      <div className="placement-grid">
        <fieldset>
          <legend>Translation (mm)</legend>
          {translationAxes.map(({ label, index }) => (
            <label
              key={label}
              htmlFor={`${idBase}-translate-${label.toLowerCase()}`}
            >
              {label}
              <input
                id={`${idBase}-translate-${label.toLowerCase()}`}
                type="number"
                step="any"
                value={
                  Number.isFinite(placement.translationMillimetres[index])
                    ? placement.translationMillimetres[index]
                    : ""
                }
                onChange={(event) =>
                  setAxisValue(
                    "translationMillimetres",
                    index,
                    event.currentTarget.valueAsNumber,
                  )
                }
              />
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Rotation (degrees, about X then Y then Z)</legend>
          {translationAxes.map(({ label, index }) => (
            <label
              key={label}
              htmlFor={`${idBase}-rotate-${label.toLowerCase()}`}
            >
              {label}
              <input
                id={`${idBase}-rotate-${label.toLowerCase()}`}
                type="number"
                step="any"
                value={
                  Number.isFinite(placement.rotationDegrees[index])
                    ? placement.rotationDegrees[index]
                    : ""
                }
                onChange={(event) =>
                  setAxisValue(
                    "rotationDegrees",
                    index,
                    event.currentTarget.valueAsNumber,
                  )
                }
              />
            </label>
          ))}
        </fieldset>
      </div>
      <p className="placement-transform">
        <strong>
          Applied transform{identity ? " (identity -- not moved)" : ""}:
        </strong>{" "}
        <code>{matrix.map(formatNumber).join(" ")}</code>
      </p>
    </details>
  );
}

function PartCard({
  role,
  selection,
  update,
}: {
  role: "First part" | "Second part";
  selection: PartSelection;
  update: (selection: PartSelection) => void;
}) {
  const capability = partSourceCapability(selection);
  const idBase = role === "First part" ? "first" : "second";
  return (
    <fieldset className="source-card">
      <legend>{role}</legend>
      <label className="source-file" htmlFor={`${idBase}-file`}>
        <span>{selection.file?.name ?? "Choose a model"}</span>
        <small>
          {selection.file
            ? `${(selection.file.size / 1024).toFixed(1)} KiB · local file`
            : "STL or OBJ, up to 32 MiB"}
        </small>
        <input
          id={`${idBase}-file`}
          type="file"
          accept=".stl,.obj"
          onChange={(event) =>
            update(partSelectionForFile(event.currentTarget.files?.[0] ?? null))
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
          The selected values are recorded with the check.
        </p>
        <div className="source-frame">
          <label>
            Source unit
            <select
              value={selection.unit}
              onChange={(event) =>
                update({
                  ...selection,
                  unit: event.currentTarget.value as PartSelection["unit"],
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
                  axis: event.currentTarget.value as PartSelection["axis"],
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
      <PlacementFields
        idBase={idBase}
        placement={selection.placement}
        update={(placement) => update({ ...selection, placement })}
      />
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
// Report rendering
// ---------------------------------------------------------------------------

function TightRegionsSection({
  regions,
  detectedRegionCount,
  truncated,
}: {
  regions: readonly ClearanceTightRegion[];
  detectedRegionCount: number;
  truncated: boolean;
}) {
  return (
    <section aria-labelledby="clearance-tight-regions-title">
      <h3 id="clearance-tight-regions-title">
        Tight regions ({detectedRegionCount})
      </h3>
      {regions.length === 0 ? (
        <p className="empty-findings">No tight regions found.</p>
      ) : (
        <ol className="diagnostic-list">
          {regions.map((region) => (
            <li key={region.id}>
              <div className="topology-item">
                <div className="topology-item-head">
                  <i aria-hidden="true" />
                  <strong>{partLabel(region.part)}</strong>
                  <span>
                    {conciseNumber(region.minimumDistanceMillimetres)} mm apart
                  </span>
                </div>
                <p>
                  {conciseNumber(region.areaSquareMillimetres)} mm² ·{" "}
                  {region.triangleCount} triangle
                  {region.triangleCount === 1 ? "" : "s"} · anchored near{" "}
                  {pointLabel(region.anchor)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {truncated && (
        <p className="topology-truncated">
          Showing {regions.length} of {detectedRegionCount} tight regions.
        </p>
      )}
    </section>
  );
}

function ClearanceReport({
  outcome,
  firstMeta,
  secondMeta,
  desiredClearanceMillimetres,
  onReset,
}: {
  outcome: ClearanceOutcome;
  firstMeta: { name: string; size: number; modelToComparison: Mat4 };
  secondMeta: { name: string; size: number; modelToComparison: Mat4 };
  desiredClearanceMillimetres: number;
  onReset: () => void;
}) {
  const { result } = outcome;
  const title = `${firstMeta.name} vs ${secondMeta.name}`;

  if (result.state === "indeterminate") {
    const indeterminate = result;
    return (
      <div className="inspect-report">
        <header className="inspect-report-header">
          <div>
            <h2>{title}</h2>
            <p>No fit verdict could be produced for this pair.</p>
          </div>
          <button
            className="button button-secondary"
            type="button"
            onClick={onReset}
          >
            Check another pair
          </button>
        </header>
        <section aria-labelledby="clearance-indeterminate-title">
          <h3 id="clearance-indeterminate-title">
            {indeterminateCodeLabel(indeterminate.code)}
          </h3>
          <div className="comparison-error" role="alert">
            <strong>This pair could not be checked.</strong>
            <ul>
              {indeterminate.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </div>
          {indeterminate.validation.length > 0 && (
            <dl className="provenance-list">
              {indeterminate.validation.map((assessment) => (
                <div key={assessment.modelId}>
                  <dt>{assessment.modelId}</dt>
                  <dd>
                    {assessment.reasons.length > 0
                      ? assessment.reasons
                          .map((reason) => reason.replaceAll("-", " "))
                          .join(", ")
                      : "No specific reasons recorded."}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    );
  }

  const badge = clearanceStatePresentation(result.state);
  const undersampledWarning = result.warnings.find(
    (warning) => warning.code === "clearance.undersampled",
  );
  const otherWarnings = result.warnings.filter(
    (warning) => warning.code !== "clearance.undersampled",
  );

  return (
    <div className="inspect-report">
      <header className="inspect-report-header">
        <div>
          <h2>{title}</h2>
          <p>
            {formatFileSize(firstMeta.size)} vs{" "}
            {formatFileSize(secondMeta.size)} · desired clearance{" "}
            {conciseNumber(desiredClearanceMillimetres)} mm
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={onReset}
        >
          Check another pair
        </button>
      </header>

      <section aria-labelledby="clearance-verdict-title">
        <h3 id="clearance-verdict-title">Fit verdict</h3>
        <div className={`watertight-badge clearance-badge ${badge.className}`}>
          <i aria-hidden="true" />
          <p>
            <strong>{badge.label}</strong>
            <span>{badge.detail}</span>
          </p>
        </div>
        <p className="inspect-semantics-note">
          Interference evidence (intersecting triangle pairs) is exact,
          independent of tessellation. The minimum distance, closest points, and
          tight regions below are sampled at each surface&rsquo;s own triangle
          vertices and centroids, exactly like the surface-distance comparison
          method: a smaller true minimum distance can exist between samples.
        </p>
        {undersampledWarning && (
          <div className="clearance-caveat" role="note">
            <strong>
              Sampling caveat
              {result.state === "clear"
                ? ": this “Clear” verdict is not a geometric guarantee at this tessellation"
                : ""}
            </strong>
            <p>{undersampledWarning.message}</p>
          </div>
        )}
      </section>

      <section
        className="geometry-summary"
        aria-labelledby="clearance-distance-title"
      >
        <h3 id="clearance-distance-title">Minimum distance</h3>
        <div className="geometry-table geometry-table-2col" role="table">
          <div className="geometry-table-head" role="row">
            <span role="columnheader">Measure</span>
            <span role="columnheader">Value</span>
          </div>
          <div role="row">
            <strong role="rowheader">Minimum distance</strong>
            <span>{conciseNumber(result.minimumDistanceMillimetres)} mm</span>
          </div>
          <div role="row">
            <strong role="rowheader">Desired clearance</strong>
            <span>{conciseNumber(result.desiredClearanceMillimetres)} mm</span>
          </div>
          <div role="row">
            <strong role="rowheader">Closest point, first part</strong>
            <span>{pointLabel(result.closestPoints.first)}</span>
          </div>
          <div role="row">
            <strong role="rowheader">Closest point, second part</strong>
            <span>{pointLabel(result.closestPoints.second)}</span>
          </div>
        </div>
      </section>

      <TightRegionsSection
        regions={result.tightRegions.regions}
        detectedRegionCount={result.tightRegions.detectedRegionCount}
        truncated={result.tightRegions.truncated}
      />

      <section aria-labelledby="clearance-interference-title">
        <h3 id="clearance-interference-title">Interference</h3>
        <p>
          {result.interference.detectedPairCount === 0
            ? "No intersecting triangle pairs were found."
            : `${result.interference.detectedPairCount} intersecting triangle pair${result.interference.detectedPairCount === 1 ? "" : "s"} found, confirmed by an exact triangle-triangle intersection test.`}
        </p>
        {result.interference.truncated && (
          <p className="topology-truncated">
            Showing {result.interference.trianglePairs.length} of{" "}
            {result.interference.detectedPairCount} intersecting triangle pairs.
          </p>
        )}
        <p className="inspect-semantics-note">
          <strong>No interference volume is computed.</strong>{" "}
          {result.interference.volume.reason}
        </p>
      </section>

      {otherWarnings.length > 0 && (
        <section aria-labelledby="clearance-warnings-title">
          <h3 id="clearance-warnings-title">Warnings</h3>
          <div className="provenance-warnings">
            <ul>
              {otherWarnings.map((warning, index) => (
                <li key={index}>
                  <code>{warning.code}</code> — {warning.message}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <Suspense
        fallback={
          <div className="workbench-loading" role="status">
            Preparing the 3D fit preview…
          </div>
        }
      >
        <ClearanceViewer
          first={{
            model: outcome.first.model,
            modelToComparison: firstMeta.modelToComparison,
          }}
          second={{
            model: outcome.second.model,
            modelToComparison: secondMeta.modelToComparison,
          }}
          result={result}
          accessibleLabel={`3D preview of ${firstMeta.name} and ${secondMeta.name} showing their placement, the closest-point measurement, and any tight or interfering regions. Not a substitute for the report above.`}
        />
      </Suspense>

      <details className="technical-details">
        <summary>Placement &amp; provenance</summary>
        {(
          [
            ["first", firstMeta, outcome.first] as const,
            ["second", secondMeta, outcome.second] as const,
          ] as const
        ).map(([part, meta, partOutcome]) => (
          <section key={part}>
            <h4>{partLabel(part)}</h4>
            <dl className="provenance-list">
              <div>
                <dt>Source file</dt>
                <dd>{meta.name}</dd>
              </div>
              <div>
                <dt>Resolved unit</dt>
                <dd>
                  {unitLabel(partOutcome.model.provenance.sourceUnit)} (
                  {originLabel(
                    partOutcome.model.provenance.sourceResolution.unit,
                  )}
                  )
                </dd>
              </div>
              <div>
                <dt>Resolved up-axis</dt>
                <dd>
                  {axisLabel(partOutcome.model.provenance.sourceAxis)} (
                  {originLabel(
                    partOutcome.model.provenance.sourceResolution.axis,
                  )}
                  )
                </dd>
              </div>
              <div>
                <dt>Applied placement transform</dt>
                <dd>
                  <code>
                    {meta.modelToComparison.map(formatNumber).join(" ")}
                  </code>
                </dd>
              </div>
            </dl>
            {partOutcome.warnings.length > 0 && (
              <div className="provenance-warnings">
                <strong>Import warnings</strong>
                <ul>
                  {partOutcome.warnings.map((warning, index) => (
                    <li key={index}>
                      <code>{warning.code}</code> — {warning.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))}
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const INITIAL_CAPABILITY: CapabilityPreflight = {
  recommendedAnalysisMemoryMiB: DEFAULT_ANALYSIS_MEMORY_MIB,
  memoryNotes: [],
  workersAvailable: true,
  webglAvailable: true,
  analysisSupported: true,
  blockingMessage: undefined,
};

export function ClearanceFlow() {
  const [firstSelection, setFirstSelection] = useState(
    partSelectionForFile(null),
  );
  const [secondSelection, setSecondSelection] = useState(
    partSelectionForFile(null),
  );
  const [desiredClearance, setDesiredClearance] = useState(1);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [outcome, setOutcome] = useState<ClearanceOutcome>();
  const [runMeta, setRunMeta] = useState<{
    first: { name: string; size: number; modelToComparison: Mat4 };
    second: { name: string; size: number; modelToComparison: Mat4 };
    desiredClearanceMillimetres: number;
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

  const firstCapability = partSourceCapability(firstSelection);
  const secondCapability = partSourceCapability(secondSelection);
  const clearanceCapability = desiredClearanceCapability(desiredClearance);
  const ready =
    firstCapability.ready &&
    secondCapability.ready &&
    clearanceCapability.ready &&
    !progress &&
    capability.analysisSupported;

  const check = async () => {
    if (!ready || !firstSelection.file || !secondSelection.file) return;
    activeRunRef.current?.abort();
    const controller = new AbortController();
    activeRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setProgress("Reading and checking both parts locally");
    const firstMatrix = buildPlacementMatrix(firstSelection.placement);
    const secondMatrix = buildPlacementMatrix(secondSelection.placement);
    try {
      const source: CheckClearanceSource = {
        first: {
          file: firstSelection.file,
          unit: firstSelection.unit as ResolvedSourceUnit,
          axis: firstSelection.axis as ResolvedSourceAxis,
          frameSource: firstSelection.frameSource,
          modelToComparison: firstMatrix,
        },
        second: {
          file: secondSelection.file,
          unit: secondSelection.unit as ResolvedSourceUnit,
          axis: secondSelection.axis as ResolvedSourceAxis,
          frameSource: secondSelection.frameSource,
          modelToComparison: secondMatrix,
        },
        desiredClearanceMillimetres: desiredClearance,
      };
      const result = await checkClearanceAsync(source, controller.signal);
      setOutcome(result);
      setRunMeta({
        first: {
          name: firstSelection.file.name,
          size: firstSelection.file.size,
          modelToComparison: firstMatrix,
        },
        second: {
          name: secondSelection.file.name,
          size: secondSelection.file.size,
          modelToComparison: secondMatrix,
        },
        desiredClearanceMillimetres: desiredClearance,
      });
    } catch (reason) {
      if (reason instanceof ClearanceCancelledError) {
        setNotice("Clearance check cancelled.");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Clearance check failed safely.",
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
    setRunMeta(undefined);
    setError(undefined);
    setNotice(undefined);
    setFirstSelection(partSelectionForFile(null));
    setSecondSelection(partSelectionForFile(null));
  };

  return (
    <ToolShell
      eyebrow="Clearance & Fit"
      title="Will these two parts fit?"
      description="Choose two local models, place each one deliberately, and check the gap or interference between them: minimum clearance with its closest-point pair, ranked tight regions, and exact triangle-pair interference evidence."
    >
      {outcome && runMeta ? (
        <ClearanceReport
          outcome={outcome}
          firstMeta={runMeta.first}
          secondMeta={runMeta.second}
          desiredClearanceMillimetres={runMeta.desiredClearanceMillimetres}
          onReset={reset}
        />
      ) : (
        <section
          className="comparison-card"
          aria-labelledby="clearance-choose-title"
        >
          <div className="section-heading">
            <span className="step">Step 01</span>
            <h2 id="clearance-choose-title">Choose both parts</h2>
            <p>
              Select two supported files. Each part starts at the identity
              placement -- not moved, not aligned to the other -- until you set
              an explicit translation or rotation for it below.
            </p>
          </div>
          {!capability.analysisSupported && (
            <div className="comparison-error" role="alert">
              <strong>
                Local clearance checking is unavailable in this browser
              </strong>
              <p>{capability.blockingMessage}</p>
            </div>
          )}
          <div className="file-grid">
            <PartCard
              role="First part"
              selection={firstSelection}
              update={setFirstSelection}
            />
            <PartCard
              role="Second part"
              selection={secondSelection}
              update={setSecondSelection}
            />
          </div>
          <section
            className="method-card"
            aria-labelledby="clearance-method-title"
          >
            <div>
              <span className="eyebrow">Desired clearance</span>
              <h3 id="clearance-method-title">Minimum acceptable gap</h3>
            </div>
            <p>
              The minimum surface-to-surface distance you want between the two
              parts, in millimetres. Zero means the parts must not touch.
            </p>
            <div className="clearance-desired-input">
              <label htmlFor="desired-clearance">
                Desired clearance (mm)
                <input
                  id="desired-clearance"
                  type="number"
                  step="any"
                  min="0"
                  value={
                    Number.isFinite(desiredClearance) ? desiredClearance : ""
                  }
                  onChange={(event) =>
                    setDesiredClearance(event.currentTarget.valueAsNumber)
                  }
                />
              </label>
              {!clearanceCapability.ready && clearanceCapability.message && (
                <p className="capability">
                  <i />
                  {clearanceCapability.message}
                </p>
              )}
            </div>
          </section>
          <div className="comparison-status" aria-live="polite">
            <span className={ready ? "status-ready" : ""}>
              {progress ??
                notice ??
                (ready
                  ? "Inputs pass capability preflight"
                  : !capability.analysisSupported
                    ? "Clearance checking disabled: see the browser support notice above"
                    : "Choose both source files")}
            </span>
            <div className="actions">
              {progress && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={cancel}
                >
                  Cancel check
                </button>
              )}
              <button
                className="button button-primary"
                type="button"
                disabled={!ready}
                onClick={() => void check()}
              >
                {progress ? "Checking locally…" : "Check clearance"}
              </button>
            </div>
          </div>
          {error && (
            <div className="comparison-error" role="alert">
              <strong>Clearance check could not continue</strong>
              <p>{error}</p>
            </div>
          )}
          <p className="boundary-note">
            <strong>Local boundary:</strong> both source files and their
            geometry stay inside this browser's dedicated clearance worker; only
            the structured report leaves the worker, and nothing is uploaded.
          </p>
        </section>
      )}
    </ToolShell>
  );
}
