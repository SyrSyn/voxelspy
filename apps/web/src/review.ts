import {
  markupSchema,
  savedViewSchema,
  type AnalysisResult,
  type Markup,
  type NormalizedModel,
  type Report,
  type SavedView,
  type Vec3,
} from "@voxelspy/contracts";
export const REVIEW_TIMESTAMP = "1970-01-01T00:00:00.000Z";
export const MAX_REVIEW_MARKUPS = 500;
export const MAX_REVIEW_VIEWS = 100;
export interface ReviewContent {
  readonly binding: {
    readonly baselineModelId: string;
    readonly candidateModelId: string;
    readonly analysisRequestId: string;
    readonly analysisContext: string;
    readonly sourceDigests: readonly [string, string];
    readonly sourceNormalizations: readonly [string, string];
  };
  readonly markups: readonly Markup[];
  readonly savedViews: readonly SavedView[];
  readonly activeSavedViewId?: SavedView["id"];
}
export function emptyReview(
  analysis: AnalysisResult,
  models?: readonly NormalizedModel[],
): ReviewContent {
  return {
    binding: {
      baselineModelId: analysis.baseline.modelId,
      candidateModelId: analysis.candidate.modelId,
      analysisRequestId: analysis.requestId,
      analysisContext: JSON.stringify({
        baseline: analysis.baseline,
        candidate: analysis.candidate,
        method: analysis.outcome.requestedMethod,
        tolerance: analysis.outcome.requestedTolerance,
      }),
      sourceNormalizations: [
        analysis.baseline.modelId,
        analysis.candidate.modelId,
      ].map((id) => {
        const model = models?.find((model) => model.id === id);
        return model ? JSON.stringify(model.provenance) : "unknown";
      }) as [string, string],
      sourceDigests: [
        analysis.baseline.modelId,
        analysis.candidate.modelId,
      ].map((id) => {
        const model = models?.find((model) => model.id === id);
        return model?.provenance.sourceDigest?.value ?? "unknown";
      }) as [string, string],
    },
    markups: [],
    savedViews: [],
  };
}
export function reviewFromReport(report: Report): ReviewContent {
  const binding = {
    ...emptyReview(report.analysis.result).binding,
    sourceNormalizations: ["baseline", "candidate"].map((role) =>
      JSON.stringify(
        report.models.find((model) => model.role === role)!
          .normalizationProvenance,
      ),
    ) as [string, string],
    sourceDigests: [
      report.models.find((model) => model.role === "baseline")!.sourceDigest
        .value,
      report.models.find((model) => model.role === "candidate")!.sourceDigest
        .value,
    ] as [string, string],
  };
  const result: ReviewContent = {
    binding,
    markups: report.markups,
    savedViews: report.savedViews.filter((view) => view.id !== "view.overview"),
    ...(report.review.activeSavedViewId === "view.overview"
      ? {}
      : { activeSavedViewId: report.review.activeSavedViewId }),
  };
  return result;
}
/** Reject stale bindings and graph references rather than reattaching annotations. */
export function validateReview(
  review: ReviewContent,
  analysis: AnalysisResult,
  models?: readonly NormalizedModel[],
): ReviewContent {
  const expected = emptyReview(analysis, models).binding;
  if (
    review.binding.baselineModelId !== expected.baselineModelId ||
    review.binding.candidateModelId !== expected.candidateModelId ||
    review.binding.analysisRequestId !== expected.analysisRequestId ||
    review.binding.analysisContext !== expected.analysisContext ||
    ((review.markups.length > 0 || review.savedViews.length > 0) &&
      models !== undefined &&
      review.binding.sourceDigests.some(
        (digest, index) =>
          digest !== expected.sourceDigests[index] ||
          review.binding.sourceNormalizations[index] !==
            expected.sourceNormalizations[index],
      ))
  )
    throw new Error("Review content belongs to a different comparison.");
  if (
    review.markups.length > MAX_REVIEW_MARKUPS ||
    review.savedViews.length > MAX_REVIEW_VIEWS
  )
    throw new Error(
      `Review limit: ${MAX_REVIEW_MARKUPS} annotations and ${MAX_REVIEW_VIEWS} named views.`,
    );
  const modelIds = new Set([
    expected.baselineModelId,
    expected.candidateModelId,
  ]);
  const regions = new Set<string>(
    analysis.outcome.state === "complete"
      ? analysis.outcome.regions.map((region) => region.id)
      : [],
  );
  const ids = new Set<string>();
  const markups = review.markups.map((value) => {
    const markup = markupSchema.parse(value);
    if (ids.has(markup.id)) throw new Error("Review IDs must be unique.");
    ids.add(markup.id);
    const points =
      markup.kind === "callout" ? [markup.anchor] : [markup.start, markup.end];
    for (const point of points) {
      if (point.frame.kind === "model" && !modelIds.has(point.frame.modelId))
        throw new Error("Annotation references an unknown model.");
      if (point.surface && point.frame.kind === "model" && models) {
        const frameId = point.frame.modelId;
        const model = models.find((model) => model.id === frameId);
        const mesh = model?.meshes.find(
          (mesh) => mesh.id === point.surface!.meshId,
        );
        const instance = model?.placement.instances.find(
          (instance) => instance.id === point.surface!.instanceId,
        );
        if (
          !mesh ||
          !instance ||
          instance.meshId !== mesh.id ||
          point.surface.triangleIndex >= mesh.geometry.indices.length / 3
        )
          throw new Error(
            "Annotation surface reference does not exist in the restored model.",
          );
      }
    }
    return markup;
  });
  const markupIds = new Set(markups.map((markup) => markup.id));
  const savedViews = review.savedViews.map((value) => {
    const view = savedViewSchema.parse(value);
    if (ids.has(view.id) || view.id === "view.overview")
      throw new Error(
        "Review IDs must be unique and cannot replace the overview.",
      );
    ids.add(view.id);
    if (
      view.visibility.some((entry) => !modelIds.has(entry.modelId)) ||
      new Set(view.visibility.map((entry) => entry.modelId)).size !== 2
    )
      throw new Error("Saved view references different models.");
    if (
      view.selectedRegionIds.some((id) => !regions.has(id)) ||
      view.selectedMarkupIds.some((id) => !markupIds.has(id))
    )
      throw new Error(
        "Saved view references a missing annotation or changed region.",
      );
    return view;
  });
  if (
    review.activeSavedViewId &&
    !savedViews.some((view) => view.id === review.activeSavedViewId)
  )
    throw new Error("Active saved view does not exist.");
  return { ...review, markups, savedViews };
}
export function parseReviewPoint(value: string): Vec3 {
  const parts = value.split(",");
  const numbers = parts.map(Number);
  if (
    parts.length !== 3 ||
    parts.some((part) => part.trim() === "") ||
    numbers.some((number) => !Number.isFinite(number))
  )
    throw new Error(
      "Enter three finite comparison-frame millimetre coordinates: x,y,z.",
    );
  return numbers as Vec3;
}
export function nextReviewId(prefix: string, ids: readonly string[]): string {
  let next = 1;
  while (ids.includes(`${prefix}.${next}`)) next++;
  return `${prefix}.${next}`;
}
export function removeReviewMarkup(
  review: ReviewContent,
  id: Markup["id"],
): ReviewContent {
  return {
    ...review,
    markups: review.markups.filter((markup) => markup.id !== id),
    savedViews: review.savedViews.map((view) => ({
      ...view,
      selectedMarkupIds: view.selectedMarkupIds.filter((value) => value !== id),
    })),
  };
}

/** Render origins are an implementation detail; saved cameras stay absolute. */
export function cameraToComparison(
  camera: {
    position: Vec3;
    target: Vec3;
    up?: Vec3;
    projection?: SavedView["camera"]["projection"];
  },
  origin: Vec3,
): SavedView["camera"] {
  return {
    position: camera.position.map(
      (value, index) => value + origin[index]!,
    ) as Vec3,
    target: camera.target.map((value, index) => value + origin[index]!) as Vec3,
    up: camera.up ?? [0, 1, 0],
    projection: camera.projection ?? {
      kind: "perspective",
      verticalFieldOfViewDegrees: 38,
    },
  };
}
export function cameraFromComparison(
  camera: SavedView["camera"],
  origin: Vec3,
): SavedView["camera"] {
  return {
    ...camera,
    position: camera.position.map(
      (value, index) => value - origin[index]!,
    ) as Vec3,
    target: camera.target.map((value, index) => value - origin[index]!) as Vec3,
  };
}
