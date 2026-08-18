import { reportSchema } from "@voxelspy/contracts";
import type {
  AnalysisOutcome,
  AnalysisRequest,
  AnalysisResult,
  NormalizedModel,
  Report,
  Tolerance,
} from "@voxelspy/contracts";
import type {
  ModelComparisonPresentationSummary,
  ModelPresentationSummary,
} from "@voxelspy/analysis";

import { renderGeometrySummaryNotes } from "./geometry-summary-notes.js";
import { boundedEntityId, brandId } from "./ids.js";
import { formatNumber, truncateSafeText } from "./text.js";

type ReportModelEntry = Report["models"][number];
type ReportFinding = Report["findings"][number];
type ReportSavedView = Report["savedViews"][number];
type FindingId = ReportFinding["id"];
type SavedViewId = ReportSavedView["id"];
type CompleteOutcome = Extract<AnalysisOutcome, { state: "complete" }>;
type ChangeRegion = CompleteOutcome["regions"][number];

/**
 * Raised whenever a faithful, non-fabricated report cannot be built from
 * the supplied inputs -- either because they are inconsistent with each
 * other, or because the constructed document does not satisfy the
 * accepted `Report` contract. Fail closed rather than emitting a document
 * that silently drops or invents data.
 */
export class ReportBuildError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReportBuildError";
    this.code = code;
  }
}

/** Identity of this report engine. Fixed and versioned, never derived from a clock or environment. */
const REPORT_GENERATOR = Object.freeze({
  id: brandId<Report["generator"]["id"]>("voxelspy.report-engine"),
  version: "0.1.0",
});

const OVERVIEW_SAVED_VIEW_ID = brandId<SavedViewId>("view.overview");

/** Mirrors `reportSchema`'s `findings` ceiling in packages/contracts/src/report.ts. */
const MAX_FINDINGS = 10_000;

const FORMAT_SOURCE: Readonly<
  Record<string, { mediaType: string; extension: string }>
> = {
  stl: { mediaType: "model/stl", extension: "stl" },
  obj: { mediaType: "model/obj", extension: "obj" },
};

export interface BuildComparisonReportInput {
  /** Caller-supplied so report identity policy stays outside this pure engine. */
  readonly id: Report["id"];
  /**
   * Canonical UTC instant (`YYYY-MM-DDTHH:mm:ss.sssZ`), supplied explicitly
   * by the caller rather than read from a clock, so building a report stays
   * a deterministic, pure function of its inputs.
   */
  readonly createdAt: string;
  /** Defaults to a name derived from the two models' display names. */
  readonly title?: string;
  readonly baseline: NormalizedModel;
  readonly candidate: NormalizedModel;
  readonly analysis: AnalysisResult;
  readonly summary: ModelComparisonPresentationSummary;
}

/**
 * Builds a contracts-conformant `Report` document from a completed local
 * comparison. Deterministic: identical inputs always produce a deep-equal
 * document (no timestamps, randomness, or ambient state are read). The
 * result is validated against `reportSchema` before being returned; any
 * failure -- inconsistent inputs or a document that does not satisfy the
 * contract -- raises a `ReportBuildError` instead of returning a partial
 * or invalid report.
 */
