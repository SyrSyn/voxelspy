import {
  analyzeModelPair,
  summarizeModelComparison,
  SURFACE_DISTANCE_METHOD,
} from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  analysisRequestSchema,
  markupSchema,
  savedViewSchema,
  type Markup,
  type SavedView,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";
import { describe, expect, it } from "vitest";
import { buildSessionReport, saveSession, openSession } from "./session";
import { renderReportHtml } from "./report";
import {
  cameraFromComparison,
  cameraToComparison,
  emptyReview,
  parseReviewPoint,
  removeReviewMarkup,
  reviewFromReport,
  validateReview,
  REVIEW_TIMESTAMP,
  MAX_REVIEW_MARKUPS,
  type ReviewContent,
} from "./review";
async function fixture() {
  const bytes = new TextEncoder().encode(
    "solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid a\n",
  );
  async function model(id: string) {
    const result = await importModel({
      contractVersion: 1,
      targetModelId: id,
      format: "stl",
      sourceName: "part.stl",
      bytes: Uint8Array.from(bytes),
      options: {
        userUnit: "millimetre",
        userAxis: "right-handed-z-up",
        limits: { inputBytes: 32000000, triangleCount: 100 },
      },
    });
    if (!result.ok) throw new Error(result.message);
    return result.model;
  }
  const baseline = await model("baseline");
  const candidate = await model("candidate");
  const request = analysisRequestSchema.parse({
    contractVersion: 1,
    requestId: "review.test",
    baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
    candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
    method: { ...SURFACE_DISTANCE_METHOD, parameters: { maxRegions: 4 } },
    tolerance: { distanceMillimetres: 0.1 },
  });
  const analysis = analyzeModelPair({ request, baseline, candidate });
  const summary = summarizeModelComparison(baseline, candidate, analysis);
  const common = {
    contractVersion: 1,
    visible: true,
    createdAt: REVIEW_TIMESTAMP,
    attribution: { kind: "anonymous" },
  };
  const frame = { kind: "comparison" };
  const markups: Markup[] = [
    markupSchema.parse({
      ...common,
      id: "markup.note",
      kind: "callout",
      label: "<script>note</script>",
      text: 'Private <img src=x onerror="alert(1)"> note',
      anchor: { frame, pointMillimetres: [0, 0, 0] },
    }),
    markupSchema.parse({
      ...common,
      id: "markup.distance",
      label: "Five",
      kind: "distance",
      start: { frame, pointMillimetres: [0, 0, 0] },
      end: { frame, pointMillimetres: [3, 4, 0] },
      valueMillimetres: 5,
    }),
  ];
  const view: SavedView = savedViewSchema.parse({
    ...buildSessionReport({ baseline, candidate, analysis, summary })
      .savedViews[0],
    id: "view.user.1",
    name: "<view>",
    camera: {
      position: [1000000000.5, 12, 15],
      target: [1000000000, 0, 0],
      up: [0, 1, 0],
      projection: { kind: "perspective", verticalFieldOfViewDegrees: 38 },
    },
    visibility: [
      { modelId: baseline.id, visible: false },
      { modelId: candidate.id, visible: true },
    ],
    selectedMarkupIds: [markups[0]!.id],
  });
  const review: ReviewContent = {
    ...emptyReview(analysis, [baseline, candidate]),
    markups,
    savedViews: [view],
    activeSavedViewId: view.id,
  };
  return {
    baseline,
    candidate,
    analysis,
    summary,
    reviewContent: review,
    sourceModels: { baseline: bytes, candidate: bytes },
  };
}
describe("authored comparison review", () => {
  it("round-trips notes, distance, actual camera and visibility deterministically", async () => {
    const input = await fixture();
    const first = await saveSession(input);
    const second = await saveSession(input);
    expect(first.bytes).toEqual(second.bytes);
    const reopened = await openSession(first.bytes);
    const report = reopened.exchange.bundle.report;
    expect(reviewFromReport(report)).toEqual(input.reviewContent);
    expect(report.savedViews).toHaveLength(2);
    expect(report.markups[1]).toMatchObject({
      kind: "distance",
      valueMillimetres: 5,
    });
    const restored = reviewFromReport(report);
    expect(
      validateReview(restored, input.analysis, [
        input.baseline,
        input.candidate,
      ]),
    ).toEqual(restored);
    const resaved = await saveSession({ ...input, reviewContent: restored });
    expect(resaved.bytes).toEqual(first.bytes);
    const html = renderReportHtml(report);
    expect(html).toContain("&lt;script&gt;note&lt;/script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Distance: 5.000 mm");
    expect(html).toContain("1000000000.5");
  });
  it("keeps default reports unchanged when no authoring is present", async () => {
    const input = await fixture();
    const { reviewContent, ...plain } = input;
    expect(
      buildSessionReport({
        ...plain,
        reviewContent: emptyReview(input.analysis),
      }),
    ).toEqual(buildSessionReport(plain));
  });
  it("reverses render-origin rebasing without losing small camera offsets", () => {
    const camera = {
      position: [0.5, 12, 15] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    };
    const origin: [number, number, number] = [
      1000000000, 1000000000, 1000000000,
    ];
    const saved = cameraToComparison(camera, origin);
    expect(saved.position).toEqual([1000000000.5, 1000000012, 1000000015]);
    const restored = cameraFromComparison(saved, origin);
    expect(restored.position).toEqual(camera.position);
    expect(restored.target).toEqual(camera.target);
  });
  it("refuses stale comparisons, missing models/regions/markups and invalid surfaces", async () => {
    const input = await fixture();
    const review = input.reviewContent;
    expect(() =>
      validateReview(
        {
          ...review,
          binding: { ...review.binding, analysisRequestId: "different" },
        },
        input.analysis,
      ),
    ).toThrow("different comparison");
    expect(() =>
      validateReview(
        {
          ...review,
          binding: {
            ...review.binding,
            sourceDigests: ["different", review.binding.sourceDigests[1]],
          },
        },
        input.analysis,
        [input.baseline, input.candidate],
      ),
    ).toThrow("different comparison");
    expect(() =>
      validateReview(
        {
          ...review,
          binding: {
            ...review.binding,
            sourceNormalizations: [
              "different normalization",
              review.binding.sourceNormalizations[1],
            ],
          },
        },
        input.analysis,
        [input.baseline, input.candidate],
      ),
    ).toThrow("different comparison");
    const view = review.savedViews[0]!;
    expect(() =>
      validateReview(
        {
          ...review,
          savedViews: [
            { ...view, selectedRegionIds: ["region.missing" as never] },
          ],
        },
        input.analysis,
      ),
    ).toThrow("missing annotation or changed region");
    expect(() =>
      validateReview(
        {
          ...review,
          savedViews: [
            { ...view, selectedMarkupIds: ["markup.missing" as never] },
          ],
        },
        input.analysis,
      ),
    ).toThrow("missing annotation or changed region");
    const note = review.markups[0]! as Extract<Markup, { kind: "callout" }>;
    expect(() =>
      validateReview(
        {
          ...review,
          markups: [
            {
              ...note,
              anchor: {
                ...note.anchor,
                frame: { kind: "model", modelId: "missing" as never },
              },
            },
          ],
        },
        input.analysis,
      ),
    ).toThrow("unknown model");
    expect(() =>
      validateReview(
        {
          ...review,
          markups: [
            {
              ...note,
              anchor: {
                frame: { kind: "model", modelId: input.baseline.id },
                pointMillimetres: [0, 0, 0],
                surface: {
                  instanceId: "missing" as never,
                  meshId: "missing" as never,
                  triangleIndex: 0,
                  barycentric: [1, 0, 0],
                },
              },
            },
          ],
        },
        input.analysis,
        [input.baseline, input.candidate],
      ),
    ).toThrow("surface reference");
    expect(() =>
      validateReview(
        {
          ...review,
          markups: Array.from({ length: MAX_REVIEW_MARKUPS + 1 }, () => note),
        },
        input.analysis,
      ),
    ).toThrow("Review limit");
  });
  it("deletes annotation selections from saved views and rejects malformed coordinates", async () => {
    const input = await fixture();
    const next = removeReviewMarkup(
      input.reviewContent,
      input.reviewContent.markups[0]!.id,
    );
    expect(next.savedViews[0]!.selectedMarkupIds).toEqual([]);
    expect(validateReview(next, input.analysis).markups).toHaveLength(1);
    for (const value of ["1,,3", "1,2", "1,2,Infinity"])
      expect(() => parseReviewPoint(value)).toThrow("finite");
  });
});
