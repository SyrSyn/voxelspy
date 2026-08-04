import { z } from "zod";
import { analysisExchangeSchema } from "./analysis.js";
import { geometryProvenanceSchema } from "./geometry.js";
import {
  entityIdSchema,
  figureIdSchema,
  findingIdSchema,
  isPortableJson,
  instanceIdSchema,
  markupIdSchema,
  methodIdSchema,
  meshIdSchema,
  metricIdSchema,
  modelIdSchema,
  portableJsonObjectSchema,
  reportIdSchema,
  regionIdSchema,
  requestIdSchema,
  savedViewIdSchema,
  sha256DigestSchema,
  vec2Schema,
  vec3Schema,
} from "./primitives.js";

export const canonicalInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }, "Invalid UTC instant");
const safeText = z
  .string()
  .refine(
    (value) =>
      isPortableJson(value) &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "Text contains an unsupported Unicode or control character",
  );
const boundedText = (maximum: number) => safeText.min(1).max(maximum);
const mediaTypeSchema = boundedText(255).regex(
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu,
);

export const portableResourcePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u,
    "Resource paths must be lowercase, normalized, and relative",
  )
  .refine(
    (path) =>
      path
        .split("/")
        .every((component) => component !== "." && component !== ".."),
    "Resource paths cannot contain dot segments",
  );

export const attributionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("anonymous") }),
  z.strictObject({
    kind: z.literal("display-name"),
    displayName: boundedText(120),
  }),
]);

const commonMarkupShape = {
  contractVersion: z.literal(1),
  id: markupIdSchema,
  label: boundedText(120),
  visible: z.boolean(),
  createdAt: canonicalInstantSchema,
  attribution: attributionSchema,
};

export const spatialFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("comparison") }),
  z.strictObject({ kind: z.literal("model"), modelId: modelIdSchema }),
]);

export const spatialPointSchema = z
  .strictObject({
    frame: spatialFrameSchema,
    pointMillimetres: vec3Schema,
    normal: vec3Schema.optional(),
    surface: z
      .strictObject({
        instanceId: instanceIdSchema,
        meshId: meshIdSchema,
        triangleIndex: z.number().int().safe().nonnegative(),
        barycentric: z.tuple([
          z.number().finite().min(0).max(1),
          z.number().finite().min(0).max(1),
          z.number().finite().min(0).max(1),
        ]),
      })
      .optional(),
  })
  .superRefine((point, context) => {
    if (point.normal && Math.abs(Math.hypot(...point.normal) - 1) > 1e-9)
      context.addIssue({
        code: "custom",
        path: ["normal"],
        message: "Spatial-point normal must be unit length",
      });
    if (point.surface) {
      if (point.frame.kind !== "model")
        context.addIssue({
          code: "custom",
          path: ["surface"],
          message: "Surface locators require a model frame",
        });
      const sum = point.surface.barycentric.reduce(
        (total, value) => total + value,
        0,
      );
      if (Math.abs(sum - 1) > 1e-9)
        context.addIssue({
          code: "custom",
          path: ["surface", "barycentric"],
          message: "Surface barycentric coordinates must sum to one",
        });
    }
  });

export const calloutMarkupSchema = z.strictObject({
  ...commonMarkupShape,
  kind: z.literal("callout"),
  anchor: spatialPointSchema,
  text: boundedText(2_000),
});

export const distanceMarkupSchema = z
  .strictObject({
    ...commonMarkupShape,
    kind: z.literal("distance"),
    start: spatialPointSchema,
    end: spatialPointSchema,
    valueMillimetres: z.number().finite().nonnegative(),
  })
  .superRefine((distance, context) => {
    const expected = Math.hypot(
      distance.end.pointMillimetres[0] - distance.start.pointMillimetres[0],
      distance.end.pointMillimetres[1] - distance.start.pointMillimetres[1],
      distance.end.pointMillimetres[2] - distance.start.pointMillimetres[2],
    );
    if (
      Math.abs(expected - distance.valueMillimetres) >
      Math.max(1e-9, expected * 1e-9)
    ) {
      context.addIssue({
        code: "custom",
        path: ["valueMillimetres"],
        message: "Distance value must match its comparison-frame endpoints",
      });
    }
    if (
      distance.start.frame.kind !== distance.end.frame.kind ||
      (distance.start.frame.kind === "model" &&
        distance.end.frame.kind === "model" &&
        distance.start.frame.modelId !== distance.end.frame.modelId)
    )
      context.addIssue({
        code: "custom",
        path: ["end", "frame"],
        message: "Distance endpoints must use the same declared frame",
      });
  });