export function buildComparisonReport(
  input: BuildComparisonReportInput,
): Report {
  const { baseline, candidate, analysis, summary, createdAt } = input;

  if (
    analysis.baseline.modelId !== baseline.id ||
    analysis.candidate.modelId !== candidate.id
  ) {
    throw new ReportBuildError(
      "model-binding-mismatch",
      "The analysis result does not reference the supplied baseline and candidate models.",
    );
  }
  if (
    summary.baseline.modelId !== baseline.id ||
    summary.candidate.modelId !== candidate.id
  ) {
    throw new ReportBuildError(
      "summary-binding-mismatch",
      "The presentation summary does not reference the supplied baseline and candidate models.",
    );
  }

  const baselineModel = reportModelFrom(baseline, "baseline");
  const candidateModel = reportModelFrom(candidate, "candidate");
  const overviewView = buildOverviewSavedView(
    baseline.id,
    candidate.id,
    summary,
    analysis,
    createdAt,
  );
  const findings = buildFindings(analysis, createdAt);

  const request: AnalysisRequest = {
    contractVersion: 1,
    requestId: analysis.requestId,
    baseline: analysis.baseline,
    candidate: analysis.candidate,
    method: analysis.outcome.requestedMethod,
    tolerance: analysis.outcome.requestedTolerance,
  };

  const document: Report = {
    contractVersion: 1,
    id: input.id,
    title: truncateSafeText(
      input.title ??
        `Comparison report: ${baselineModel.displayName} vs ${candidateModel.displayName}`,
      200,
    ),
    createdAt,
    generator: REPORT_GENERATOR,
    analysis: { request, result: analysis },
    models: [baselineModel, candidateModel],
    markups: [],
    findings,
    savedViews: [overviewView],
    figures: [],
    review: {
      activeSavedViewId: overviewView.id,
      notes: renderGeometrySummaryNotes(summary),
      status: "draft",
    },
  };

  const parsed = reportSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ReportBuildError(
      "report-schema-validation-failed",
      `Constructed report failed contract validation: ${truncateSafeText(issues, 1_800)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function reportModelFrom(
  model: NormalizedModel,
  role: "baseline" | "candidate",
): ReportModelEntry {
  const provenance = model.provenance;
  const format = FORMAT_SOURCE[String(provenance.formatId)];
  if (!format) {
    throw new ReportBuildError(
      "unsupported-source-format",
      `No report media-type mapping is defined for source format "${String(provenance.formatId)}".`,
    );
  }
  if (!provenance.sourceDigest) {
    throw new ReportBuildError(
      "missing-source-digest",
      `The ${role} model's import provenance has no source digest; a report cannot certify model integrity without one.`,
    );
  }
  return {
    modelId: model.id,
    role,
    displayName: truncateSafeText(provenance.sourceName, 200),
    sourceName: provenance.sourceName,
    sourceMediaType: format.mediaType,
    sourcePath: `models/${role}.${format.extension}`,
    sourceDigest: provenance.sourceDigest,
    normalizationProvenance: provenance,
  };
}

function buildOverviewSavedView(
  baselineId: NormalizedModel["id"],
  candidateId: NormalizedModel["id"],
  summary: ModelComparisonPresentationSummary,
  analysis: AnalysisResult,
  createdAt: string,
): ReportSavedView {
  const bounds = combinedBounds(
    summary.baseline.bounds,
    summary.candidate.bounds,
  );
  const center: [number, number, number] = bounds
    ? [
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2,
      ]
    : [0, 0, 0];
  const diagonal = bounds
    ? Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      )
    : 0;
  const radius = diagonal > 0 ? diagonal : 100;
  const offset = radius / Math.sqrt(3);
  const position: [number, number, number] = [
    center[0] + offset,
    center[1] + offset,
    center[2] + offset,
  ];
  const hasRegions =
    analysis.outcome.state === "complete" &&
    analysis.outcome.regions.length > 0;

  return {
    contractVersion: 1,
    id: OVERVIEW_SAVED_VIEW_ID,
    name: "Comparison overview",
    createdAt,
    frame: "comparison",
    camera: {
      position,
      target: center,
      up: [0, 0, 1],
      projection: {
        kind: "orthographic",
        verticalSpanMillimetres: Math.max(radius * 2, 1),
      },
    },
    visibility: [
      { modelId: baselineId, visible: true },
      { modelId: candidateId, visible: true },
    ],
    selectedFindingIds: [],
    selectedMarkupIds: [],
    sectionPlanes: [],
    selectedRegionIds: [],
    displayMode: hasRegions ? "difference" : "overlay",
  };
}

function combinedBounds(
  baseline: ModelPresentationSummary["bounds"],
  candidate: ModelPresentationSummary["bounds"],
):
  { min: [number, number, number]; max: [number, number, number] } | undefined {
  const available = [baseline, candidate].filter(
    (
      bound,
    ): bound is Extract<
      ModelPresentationSummary["bounds"],
      { available: true }
    > => bound.available,
  );
  if (available.length === 0) return undefined;
  const axis = (index: 0 | 1 | 2, pick: "min" | "max") =>
    available.map((bound) => bound[pick][index]);
  const min: [number, number, number] = [
    Math.min(...axis(0, "min")),
    Math.min(...axis(1, "min")),
    Math.min(...axis(2, "min")),
  ];
  const max: [number, number, number] = [
    Math.max(...axis(0, "max")),
    Math.max(...axis(1, "max")),
    Math.max(...axis(2, "max")),
  ];
  return { min, max };
}

