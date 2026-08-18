import {
  DEFAULT_OVERHANG_THRESHOLD_DEGREES_FROM_VERTICAL,
  DEFAULT_THIN_WALL_THRESHOLD_MILLIMETRES,
  MAX_THIN_WALL_THRESHOLD_MILLIMETRES,
  type BuildVolumeCheck,
  type IslandCheck,
  type OverhangCheck,
  type PrintabilityAssessment,
  type PrintabilityWarning,
  type ScaleObservation,
  type WallThicknessCheck,
} from "@voxelspy/analysis";
import type { SourceAxis, SourceUnit, Vec3 } from "@voxelspy/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type CapabilityPreflight,
} from "./capability";
import {
  assessPrintabilitySourceAsync,
  InspectionCancelledError,
  type InspectSource,
  type PrintabilityAssessmentRequestOptions,
  type PrintabilityOutcome,
} from "./inspect-worker-client";
import type {
  PrintabilitySelection,
  PrintabilityVisibleLayers,
} from "./PrintabilityViewer";
import { ToolShell } from "./ToolShell";
import { DEFAULT_ANALYSIS_MEMORY_MIB } from "./worker-client";

/**
 * `/tools/printability/`: loads one local model, runs `assessPrintability`
 * (`@voxelspy/analysis`) in a dedicated worker, and reports its evidence.
 *
 * **Framing (non-negotiable).** This tool reports measured evidence and
 * warnings, never a "will print" verdict -- slicer settings, material, and
 * printer calibration own that conclusion, and this package has no access to
 * any of them. `PrintabilityAssessment.disclaimer` is a structurally required
 * field on the engine's own result type (see `PRINTABILITY_DISCLAIMER`,
 * `@voxelspy/analysis`), and this page shows it verbatim in a prominent
 * banner (`PrintabilityDisclaimer` below) rather than a tooltip or footnote.
 * Every one of the five checks below (`wallThickness`, `overhangs`,
 * `islands`, `buildVolume`, `scale`) is rendered as its own section with its
 * own `semantics` label ("approximate" vs "exact" vs "not configured") and
 * its own warnings -- never collapsed into one badge or one pass/fail
 * outcome, matching `assessPrintability`'s own doc comment that none of its
 * checks is aggregated because each measures a different thing with a
 * different kind of precision.
 *
 * **Worker choice.** Reuses `inspect.worker.ts`'s existing kind-discriminated
 * pattern (a new `"printability"` request kind, see
 * `inspect-worker-client.ts`) rather than a dedicated session-shaped channel
 * like `measure-worker-client.ts`/`clearance-worker-client.ts`.
 * `assessPrintability` is a single bounded pass over one already-imported
 * model -- like `inspectModel`/`diagnoseMeshHealth` -- not an interactive
 * session answering many independent per-query requests against one loaded
 * model the way Measure & Section's snap/section queries or Clearance &
 * Fit's placement queries do. Adjusting a parameter and re-running is simply
 * another one-shot `"printability"` request (see
 * `assessPrintabilitySourceAsync`'s doc comment), the same "re-run on demand"
 * shape `diagnoseModelAsync` already establishes for Inspect's heavier
 * opt-in pass.
 */

const PrintabilityViewer = lazy(async () => {
  const module = await import("./PrintabilityViewer");
  return { default: module.PrintabilityViewer };
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

interface ModelSourceSelection {
  file: File | null;
  unit: ResolvedSourceUnit | "";
  axis: ResolvedSourceAxis | "";
  frameSource: "default" | "expert";
}

const defaultSourceFrame = {
  unit: "millimetre",
  axis: "right-handed-z-up",
  frameSource: "default",
} as const satisfies Pick<
  ModelSourceSelection,
  "unit" | "axis" | "frameSource"
>;

/** Same shape and preconditions as `InspectFlow`'s/`ClearanceFlow`'s/
 *  `MeasureSectionFlow`'s own single-file source selection -- deliberately
 *  duplicated rather than imported, matching the precedent all three already
 *  set for this small, pure logic. */
export function modelSourceSelectionForFile(
  file: File | null,
): ModelSourceSelection {
  return { file, ...defaultSourceFrame };
}

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
        ? "Ready for local assessment using millimetres and right-handed Z-up."
        : "Ready for local assessment using the selected expert source frame.",
  };
}

// ---------------------------------------------------------------------------
// Assessment parameters: thin-wall threshold, overhang angle, build
// direction, and optional build volume. Kept as one local, pure state shape
// (`AssessmentParameters`) separate from `ModelSourceSelection`, mirroring
// `MeasureSectionFlow.tsx`'s own separation between its source card and its
// section-plane controls.
// ---------------------------------------------------------------------------

export type BuildDirectionChoice = "x" | "y" | "z" | "custom";

export interface AssessmentParameters {
  readonly thinThresholdMillimetres: number;
  readonly overhangThresholdDegreesFromVertical: number;
  readonly buildDirectionChoice: BuildDirectionChoice;
  readonly customBuildDirection: Vec3;
  readonly buildVolumeEnabled: boolean;
  readonly buildVolumeDimensionsMillimetres: Vec3;
}