export const markupSchema = z.discriminatedUnion("kind", [
  calloutMarkupSchema,
  distanceMarkupSchema,
]);
export type Markup = z.infer<typeof markupSchema>;

const findingSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    kind: z.literal("automatic"),
    detector: z.strictObject({
      id: methodIdSchema,
      version: boundedText(128),
      parameters: portableJsonObjectSchema,
    }),
    analysisRequestId: requestIdSchema,
  }),
]);

export const findingSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: findingIdSchema,
    source: findingSourceSchema,
    severity: z.enum(["info", "warning", "error"]),
    status: z.enum(["open", "acknowledged", "resolved", "dismissed"]),
    title: boundedText(160),
    summary: boundedText(2_000),
    markupIds: z.array(markupIdSchema).max(256),
    metricIds: z.array(metricIdSchema).max(256),
    regionIds: z.array(regionIdSchema).max(256),
    savedViewIds: z.array(savedViewIdSchema).min(1).max(256),
    createdAt: canonicalInstantSchema,
    updatedAt: canonicalInstantSchema,
    attribution: attributionSchema,
  })
  .superRefine((finding, context) => {
    for (const [key, values] of [
      ["markupIds", finding.markupIds],
      ["metricIds", finding.metricIds],
      ["regionIds", finding.regionIds],
      ["savedViewIds", finding.savedViewIds],
    ] as const) {
      if (new Set(values.map(String)).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Finding references must be unique",
        });
      }
    }
    if (Date.parse(finding.updatedAt) < Date.parse(finding.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Finding update time cannot precede creation",
      });
    }
    if (finding.source.kind === "automatic" && finding.regionIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["regionIds"],
        message: "Automatic findings require at least one analysis region",
      });
    }
  });
export type Finding = z.infer<typeof findingSchema>;

const cameraProjectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("perspective"),
    verticalFieldOfViewDegrees: z.number().finite().min(1).max(179),
  }),
  z.strictObject({
    kind: z.literal("orthographic"),
    verticalSpanMillimetres: z.number().finite().positive(),
  }),
]);

export const savedViewSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: savedViewIdSchema,
    name: boundedText(120),
    createdAt: canonicalInstantSchema,
    frame: z.literal("comparison"),
    camera: z.strictObject({
      position: vec3Schema,
      target: vec3Schema,
      up: vec3Schema,
      projection: cameraProjectionSchema,
    }),
    visibility: z
      .array(z.strictObject({ modelId: modelIdSchema, visible: z.boolean() }))
      .length(2),
    selectedFindingIds: z.array(findingIdSchema).max(1_000),
    selectedMarkupIds: z.array(markupIdSchema).max(1_000),
    sectionPlanes: z
      .array(
        z.strictObject({
          frame: z.literal("comparison"),
          normal: vec3Schema,
          constantMillimetres: z.number().finite(),
        }),
      )
      .max(6),
    selectedRegionIds: z.array(regionIdSchema).max(1_000),
    displayMode: z.enum(["baseline", "candidate", "overlay", "difference"]),
  })
  .superRefine((view, context) => {
    const direction = view.camera.target.map(
      (value, index) => value - view.camera.position[index]!,
    ) as [number, number, number];
    const directionLength = Math.hypot(...direction);
    const upLength = Math.hypot(...view.camera.up);
    const crossLength = Math.hypot(
      direction[1] * view.camera.up[2] - direction[2] * view.camera.up[1],
      direction[2] * view.camera.up[0] - direction[0] * view.camera.up[2],
      direction[0] * view.camera.up[1] - direction[1] * view.camera.up[0],
    );
    if (
      directionLength <= 1e-12 ||
      Math.abs(upLength - 1) > 1e-9 ||
      crossLength <= directionLength * 1e-12
    ) {
      context.addIssue({
        code: "custom",
        path: ["camera"],
        message:
          "Camera requires a distinct target and a nonparallel unit up vector",
      });
    }
    if (new Set(view.visibility.map(({ modelId }) => modelId)).size !== 2) {
      context.addIssue({
        code: "custom",
        path: ["visibility"],
        message: "Saved-view model visibility must be unique",
      });
    }
    for (const [key, values] of [
      ["selectedFindingIds", view.selectedFindingIds],
      ["selectedMarkupIds", view.selectedMarkupIds],
      ["selectedRegionIds", view.selectedRegionIds],
    ] as const) {
      if (new Set(values.map(String)).size !== values.length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Saved-view selections must be unique",
        });
    }
    view.sectionPlanes.forEach((plane, index) => {
      const length = Math.hypot(...plane.normal);
      if (Math.abs(length - 1) > 1e-9)
        context.addIssue({
          code: "custom",
          path: ["sectionPlanes", index, "normal"],
          message: "Section-plane normal must be unit length",
        });
    });
  });