function buildFindings(
  analysis: AnalysisResult,
  createdAt: string,
): ReportFinding[] {
  if (analysis.outcome.state !== "complete") return [];
  const outcome = analysis.outcome;
  const regionById = new Map<string, ChangeRegion>(
    outcome.regions.map((region) => [String(region.id), region]),
  );
  const metricById = new Map<string, CompleteOutcome["metrics"][number]>(
    outcome.metrics.map((metric) => [String(metric.id), metric]),
  );
  const orderedRegions = outcome.orderedRegionIds
    .map((id) => regionById.get(String(id)))
    .filter((region): region is ChangeRegion => region !== undefined);

  const totalRegions = orderedRegions.length;
  const truncated = totalRegions > MAX_FINDINGS;
  const includedCount = truncated ? MAX_FINDINGS - 1 : totalRegions;
  const includedRegions = orderedRegions.slice(0, includedCount);

  const findings = includedRegions.map((region, index) =>
    buildAutomaticFinding(
      region,
      index,
      totalRegions,
      outcome,
      analysis.requestId,
      metricById,
      createdAt,
    ),
  );
  if (truncated) {
    findings.push(
      buildTruncationFinding(totalRegions, includedCount, createdAt),
    );
  }
  return findings;
}

function buildAutomaticFinding(
  region: ChangeRegion,
  rankIndex: number,
  totalRegions: number,
  outcome: CompleteOutcome,
  requestId: AnalysisResult["requestId"],
  metricById: Map<string, CompleteOutcome["metrics"][number]>,
  createdAt: string,
): ReportFinding {
  const maxDistance = metricById.get(`${String(region.id)}.maximum-distance`);
  const meanDistance = metricById.get(`${String(region.id)}.mean-distance`);
  const area = metricById.get(`${String(region.id)}.area`);
  const semantics =
    outcome.semantics === "approximate"
      ? `Approximate result; ${outcome.uncertainty.description}`
      : `Exact within the validated domain "${outcome.validatedDomain.description}".`;
  const summaryParts = [
    `Detected by ${outcome.effectiveMethod.id} v${outcome.effectiveMethod.version} at ${describeTolerance(outcome.effectiveTolerance)}.`,
    maxDistance
      ? `Maximum distance ${formatNumber(maxDistance.value)} mm.`
      : undefined,
    meanDistance
      ? `Mean distance ${formatNumber(meanDistance.value)} mm.`
      : undefined,
    area ? `Changed area ${formatNumber(area.value)} mm^2.` : undefined,
    semantics,
  ].filter((part): part is string => part !== undefined);

  return {
    contractVersion: 1,
    id: brandId<FindingId>(boundedEntityId("finding", String(region.id))),
    source: {
      kind: "automatic",
      detector: {
        id: outcome.effectiveMethod.id,
        version: outcome.effectiveMethod.version,
        parameters: outcome.effectiveMethod.parameters,
      },
      analysisRequestId: requestId,
    },
    severity: "warning",
    status: "open",
    title: truncateSafeText(
      `${categoryLabel(region.category)} region ${rankIndex + 1} of ${totalRegions}`,
      160,
    ),
    summary: truncateSafeText(summaryParts.join(" "), 2_000),
    markupIds: [],
    metricIds: [...region.metricIds],
    regionIds: [region.id],
    savedViewIds: [OVERVIEW_SAVED_VIEW_ID],
    createdAt,
    updatedAt: createdAt,
    attribution: { kind: "anonymous" },
  };
}

function buildTruncationFinding(
  totalRegions: number,
  includedCount: number,
  createdAt: string,
): ReportFinding {
  return {
    contractVersion: 1,
    id: brandId<FindingId>(boundedEntityId("finding", "truncated-regions")),
    source: { kind: "manual" },
    severity: "warning",
    status: "open",
    title: "Additional changed regions were not included",
    summary: truncateSafeText(
      `The analysis detected ${totalRegions} changed regions; only the ${includedCount} highest-ranked ` +
        `region(s) are included as findings because a report is limited to ${MAX_FINDINGS} findings. ` +
        "Review the full analysis result for the complete set.",
      2_000,
    ),
    markupIds: [],
    metricIds: [],
    regionIds: [],
    savedViewIds: [OVERVIEW_SAVED_VIEW_ID],
    createdAt,
    updatedAt: createdAt,
    attribution: { kind: "anonymous" },
  };
}

function categoryLabel(category: ChangeRegion["category"]): string {
  switch (category) {
    case "added":
      return "Added";
    case "removed":
      return "Removed";
    case "deviation":
      return "Deviation";
    default:
      return category;
  }
}

function describeTolerance(tolerance: Tolerance): string {
  const parts = [
    tolerance.distanceMillimetres !== undefined
      ? `distance tolerance ${formatNumber(tolerance.distanceMillimetres)} mm`
      : undefined,
    tolerance.angularRadians !== undefined
      ? `angular tolerance ${formatNumber(tolerance.angularRadians)} rad`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(", ");
}