/** Documented defaults: the thin-wall threshold and overhang angle mirror
 *  `assessPrintability`'s own documented defaults
 *  (`DEFAULT_THIN_WALL_THRESHOLD_MILLIMETRES`,
 *  `DEFAULT_OVERHANG_THRESHOLD_DEGREES_FROM_VERTICAL`) rather than duplicating
 *  a different number in this UI; build direction defaults to +Z (up), the
 *  same default `computeOverhangs` uses when no direction is supplied. The
 *  build volume starts unconfigured -- `assessPrintability` has no default
 *  build volume of its own (`buildVolume.semantics` is `"not-configured"`
 *  until one is explicitly supplied), so this form honestly starts the same
 *  way rather than inventing a plausible-looking printer size. */
export const DEFAULT_ASSESSMENT_PARAMETERS: AssessmentParameters = {
  thinThresholdMillimetres: DEFAULT_THIN_WALL_THRESHOLD_MILLIMETRES,
  overhangThresholdDegreesFromVertical:
    DEFAULT_OVERHANG_THRESHOLD_DEGREES_FROM_VERTICAL,
  buildDirectionChoice: "z",
  customBuildDirection: [0, 0, 1],
  buildVolumeEnabled: false,
  buildVolumeDimensionsMillimetres: [0, 0, 0],
};

function axisUnitVector(choice: "x" | "y" | "z"): Vec3 {
  if (choice === "x") return [1, 0, 0];
  if (choice === "y") return [0, 1, 0];
  return [0, 0, 1];
}

function resolveBuildDirection(
  parameters: AssessmentParameters,
): Vec3 | undefined {
  const direction =
    parameters.buildDirectionChoice === "custom"
      ? parameters.customBuildDirection
      : axisUnitVector(parameters.buildDirectionChoice);
  if (!direction.every((value) => Number.isFinite(value))) return undefined;
  if (!(Math.hypot(...direction) > 0)) return undefined;
  return direction;
}

/**
 * Validates and converts the form's `AssessmentParameters` into the wire
 * shape `assessPrintabilitySourceAsync` sends, or `undefined` for any input
 * that cannot become a valid request (a degenerate custom build direction, an
 * out-of-range threshold, or an incomplete/non-positive build volume) -- the
 * caller uses this to disable the "Assess"/"Recompute" action rather than
 * surfacing a thrown error for an incomplete form, mirroring
 * `MeasureSectionFlow.tsx`'s `resolvePlane`.
 */
