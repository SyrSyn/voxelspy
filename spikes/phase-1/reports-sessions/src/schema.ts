import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const isoDateTime = z.iso.datetime({ offset: true });
const finiteNumber = z.number();
const vector3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);

export const sourceModelSchema = z.object({
  id: identifier,
  role: z.enum(["baseline", "candidate"]),
  name: z.string().min(1).max(200),
  archivePath: z.string().regex(/^models\/[a-z0-9][a-z0-9._-]*$/),
  mediaType: z.literal("model/stl"),
  unit: z.enum(["mm", "cm", "m", "in"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  transform: z.tuple([
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
  ]),
  provenance: z.object({
    kind: z.literal("generated"),
    generator: z.string().min(1).max(160),
    license: z.string().min(1).max(80),
  }),
});

const commonMarkup = z.object({
  id: identifier,
  label: z.string().min(1).max(120),
  visible: z.boolean(),
  createdAt: isoDateTime,
  author: z.string().min(1).max(120),
});

export const calloutSchema = commonMarkup.extend({
  type: z.literal("callout"),
  modelId: identifier,
  anchor: vector3,
  text: z.string().min(1).max(400),
});

export const distanceSchema = commonMarkup
  .extend({
    type: z.literal("distance"),
    modelId: identifier,
    start: vector3,
    end: vector3,
    value: finiteNumber.nonnegative(),
    unit: z.enum(["mm", "cm", "m", "in"]),
  })
  .superRefine((distance, context) => {
    const expected = Math.hypot(
      distance.end[0] - distance.start[0],
      distance.end[1] - distance.start[1],
      distance.end[2] - distance.start[2],
    );
    if (Math.abs(expected - distance.value) > Math.max(1e-9, expected * 1e-9)) {
      context.addIssue({
        code: "custom",
        message: "Distance value does not match its two endpoints",
        path: ["value"],
      });
    }
  });

export const markupSchema = z.discriminatedUnion("type", [
  calloutSchema,
  distanceSchema,
]);

export const findingSchema = z.object({
  id: identifier,
  origin: z.literal("automatic"),
  detector: z.object({
    id: identifier,
    version: z.string().min(1).max(40),
    parameters: z.record(
      z.string(),
      z.union([z.string(), finiteNumber, z.boolean()]),
    ),
  }),
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(800),
  confidence: finiteNumber.min(0).max(1),
  markupIds: z.array(identifier).max(64),
  createdAt: isoDateTime,
});

export const savedViewSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(120),
  camera: z.object({
    position: vector3,
    target: vector3,
    up: vector3,
    projection: z.enum(["perspective", "orthographic"]),
    fieldOfViewDegrees: finiteNumber.min(1).max(179),
  }),
  visibility: z.record(identifier, z.boolean()),
  selectedFindingIds: z.array(identifier).max(256),
  selectedMarkupIds: z.array(identifier).max(256),
  sectionPlane: z
    .object({
      normal: vector3,
      constant: finiteNumber,
    })
    .nullable(),
});

export const figureInputSchema = z.object({
  id: identifier,
  title: z.string().min(1).max(160),
  width: z.number().int().min(320).max(4096),
  height: z.number().int().min(180).max(4096),
  viewId: identifier,
  primitives: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("line"),
          from: z.tuple([finiteNumber, finiteNumber]),
          to: z.tuple([finiteNumber, finiteNumber]),
          color: z.string().regex(/^#[a-f0-9]{6}$/),
          width: finiteNumber.min(0.1).max(20),
        }),
        z.object({
          kind: z.literal("label"),
          at: z.tuple([finiteNumber, finiteNumber]),
          text: z.string().min(1).max(200),
          color: z.string().regex(/^#[a-f0-9]{6}$/),
        }),
      ]),
    )
    .max(10_000),
});

export const reportSchema = z
  .object({
    schema: z.literal("https://voxelspy.dev/schemas/report/v1"),
    schemaVersion: z.literal(1),
    id: identifier,
    title: z.string().min(1).max(200),
    generatedAt: isoDateTime,
    generator: z.object({
      name: z.literal("VoxelSpy"),
      version: z.string().min(1).max(40),
    }),
    models: z.array(sourceModelSchema).length(2),
    markups: z.array(markupSchema).max(10_000),
    findings: z.array(findingSchema).max(10_000),
    savedViews: z.array(savedViewSchema).min(1).max(1_000),
    figures: z.array(figureInputSchema).min(1).max(1_000),
    review: z.object({
      activeViewId: identifier,
      notes: z.string().max(20_000),
      status: z.enum(["draft", "reviewed"]),
    }),
  })
  .superRefine((report, context) => {
    const modelIds = new Set(report.models.map(({ id }) => id));
    const markupIds = new Set(report.markups.map(({ id }) => id));
    const findingIds = new Set(report.findings.map(({ id }) => id));
    const viewIds = new Set(report.savedViews.map(({ id }) => id));
    const ids = [...modelIds, ...markupIds, ...findingIds, ...viewIds];
    if (ids.length !== new Set(ids).size) {
      context.addIssue({
        code: "custom",
        message: "IDs must be unique across report entities",
      });
    }
    for (const [index, markup] of report.markups.entries()) {
      if (!modelIds.has(markup.modelId)) {
        context.addIssue({
          code: "custom",
          message: "Unknown markup model",
          path: ["markups", index, "modelId"],
        });
      }
    }
    for (const [index, finding] of report.findings.entries()) {
      for (const markupId of finding.markupIds) {
        if (!markupIds.has(markupId)) {
          context.addIssue({
            code: "custom",
            message: "Unknown finding markup",
            path: ["findings", index, "markupIds"],
          });
        }
      }
    }
    if (!viewIds.has(report.review.activeViewId)) {
      context.addIssue({
        code: "custom",
        message: "Unknown active view",
        path: ["review", "activeViewId"],
      });
    }
    for (const [index, figure] of report.figures.entries()) {
      if (!viewIds.has(figure.viewId)) {
        context.addIssue({
          code: "custom",
          message: "Unknown figure view",
          path: ["figures", index, "viewId"],
        });
      }
    }
    for (const [index, view] of report.savedViews.entries()) {
      for (const findingId of view.selectedFindingIds) {
        if (!findingIds.has(findingId)) {
          context.addIssue({
            code: "custom",
            message: "Unknown selected finding",
            path: ["savedViews", index, "selectedFindingIds"],
          });
        }
      }
      for (const markupId of view.selectedMarkupIds) {
        if (!markupIds.has(markupId)) {
          context.addIssue({
            code: "custom",
            message: "Unknown selected markup",
            path: ["savedViews", index, "selectedMarkupIds"],
          });
        }
      }
    }
  });

export type Report = z.infer<typeof reportSchema>;
export type FigureInput = z.infer<typeof figureInputSchema>;

export function parseReport(input: unknown): Report {
  return reportSchema.parse(input);
}

export function parseVersionedReport(input: unknown): Report {
  if (
    typeof input !== "object" ||
    input === null ||
    !("schemaVersion" in input)
  ) {
    throw new Error("Report schemaVersion is required");
  }
  if ((input as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error(
      `Unsupported report schema version: ${String((input as { schemaVersion?: unknown }).schemaVersion)}`,
    );
  }
  return parseReport(input);
}