export type SavedView = z.infer<typeof savedViewSchema>;

export const reportModelSchema = z.strictObject({
  modelId: modelIdSchema,
  role: z.enum(["baseline", "candidate"]),
  displayName: boundedText(200),
  sourceName: boundedText(1_024),
  sourceMediaType: mediaTypeSchema,
  sourcePath: portableResourcePathSchema.refine(
    (path) => path.startsWith("models/"),
    "Source models must use the models/ resource namespace",
  ),
  sourceDigest: sha256DigestSchema,
  normalizationProvenance: geometryProvenanceSchema,
});

const figurePrimitiveSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("line"),
    from: vec2Schema,
    to: vec2Schema,
    color: z.string().regex(/^#[a-f0-9]{6}$/u),
    widthPixels: z.number().finite().min(0.1).max(20),
  }),
  z.strictObject({
    kind: z.literal("label"),
    at: vec2Schema,
    text: boundedText(200),
    color: z.string().regex(/^#[a-f0-9]{6}$/u),
  }),
]);

export const reportFigureSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: figureIdSchema,
    title: boundedText(160),
    savedViewId: savedViewIdSchema,
    widthPixels: z.number().int().safe().min(1).max(16_384),
    heightPixels: z.number().int().safe().min(1).max(16_384),
    alternativeText: boundedText(2_000),
    primitives: z.array(figurePrimitiveSchema).max(10_000),
  })
  .superRefine((figure, context) => {
    figure.primitives.forEach((primitive, index) => {
      const points =
        primitive.kind === "line"
          ? [primitive.from, primitive.to]
          : [primitive.at];
      if (
        points.some(
          ([x, y]) =>
            x < 0 || y < 0 || x > figure.widthPixels || y > figure.heightPixels,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["primitives", index],
          message: "Figure primitives must lie within the figure bounds",
        });
    });
  });