export function assessmentRequestOptions(
  parameters: AssessmentParameters,
): PrintabilityAssessmentRequestOptions | undefined {
  if (
    !Number.isFinite(parameters.thinThresholdMillimetres) ||
    parameters.thinThresholdMillimetres < 0 ||
    parameters.thinThresholdMillimetres > MAX_THIN_WALL_THRESHOLD_MILLIMETRES
  )
    return undefined;
  if (
    !Number.isFinite(parameters.overhangThresholdDegreesFromVertical) ||
    parameters.overhangThresholdDegreesFromVertical < 0 ||
    parameters.overhangThresholdDegreesFromVertical > 90
  )
    return undefined;
  const buildDirection = resolveBuildDirection(parameters);
  if (!buildDirection) return undefined;
  let buildVolumeDimensionsMillimetres: Vec3 | undefined;
  if (parameters.buildVolumeEnabled) {
    const dims = parameters.buildVolumeDimensionsMillimetres;
    if (!dims.every((value) => Number.isFinite(value) && value > 0))
      return undefined;
    buildVolumeDimensionsMillimetres = dims;
  }
  return {
    thinThresholdMillimetres: parameters.thinThresholdMillimetres,
    overhangThresholdDegreesFromVertical:
      parameters.overhangThresholdDegreesFromVertical,
    buildDirection,
    ...(buildVolumeDimensionsMillimetres === undefined
      ? {}
      : { buildVolumeDimensionsMillimetres }),
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers. Deliberately duplicated from (rather than imported
// out of) InspectFlow.tsx/MeasureSectionFlow.tsx, matching the precedent both
// already set for this small, pure formatting logic.
// ---------------------------------------------------------------------------

function conciseNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  }).format(value);
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function pointLabel(point: Vec3): string {
  return `(${point.map(conciseNumber).join(", ")}) mm`;
}

function warningSeverityLabel(severity: PrintabilityWarning["severity"]) {
  return severity === "warning" ? "Warning" : "Info";
}

function CheckWarnings({
  warnings,
}: {
  warnings: readonly PrintabilityWarning[];
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="clearance-caveat" role="note">
      <strong>
        {warnings.length} notice{warnings.length === 1 ? "" : "s"} for this
        check
      </strong>
      <ul>
        {warnings.map((warning, index) => (
          <li key={index}>
            <strong>{warningSeverityLabel(warning.severity)}:</strong>{" "}
            {warning.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model source card
// ---------------------------------------------------------------------------

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
          The selected values are recorded with the assessment.
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
// Assessment parameters card
// ---------------------------------------------------------------------------

function AssessmentParametersCard({
  parameters,
  update,
}: {
  parameters: AssessmentParameters;
  update: (parameters: AssessmentParameters) => void;
}) {
  const buildDirectionChoices: {
    value: BuildDirectionChoice;
    label: string;
  }[] = [
    { value: "x", label: "X axis" },
    { value: "y", label: "Y axis" },
    { value: "z", label: "Z axis (default)" },
    { value: "custom", label: "Custom direction" },
  ];
  return (
    <fieldset className="method-card printability-parameters">
      <legend>Assessment parameters</legend>
      <div className="placement-grid">
        <fieldset>
          <legend>Thin-wall threshold</legend>
          <label htmlFor="printability-thin-threshold">
            Below this probed thickness, a location is reported (mm)
            <input
              id="printability-thin-threshold"
              type="number"
              step="any"
              min={0}
              max={MAX_THIN_WALL_THRESHOLD_MILLIMETRES}
              value={parameters.thinThresholdMillimetres}
              onChange={(event) =>
                update({
                  ...parameters,
                  thinThresholdMillimetres: event.currentTarget.valueAsNumber,
                })
              }
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Overhang angle</legend>
          <label htmlFor="printability-overhang-threshold">
            Degrees from vertical above which a face is flagged (0-90)
            <input
              id="printability-overhang-threshold"
              type="number"
              step="any"
              min={0}
              max={90}
              value={parameters.overhangThresholdDegreesFromVertical}
              onChange={(event) =>
                update({
                  ...parameters,
                  overhangThresholdDegreesFromVertical:
                    event.currentTarget.valueAsNumber,
                })
              }
            />
          </label>
        </fieldset>
      </div>

      <p className="printability-parameters-label">Build direction</p>
      <div
        className="section-normal-choices"
        role="radiogroup"
        aria-label="Build direction"
      >
        {buildDirectionChoices.map((choice) => (
          <label key={choice.value}>
            <input
              type="radio"
              name="printability-build-direction"
              value={choice.value}
              checked={parameters.buildDirectionChoice === choice.value}
              onChange={() =>
                update({ ...parameters, buildDirectionChoice: choice.value })
              }
            />
            {choice.label}
          </label>
        ))}
      </div>
      {parameters.buildDirectionChoice === "custom" && (
        <div className="placement-grid">
          <fieldset>
            <legend>Custom build direction (need not be unit length)</legend>
            {(["x", "y", "z"] as const).map((axisName, index) => (
              <label
                key={axisName}
                htmlFor={`printability-build-direction-${axisName}`}
              >
                {axisName.toUpperCase()}
                <input
                  id={`printability-build-direction-${axisName}`}
                  type="number"
                  step="any"
                  value={
                    Number.isFinite(parameters.customBuildDirection[index])
                      ? parameters.customBuildDirection[index]
                      : ""
                  }
                  onChange={(event) => {
                    const next: Vec3 = [...parameters.customBuildDirection];
                    next[index] = event.currentTarget.valueAsNumber;
                    update({ ...parameters, customBuildDirection: next });
                  }}
                />
              </label>
            ))}
          </fieldset>
        </div>
      )}

      <label className="printability-build-volume-toggle">
        <input
          type="checkbox"
          checked={parameters.buildVolumeEnabled}
          onChange={(event) =>
            update({
              ...parameters,
              buildVolumeEnabled: event.currentTarget.checked,
            })
          }
        />
        Check against a build volume
      </label>
      {parameters.buildVolumeEnabled && (
        <div className="placement-grid">
          <fieldset>
            <legend>Build volume dimensions (mm)</legend>
            {(["x", "y", "z"] as const).map((axisName, index) => (
              <label
                key={axisName}
                htmlFor={`printability-build-volume-${axisName}`}
              >
                {axisName.toUpperCase()}
                <input
                  id={`printability-build-volume-${axisName}`}
                  type="number"
                  step="any"
                  min={0}
                  value={
                    parameters.buildVolumeDimensionsMillimetres[index] || ""
                  }
                  onChange={(event) => {
                    const next: Vec3 = [
                      ...parameters.buildVolumeDimensionsMillimetres,
                    ];
                    next[index] = event.currentTarget.valueAsNumber;
                    update({
                      ...parameters,
                      buildVolumeDimensionsMillimetres: next,
                    });
                  }}
                />
              </label>
            ))}
          </fieldset>
        </div>
      )}
      <p className="printability-parameters-note">
        These are adjustable, arbitrary inputs -- not a certification against
        any specific printer, material, or slicer profile.
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Disclaimer
// ---------------------------------------------------------------------------

function PrintabilityDisclaimer({ disclaimer }: { disclaimer: string }) {
  return (
    <div
      className="printability-disclaimer"
      role="note"
      aria-labelledby="printability-disclaimer-title"
    >
      <strong id="printability-disclaimer-title">
        This is evidence, not a printability verdict.
      </strong>
      <p>{disclaimer}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wall thickness section
// ---------------------------------------------------------------------------

function WallThicknessSection({
  check,
  warnings,
  selection,
  onSelect,
}: {
  check: WallThicknessCheck;
  warnings: readonly PrintabilityWarning[];
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection | undefined) => void;
}) {
  return (
    <section aria-labelledby="printability-wall-thickness-title">
      <h3 id="printability-wall-thickness-title">Wall thickness</h3>
      <p className="inspect-semantics-note">
        <strong>
          Approximate -- measured along one probe direction per sampled point.
        </strong>{" "}
        Casts one inward ray from each sampled triangle's centroid, along that
        triangle's own inverted normal, and measures the distance to the first
        opposite-surface hit. This is not the true local minimum thickness (a
        thinner path can exist diagonally, e.g. through a corner), and it says
        nothing about a triangle that was never sampled.
      </p>
      <div
        className="geometry-summary"
        aria-labelledby="printability-wall-thickness-stats-title"
      >
        <h4 id="printability-wall-thickness-stats-title">Sampling</h4>
        <div className="geometry-table geometry-table-2col" role="table">
          <div className="geometry-table-head" role="row">
            <span role="columnheader">Measure</span>
            <span role="columnheader">Value</span>
          </div>
          <div role="row">
            <strong role="rowheader">Thin-wall threshold</strong>
            <span>{conciseNumber(check.thinThresholdMillimetres)} mm</span>
          </div>
          <div role="row">
            <strong role="rowheader">Sampled triangles</strong>
            <span>
              {check.sampledTriangleCount} of {check.totalTriangleCount}
            </span>
          </div>
          <div role="row">
            <strong role="rowheader">Unsampled triangles</strong>
            <span>{check.unsampledTriangleCount}</span>
          </div>
          <div role="row">
            <strong role="rowheader">Sample spacing upper bound</strong>
            <span>
              {Number.isFinite(check.sampleSpacingUpperBoundMillimetres)
                ? `${conciseNumber(check.sampleSpacingUpperBoundMillimetres)} mm`
                : "Not applicable (nothing sampled)"}
            </span>
          </div>
          <div role="row">
            <strong role="rowheader">Missed probes</strong>
            <span>{check.missedProbeCount}</span>
          </div>
          <div role="row">
            <strong role="rowheader">Findings detected</strong>
            <span>{check.findingCount}</span>
          </div>
        </div>
      </div>
      <CheckWarnings warnings={warnings} />
      {check.findings.length === 0 ? (
        <p className="empty-findings">
          No probed location fell below the thin-wall threshold. This does not
          rule out a thinner feature outside what was sampled or probed in this
          one inward direction.
        </p>
      ) : (
        <ol className="diagnostic-list">
          {check.findings.map((finding, index) => {
            const isSelected =
              selection?.kind === "thin-wall" && selection.index === index;
            return (
              <li key={index}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelect(
                      isSelected ? undefined : { kind: "thin-wall", index },
                    )
                  }
                >
                  <strong>
                    Finding {index + 1} ·{" "}
                    {conciseNumber(finding.thicknessMillimetres)} mm
                  </strong>
                  <span>{pointLabel(finding.positionMillimetres)}</span>
                  <small>
                    Triangle {finding.triangleIndex} → opposite triangle{" "}
                    {finding.oppositeTriangleIndex} at{" "}
                    {pointLabel(finding.oppositePositionMillimetres)}
                  </small>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {check.truncated && (
        <p className="topology-truncated">
          {check.findingCount - check.findings.length} more not shown.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Overhangs section
// ---------------------------------------------------------------------------

function OverhangsSection({
  check,
  warnings,
  selection,
  onSelect,
}: {
  check: OverhangCheck;
  warnings: readonly PrintabilityWarning[];
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection | undefined) => void;
}) {
  return (
    <section aria-labelledby="printability-overhangs-title">
      <h3 id="printability-overhangs-title">Overhangs</h3>
      <p className="inspect-semantics-note">
        <strong>Exact -- for this tessellated mesh, not sampled.</strong> Every
        triangle's own angle to the build direction is an exact closed-form fact
        about its three vertices; nothing here is sampled or bounded by a
        spacing gap, unlike wall thickness above. This is still a claim about
        the mesh as imported, not the original curved or CAD geometry it may
        approximate.
      </p>
      <div
        className="geometry-summary"
        aria-labelledby="printability-overhangs-stats-title"
      >
        <h4 id="printability-overhangs-stats-title">Overhang area</h4>
        <div className="geometry-table geometry-table-2col" role="table">
          <div className="geometry-table-head" role="row">
            <span role="columnheader">Measure</span>
            <span role="columnheader">Value</span>
          </div>
          <div role="row">
            <strong role="rowheader">Build direction</strong>
            <span>{pointLabel(check.buildDirection)}</span>
          </div>
          <div role="row">
            <strong role="rowheader">Threshold from vertical</strong>
            <span>{conciseNumber(check.thresholdDegreesFromVertical)}°</span>
          </div>
          <div role="row">
            <strong role="rowheader">Overhang area</strong>
            <span>
              {conciseNumber(check.overhangAreaSquareMillimetres)} mm² of{" "}
              {conciseNumber(check.totalSurfaceAreaSquareMillimetres)} mm² (
              {conciseNumber(check.overhangAreaFraction * 100)}%)
            </span>
          </div>
          <div role="row">
            <strong role="rowheader">Regions detected</strong>
            <span>{check.detectedRegionCount}</span>
          </div>
        </div>
      </div>
      <CheckWarnings warnings={warnings} />
      {check.regions.length === 0 ? (
        <p className="empty-findings">
          No triangle's angle from vertical exceeded the threshold above.
        </p>
      ) : (
        <ol className="diagnostic-list">
          {check.regions.map((region, index) => {
            const isSelected =
              selection?.kind === "overhang" && selection.index === index;
            return (
              <li key={region.id}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelect(
                      isSelected ? undefined : { kind: "overhang", index },
                    )
                  }
                >
                  <strong>
                    Region {index + 1} ·{" "}
                    {conciseNumber(region.areaSquareMillimetres)} mm²
                  </strong>
                  <span>
                    Max angle{" "}
                    {conciseNumber(region.maxAngleFromVerticalDegrees)}° from
                    vertical · {region.triangleCount} triangle
                    {region.triangleCount === 1 ? "" : "s"}
                  </span>
                  <small>Anchor {pointLabel(region.anchor)}</small>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {check.truncated && (
        <p className="topology-truncated">
          {check.detectedRegionCount - check.regions.length} more not shown.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Islands section
// ---------------------------------------------------------------------------

function islandVolumeLabel(component: IslandCheck["components"][number]) {
  if (component.volume.available)
    return `${conciseNumber(component.volume.cubicMillimetres)} mm³`;
  return `Unavailable (${component.volume.reasons.join(", ")})`;
}

function IslandsSection({
  check,
  warnings,
  selection,
  onSelect,
}: {
  check: IslandCheck;
  warnings: readonly PrintabilityWarning[];
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection | undefined) => void;
}) {
  return (
    <section aria-labelledby="printability-islands-title">
      <h3 id="printability-islands-title">Islands</h3>
      <p className="inspect-semantics-note">
        <strong>Exact -- connectivity of this tessellated mesh.</strong>{" "}
        Components are exact-coordinate edge-connected triangle groups, the same
        connectivity Inspect's own connected-component count and Compare &amp;
        Clearance's region grouping already use. A stray fragment prints as
        loose, disconnected material, not part of the intended object.
      </p>
      <p>
        <strong>{check.componentCount}</strong> disconnected component
        {check.componentCount === 1 ? "" : "s"} detected.
      </p>
      <CheckWarnings warnings={warnings} />
      {check.components.length === 0 ? (
        <p className="empty-findings">No triangles to evaluate.</p>
      ) : (
        <ol className="diagnostic-list">
          {check.components.map((component, index) => {
            const isSelected =
              selection?.kind === "island" && selection.index === index;
            return (
              <li key={component.id}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelect(isSelected ? undefined : { kind: "island", index })
                  }
                >
                  <strong>
                    Island {index + 1} · {component.triangleCount} triangle
                    {component.triangleCount === 1 ? "" : "s"}
                  </strong>
                  <span>Volume: {islandVolumeLabel(component)}</span>
                  <small>
                    Bounds {pointLabel(component.bounds.min)} →{" "}
                    {pointLabel(component.bounds.max)}
                  </small>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {check.truncated && (
        <p className="topology-truncated">
          {check.componentCount - check.components.length} more not shown.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Build volume section
// ---------------------------------------------------------------------------

const AXIS_LETTERS = ["X", "Y", "Z"] as const;

function orientationLabel(
  modelAxisForBuildAxis: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2],
): string {
  const isAsGiven =
    modelAxisForBuildAxis[0] === 0 &&
    modelAxisForBuildAxis[1] === 1 &&
    modelAxisForBuildAxis[2] === 2;
  const parts = modelAxisForBuildAxis.map(
    (modelAxis, buildAxis) =>
      `Build ${AXIS_LETTERS[buildAxis]} ← model ${AXIS_LETTERS[modelAxis]}`,
  );
  return isAsGiven ? `${parts.join(", ")} (as given)` : parts.join(", ");
}

function BuildVolumeSection({
  check,
  warnings,
}: {
  check: BuildVolumeCheck;
  warnings: readonly PrintabilityWarning[];
}) {
  return (
    <section aria-labelledby="printability-build-volume-title">
      <h3 id="printability-build-volume-title">Build volume fit</h3>
      {check.semantics === "not-configured" ? (
        <>
          <p className="inspect-semantics-note">
            <strong>Not configured.</strong> No build volume was supplied, so no
            fit judgment is made. Model dimensions:{" "}
            {check.dimensionsMillimetres.map(conciseNumber).join(" × ")} mm.
          </p>
          <p>
            Enter build volume dimensions above and reassess to check whether
            this model fits, in any axis-aligned orientation.
          </p>
        </>
      ) : (
        <>
          <p className="inspect-semantics-note">
            <strong>Exact -- axis-aligned fit only, no rotation search.</strong>{" "}
            Only the six axis-order permutations of the model's own axis-aligned
            bounding box are checked against the supplied build volume; an
            arbitrary rotation that might also fit is never searched.
          </p>
          <p>
            Model dimensions:{" "}
            {check.dimensionsMillimetres.map(conciseNumber).join(" × ")} mm ·
            Build volume:{" "}
            {check.buildVolumeDimensionsMillimetres
              .map(conciseNumber)
              .join(" × ")}{" "}
            mm
          </p>
          <p>
            <strong>
              {check.fitsAsGiven
                ? "Fits as currently placed."
                : check.fitsInAnyOrientation
                  ? "Does not fit as given, but fits in another axis-aligned orientation."
                  : "Does not fit in any axis-aligned orientation."}
            </strong>
          </p>
          <CheckWarnings warnings={warnings} />
          <div className="geometry-table" role="table">
            <div className="geometry-table-head" role="row">
              <span role="columnheader">Orientation</span>
              <span role="columnheader">Fits</span>
              <span role="columnheader">Excess (mm)</span>
            </div>
            {check.orientations.map((orientation, index) => (
              <div role="row" key={index}>
                <strong role="rowheader">
                  {orientationLabel(orientation.modelAxisForBuildAxis)}
                </strong>
                <span>{orientation.fits ? "Yes" : "No"}</span>
                <span>
                  {orientation.exceedsByMillimetres
                    .map(conciseNumber)
                    .join(", ")}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Scale observation section
// ---------------------------------------------------------------------------

function ScaleSection({
  scale,
  warnings,
}: {
  scale: ScaleObservation;
  warnings: readonly PrintabilityWarning[];
}) {
  return (
    <section aria-labelledby="printability-scale-title">
      <h3 id="printability-scale-title">Scale observation</h3>
      <p className="inspect-semantics-note">
        <strong>Observation only -- never a unit correction.</strong> This
        package never guesses or changes units; the source unit and detected
        unit below are echoed exactly as import resolved them.
      </p>
      <div className="geometry-table geometry-table-2col" role="table">
        <div className="geometry-table-head" role="row">
          <span role="columnheader">Measure</span>
          <span role="columnheader">Value</span>
        </div>
        <div role="row">
          <strong role="rowheader">Dimensions</strong>
          <span>
            {scale.dimensionsMillimetres.map(conciseNumber).join(" × ")} mm
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Source unit</strong>
          <span>{scale.sourceUnit}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Detected unit</strong>
          <span>{scale.detectedSourceUnit}</span>
        </div>
      </div>
      <CheckWarnings warnings={warnings} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Warnings distributed to their own check, by exact code -- see
// `assessPrintability`'s doc comment: warnings appear "in check order (wall
// thickness, overhangs, islands, build volume, scale)", so each list below is
// an exact-code filter into that same order, never a re-summarized or
// aggregated master list.
// ---------------------------------------------------------------------------

const WALL_THICKNESS_WARNING_CODES = [
  "printability.wall-thickness-undersampled",
  "printability.wall-thickness-probe-missed",
  "printability.wall-thickness-finding-limit",
];
const OVERHANG_WARNING_CODES = ["printability.overhang-region-limit"];
const ISLAND_WARNING_CODES = [
  "printability.island-limit",
  "printability.multiple-islands",
];
const BUILD_VOLUME_WARNING_CODES = [
  "printability.exceeds-build-volume",
  "printability.fits-only-when-reoriented",
];
const SCALE_WARNING_CODES = ["printability.implausible-scale"];

function warningsWithCodes(
  warnings: readonly PrintabilityWarning[],
  codes: readonly string[],
) {
  return warnings.filter((warning) => codes.includes(warning.code));
}

function knownWarningCodes() {
  return [
    ...WALL_THICKNESS_WARNING_CODES,
    ...OVERHANG_WARNING_CODES,
    ...ISLAND_WARNING_CODES,
    ...BUILD_VOLUME_WARNING_CODES,
    ...SCALE_WARNING_CODES,
  ];
}

// ---------------------------------------------------------------------------
// Layer visibility toggles for the 3D view
// ---------------------------------------------------------------------------

function LayerToggles({
  visibleLayers,
  update,
}: {
  visibleLayers: PrintabilityVisibleLayers;
  update: (layers: PrintabilityVisibleLayers) => void;
}) {
  return (
    <fieldset className="printability-layer-toggles">
      <legend>Show in the 3D preview</legend>
      <label>
        <input
          type="checkbox"
          checked={visibleLayers.thinWall}
          onChange={(event) =>
            update({ ...visibleLayers, thinWall: event.currentTarget.checked })
          }
        />
        Thin-wall findings
      </label>
      <label>
        <input
          type="checkbox"
          checked={visibleLayers.overhang}
          onChange={(event) =>
            update({ ...visibleLayers, overhang: event.currentTarget.checked })
          }
        />
        Overhang regions
      </label>
      <label>
        <input
          type="checkbox"
          checked={visibleLayers.island}
          onChange={(event) =>
            update({ ...visibleLayers, island: event.currentTarget.checked })
          }
        />
        Islands
      </label>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function PrintabilityReport({
  outcome,
  sourceMeta,
  onReset,
  parameters,
  onUpdateParameters,
  onRecompute,
  recomputing,
  recomputeError,
  visibleLayers,
  onUpdateVisibleLayers,
  selection,
  onSelect,
}: {
  outcome: PrintabilityOutcome;
  sourceMeta: { name: string; size: number };
  onReset: () => void;
  parameters: AssessmentParameters;
  onUpdateParameters: (parameters: AssessmentParameters) => void;
  onRecompute: () => void;
  recomputing: boolean;
  recomputeError: string | undefined;
  visibleLayers: PrintabilityVisibleLayers;
  onUpdateVisibleLayers: (layers: PrintabilityVisibleLayers) => void;
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection | undefined) => void;
}) {
  const { assessment, model } = outcome;
  const otherWarnings = assessment.warnings.filter(
    (warning) => !knownWarningCodes().includes(warning.code),
  );
  const canRecompute =
    assessmentRequestOptions(parameters) !== undefined && !recomputing;
  return (
    <div className="inspect-report">
      <header className="inspect-report-header">
        <div>
          <h2>{sourceMeta.name}</h2>
          <p>
            {formatFileSize(sourceMeta.size)} · method {assessment.method.id} v
            {assessment.method.version} · reported in millimetres, right-handed
            Z-up
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={onReset}
        >
          Assess another model
        </button>
      </header>

      <PrintabilityDisclaimer disclaimer={assessment.disclaimer} />

      <details className="printability-parameters-details">
        <summary>Assessment parameters</summary>
        <AssessmentParametersCard
          parameters={parameters}
          update={onUpdateParameters}
        />
        <div className="actions">
          <button
            type="button"
            className="button button-primary"
            disabled={!canRecompute}
            onClick={onRecompute}
          >
            {recomputing ? "Reassessing locally…" : "Recompute assessment"}
          </button>
        </div>
        {recomputeError && (
          <div className="comparison-error" role="alert">
            <strong>Assessment could not be recomputed</strong>
            <p>{recomputeError}</p>
          </div>
        )}
      </details>

      <LayerToggles
        visibleLayers={visibleLayers}
        update={onUpdateVisibleLayers}
      />
      <Suspense
        fallback={
          <div className="workbench-loading" role="status">
            Preparing the 3D printability preview…
          </div>
        }
      >
        <PrintabilityViewer
          model={model}
          assessment={assessment}
          visibleLayers={visibleLayers}
          selection={selection}
          onSelect={onSelect}
          accessibleLabel={`3D preview of ${sourceMeta.name} with printability evidence overlaid. Not a substitute for the evidence sections below.`}
        />
      </Suspense>

      <WallThicknessSection
        check={assessment.wallThickness}
        warnings={warningsWithCodes(
          assessment.warnings,
          WALL_THICKNESS_WARNING_CODES,
        )}
        selection={selection}
        onSelect={onSelect}
      />
      <OverhangsSection
        check={assessment.overhangs}
        warnings={warningsWithCodes(
          assessment.warnings,
          OVERHANG_WARNING_CODES,
        )}
        selection={selection}
        onSelect={onSelect}
      />
      <IslandsSection
        check={assessment.islands}
        warnings={warningsWithCodes(assessment.warnings, ISLAND_WARNING_CODES)}
        selection={selection}
        onSelect={onSelect}
      />
      <BuildVolumeSection
        check={assessment.buildVolume}
        warnings={warningsWithCodes(
          assessment.warnings,
          BUILD_VOLUME_WARNING_CODES,
        )}
      />
      <ScaleSection
        scale={assessment.scale}
        warnings={warningsWithCodes(assessment.warnings, SCALE_WARNING_CODES)}
      />

      {otherWarnings.length > 0 && (
        <section aria-labelledby="printability-other-warnings-title">
          <h3 id="printability-other-warnings-title">Other notices</h3>
          <CheckWarnings warnings={otherWarnings} />
        </section>
      )}
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

const DEFAULT_VISIBLE_LAYERS: PrintabilityVisibleLayers = {
  thinWall: true,
  overhang: true,
  island: true,
};

export function PrintabilityFlow() {
  const [selection, setSelection] = useState(modelSourceSelectionForFile(null));
  const [parameters, setParameters] = useState(DEFAULT_ASSESSMENT_PARAMETERS);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [outcome, setOutcome] = useState<PrintabilityOutcome>();
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

  const [recomputing, setRecomputing] = useState(false);
  const [recomputeError, setRecomputeError] = useState<string>();
  const [visibleLayers, setVisibleLayers] = useState(DEFAULT_VISIBLE_LAYERS);
  const [selection3D, setSelection3D] = useState<PrintabilitySelection>();

  const capabilityCheck = modelSourceCapability(selection);
  const requestOptions = assessmentRequestOptions(parameters);
  const ready =
    capabilityCheck.ready &&
    requestOptions !== undefined &&
    !progress &&
    capability.analysisSupported;

  const assess = async () => {
    if (!ready || !selection.file || !selection.unit || !selection.axis) return;
    activeRunRef.current?.abort();
    const controller = new AbortController();
    activeRunRef.current = controller;
    setError(undefined);
    setNotice(undefined);
    setRecomputeError(undefined);
    setProgress("Reading and assessing the model locally");
    try {
      const result = await assessPrintabilitySourceAsync(
        selection as InspectSource,
        requestOptions!,
        controller.signal,
      );
      setSourceMeta({ name: selection.file.name, size: selection.file.size });
      setOutcome(result);
      setSelection3D(undefined);
    } catch (reason) {
      if (reason instanceof InspectionCancelledError) {
        setNotice("Assessment cancelled.");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Assessment failed safely.",
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
    setParameters(DEFAULT_ASSESSMENT_PARAMETERS);
    setSelection3D(undefined);
    setVisibleLayers(DEFAULT_VISIBLE_LAYERS);
    setRecomputeError(undefined);
  };

  const recompute = async () => {
    if (!selection.file || !selection.unit || !selection.axis) return;
    const options = assessmentRequestOptions(parameters);
    if (!options) return;
    activeRunRef.current?.abort();
    const controller = new AbortController();
    activeRunRef.current = controller;
    setRecomputeError(undefined);
    setRecomputing(true);
    try {
      const result = await assessPrintabilitySourceAsync(
        selection as InspectSource,
        options,
        controller.signal,
      );
      setOutcome(result);
      setSelection3D(undefined);
    } catch (reason) {
      if (!(reason instanceof InspectionCancelledError)) {
        setRecomputeError(
          reason instanceof Error
            ? reason.message
            : "Assessment failed safely.",
        );
      }
    } finally {
      setRecomputing(false);
      if (activeRunRef.current === controller) activeRunRef.current = null;
    }
  };

  return (
    <ToolShell
      eyebrow="Printability"
      title="What does this model's surface actually measure like?"
      description="Load one local model and get evidence -- wall thickness, overhangs, disconnected islands, and build-volume fit -- for you to weigh against your slicer, material, and printer. This never predicts whether your model will print."
    >
      {outcome && sourceMeta ? (
        <PrintabilityReport
          outcome={outcome}
          sourceMeta={sourceMeta}
          onReset={reset}
          parameters={parameters}
          onUpdateParameters={setParameters}
          onRecompute={() => void recompute()}
          recomputing={recomputing}
          recomputeError={recomputeError}
          visibleLayers={visibleLayers}
          onUpdateVisibleLayers={setVisibleLayers}
          selection={selection3D}
          onSelect={setSelection3D}
        />
      ) : (
        <section
          className="comparison-card"
          aria-labelledby="printability-choose-title"
        >
          <div className="section-heading">
            <span className="step">Step 01</span>
            <h2 id="printability-choose-title">
              Choose a model and parameters
            </h2>
            <p>
              Select one supported file and review the assessment parameters
              below; sensible defaults are already filled in. If the source uses
              a different frame, adjust its Expert settings first.
            </p>
          </div>
          {!capability.analysisSupported && (
            <div className="comparison-error" role="alert">
              <strong>Local assessment is unavailable in this browser</strong>
              <p>{capability.blockingMessage}</p>
            </div>
          )}
          <div className="inspect-model-field">
            <ModelSourceCard selection={selection} update={setSelection} />
          </div>
          <AssessmentParametersCard
            parameters={parameters}
            update={setParameters}
          />
          <div className="comparison-status" aria-live="polite">
            <span className={ready ? "status-ready" : ""}>
              {progress ??
                notice ??
                (ready
                  ? "Inputs pass capability preflight"
                  : !capability.analysisSupported
                    ? "Assessment disabled: see the browser support notice above"
                    : "Choose a source file and valid parameters")}
            </span>
            <div className="actions">
              {progress && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={cancel}
                >
                  Cancel
                </button>
              )}
              <button
                className="button button-primary"
                type="button"
                disabled={!ready}
                onClick={() => void assess()}
              >
                {progress ? "Assessing locally…" : "Assess printability"}
              </button>
            </div>
          </div>
          {error && (
            <div className="comparison-error" role="alert">
              <strong>Assessment could not continue</strong>
              <p>{error}</p>
            </div>
          )}
          <p className="boundary-note">
            <strong>Local boundary:</strong> the source file and its geometry
            stay inside this browser's dedicated inspection worker; only the
            structured report leaves the worker, and nothing is uploaded.
          </p>
        </section>
      )}
    </ToolShell>
  );
}