export const reportSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    id: reportIdSchema,
    title: boundedText(200),
    createdAt: canonicalInstantSchema,
    generator: z.strictObject({
      id: entityIdSchema,
      version: boundedText(128),
    }),
    analysis: analysisExchangeSchema,
    models: z.array(reportModelSchema).length(2),
    markups: z.array(markupSchema).max(10_000),
    findings: z.array(findingSchema).max(10_000),
    savedViews: z.array(savedViewSchema).min(1).max(1_000),
    figures: z.array(reportFigureSchema).max(1_000),
    review: z.strictObject({
      activeSavedViewId: savedViewIdSchema,
      notes: safeText.max(20_000),
      status: z.enum(["draft", "reviewed"]),
    }),
  })
  .superRefine((report, context) => {
    const modelIds = report.models.map(({ modelId }) => modelId);
    const expectedModels = [
      report.analysis.result.baseline.modelId,
      report.analysis.result.candidate.modelId,
    ];
    if (
      report.models[0]?.role !== "baseline" ||
      report.models[1]?.role !== "candidate" ||
      modelIds[0] !== expectedModels[0] ||
      modelIds[1] !== expectedModels[1]
    ) {
      context.addIssue({
        code: "custom",
        path: ["models"],
        message:
          "Report models must match analysis baseline and candidate in role order",
      });
    }
    const markupIds = report.markups.map(({ id }) => id);
    const findingIds = report.findings.map(({ id }) => id);
    const viewIds = report.savedViews.map(({ id }) => id);
    const figureIds = report.figures.map(({ id }) => id);
    const analysisMetricIds =
      report.analysis.result.outcome.state === "complete"
        ? report.analysis.result.outcome.metrics.map(({ id }) => id)
        : [];
    const analysisRegionIds =
      report.analysis.result.outcome.state === "complete"
        ? report.analysis.result.outcome.regions.map(({ id }) => id)
        : [];
    const ownedIds = [
      report.id,
      ...modelIds,
      ...analysisMetricIds,
      ...analysisRegionIds,
      ...markupIds,
      ...findingIds,
      ...viewIds,
      ...figureIds,
    ];
    if (new Set(ownedIds.map(String)).size !== ownedIds.length) {
      context.addIssue({
        code: "custom",
        message: "Report entity IDs must be unique across categories",
      });
    }
    const markupSet = new Set(markupIds);
    const findingSet = new Set(findingIds);
    const viewSet = new Set(viewIds);
    const modelSet = new Set(modelIds);
    const metricSet = new Set<string>(analysisMetricIds);
    const regionSet = new Set<string>(analysisRegionIds);
    report.markups.forEach((markup, index) => {
      const frame =
        markup.kind === "callout" ? markup.anchor.frame : markup.start.frame;
      const endFrame =
        markup.kind === "distance" ? markup.end.frame : undefined;
      if (
        (frame.kind === "model" && !modelSet.has(frame.modelId)) ||
        (endFrame?.kind === "model" && !modelSet.has(endFrame.modelId))
      )
        context.addIssue({
          code: "custom",
          path: ["markups", index],
          message: "Markup model frame must reference a report model",
        });
    });
    report.findings.forEach((finding, index) => {
      if (
        finding.source.kind === "automatic" &&
        finding.source.analysisRequestId !== report.analysis.request.requestId
      )
        context.addIssue({
          code: "custom",
          path: ["findings", index, "source", "analysisRequestId"],
          message:
            "Automatic finding must reference the embedded analysis request",
        });
      finding.markupIds.forEach((id, referenceIndex) => {
        if (!markupSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["findings", index, "markupIds", referenceIndex],
            message: "Finding references an unknown markup",
          });
      });
      finding.metricIds.forEach((id, referenceIndex) => {
        if (!metricSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["findings", index, "metricIds", referenceIndex],
            message: "Finding references an unknown analysis metric",
          });
      });
      finding.regionIds.forEach((id, referenceIndex) => {
        if (!regionSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["findings", index, "regionIds", referenceIndex],
            message: "Finding references an unknown analysis region",
          });
      });
      finding.savedViewIds.forEach((id, referenceIndex) => {
        if (!viewSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["findings", index, "savedViewIds", referenceIndex],
            message: "Finding references an unknown saved view",
          });
      });
    });
    report.savedViews.forEach((view, index) => {
      if (
        view.visibility.some(({ modelId }) => !modelSet.has(modelId)) ||
        !modelIds.every((modelId) =>
          view.visibility.some((entry) => entry.modelId === modelId),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["savedViews", index, "visibility"],
          message:
            "Saved-view visibility must cover both report models exactly",
        });
      view.selectedFindingIds.forEach((id, selectionIndex) => {
        if (!findingSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["savedViews", index, "selectedFindingIds", selectionIndex],
            message: "Saved view selects an unknown finding",
          });
      });
      view.selectedMarkupIds.forEach((id, selectionIndex) => {
        if (!markupSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["savedViews", index, "selectedMarkupIds", selectionIndex],
            message: "Saved view selects an unknown markup",
          });
      });
      view.selectedRegionIds.forEach((id, selectionIndex) => {
        if (!regionSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["savedViews", index, "selectedRegionIds", selectionIndex],
            message: "Saved view selects an unknown analysis region",
          });
      });
    });
    report.figures.forEach((figure, index) => {
      if (!viewSet.has(figure.savedViewId))
        context.addIssue({
          code: "custom",
          path: ["figures", index, "savedViewId"],
          message: "Figure references an unknown saved view",
        });
    });
    if (!viewSet.has(report.review.activeSavedViewId))
      context.addIssue({
        code: "custom",
        path: ["review", "activeSavedViewId"],
        message: "Review references an unknown active saved view",
      });
    const resourcePaths = report.models.map(({ sourcePath }) => sourcePath);
    if (new Set(resourcePaths).size !== resourcePaths.length)
      context.addIssue({
        code: "custom",
        message: "Report resource paths must be unique across categories",
      });
    const totalPrimitives = report.figures.reduce(
      (total, figure) => total + figure.primitives.length,
      0,
    );
    if (totalPrimitives > 100_000)
      context.addIssue({
        code: "custom",
        path: ["figures"],
        message: "Report exceeds the total figure-primitive safety ceiling",
      });
    report.models.forEach((model, index) => {
      if (
        model.normalizationProvenance.sourceDigest?.value !==
          model.sourceDigest.value ||
        model.normalizationProvenance.sourceName !== model.sourceName
      )
        context.addIssue({
          code: "custom",
          path: ["models", index, "normalizationProvenance"],
          message: "Report source metadata must match normalization provenance",
        });
    });
  });
export type Report = z.infer<typeof reportSchema>;
