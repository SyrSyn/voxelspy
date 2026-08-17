import { z } from "zod";
import { warningSchema } from "./geometry.js";
import {
  entityIdSchema,
  methodIdSchema,
  metricIdSchema,
  modelIdSchema,
  portableJsonObjectSchema,
  regionIdSchema,
  requestIdSchema,
  rigidTransformSchema,
  vec3Schema,
} from "./primitives.js";

export const toleranceSchema = z
  .strictObject({
    distanceMillimetres: z.number().finite().nonnegative().optional(),
    angularRadians: z.number().finite().min(0).max(Math.PI).optional(),
  })
  .refine(
    (value) =>
      value.distanceMillimetres !== undefined ||
      value.angularRadians !== undefined,
    "At least one tolerance must be specified",
  );
export type Tolerance = z.infer<typeof toleranceSchema>;

export const methodDescriptorSchema = z.strictObject({
  id: methodIdSchema,
  version: z.string().min(1).max(128),
  parameters: portableJsonObjectSchema,
});
export type MethodDescriptor = z.infer<typeof methodDescriptorSchema>;

export const modelBindingSchema = z.strictObject({
  modelId: modelIdSchema,
  modelToComparison: rigidTransformSchema,
});

export const analysisRequestSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    requestId: requestIdSchema,
    baseline: modelBindingSchema,
    candidate: modelBindingSchema,
    method: methodDescriptorSchema,
    tolerance: toleranceSchema,
    executionBudget: z
      .strictObject({
        maxWorkUnits: z.number().int().safe().positive(),
        maxMemoryBytes: z.number().int().safe().positive(),
      })
      .optional(),
  })
  .refine((request) => request.baseline.modelId !== request.candidate.modelId, {
    path: ["candidate", "modelId"],
    message: "Baseline and candidate must be different models",
  });
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

export const preconditionEvidenceSchema = z.strictObject({
  id: entityIdSchema,
  passed: z.literal(true),
  details: portableJsonObjectSchema.optional(),
});

export const meshAssessmentSchema = z
  .strictObject({
    modelId: modelIdSchema,
    closed: z.boolean(),
    consistentlyOriented: z.boolean(),
    boundaryEdgeCount: z.number().int().safe().nonnegative(),
    nonManifoldEdgeCount: z.number().int().safe().nonnegative(),
    degenerateTriangleCount: z.number().int().safe().nonnegative(),
    reasons: z.array(entityIdSchema).max(128),
    preconditions: z.array(preconditionEvidenceSchema).max(128),
  })
  .refine(
    (assessment) => !assessment.closed || assessment.boundaryEdgeCount === 0,
    {
      path: ["boundaryEdgeCount"],
      message: "Closed geometry cannot have boundary edges",
    },
  );
export type MeshAssessment = z.infer<typeof meshAssessmentSchema>;

export const metricSchema = z
  .strictObject({
    id: metricIdSchema,
    value: z.number().finite(),
    unit: z.enum([
      "millimetre",
      "square-millimetre",
      "cubic-millimetre",
      "ratio",
      "count",
    ]),
  })
  .refine(
    (metric) => metric.unit !== "count" || Number.isSafeInteger(metric.value),
    { path: ["value"], message: "Count metrics must be safe integers" },
  );
export type AnalysisMetric = z.infer<typeof metricSchema>;

export const changeRegionSchema = z
  .strictObject({
    id: regionIdSchema,
    frame: z.literal("comparison"),
    category: z.enum(["added", "removed", "deviation"]),
    bounds: z.strictObject({ min: vec3Schema, max: vec3Schema }),
    anchor: vec3Schema,
    geometry: z
      .strictObject({
        kind: z.literal("triangle-set"),
        model: z.enum(["baseline", "candidate"]),
        triangleIndices: z
          .array(z.number().int().safe().nonnegative())
          .max(1_000_000),
      })
      .optional(),
    metricIds: z.array(metricIdSchema).max(128),
    warningCodes: z.array(entityIdSchema).max(128),
  })
  .superRefine(({ bounds, anchor, geometry }, context) => {
    bounds.min.forEach((minimum, index) => {
      const maximum = bounds.max[index];
      const coordinate = anchor[index];
      if (maximum === undefined || minimum > maximum) {
        context.addIssue({
          code: "custom",
          path: ["bounds"],
          message: "Region bounds must be ordered",
        });
      } else if (
        coordinate === undefined ||
        coordinate < minimum ||
        coordinate > maximum
      ) {
        context.addIssue({
          code: "custom",
          path: ["anchor"],
          message: "Region anchor must lie within its bounds",
        });
      }
    });
    if (
      geometry !== undefined &&
      new Set(geometry.triangleIndices).size !== geometry.triangleIndices.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["geometry", "triangleIndices"],
        message: "Region triangle references must be unique",
      });
    }
  })
  .superRefine(({ metricIds, warningCodes }, context) => {
    if (new Set(metricIds).size !== metricIds.length) {
      context.addIssue({
        code: "custom",
        path: ["metricIds"],
        message: "Region metric references must be unique",
      });
    }
    if (new Set(warningCodes).size !== warningCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["warningCodes"],
        message: "Region warning references must be unique",
      });
    }
  });

const completeBase = {
  state: z.literal("complete"),
  requestedMethod: methodDescriptorSchema,
  effectiveMethod: methodDescriptorSchema,
  requestedTolerance: toleranceSchema,
  effectiveTolerance: toleranceSchema,
  validation: z.array(meshAssessmentSchema).length(2),
  metrics: z.array(metricSchema).max(10_000),
  regions: z.array(changeRegionSchema).max(100_000),
  orderedRegionIds: z.array(regionIdSchema).max(100_000),
  adjustments: z
    .array(
      z.strictObject({
        field: z.enum(["parameters", "tolerance"]),
        reason: z.string().min(1).max(1_000),
      }),
    )
    .max(32),
};

const approximateOutcomeSchema = z.strictObject({
  ...completeBase,
  semantics: z.literal("approximate"),
  uncertainty: z.strictObject({
    description: z.string().min(1).max(2_000),
    parameters: portableJsonObjectSchema,
  }),
});

const exactOutcomeSchema = z.strictObject({
  ...completeBase,
  semantics: z.literal("exact-within-validated-preconditions"),
  validatedDomain: z.strictObject({
    id: entityIdSchema,
    description: z.string().min(1).max(2_000),
    preconditionIds: z.array(entityIdSchema).min(1).max(128),
  }),
});

const indeterminateOutcomeSchema = z.strictObject({
  state: z.literal("indeterminate"),
  code: entityIdSchema,
  reasons: z.array(z.string().min(1).max(1_000)).min(1).max(128),
  requestedMethod: methodDescriptorSchema,
  requestedTolerance: toleranceSchema,
  validation: z.array(meshAssessmentSchema).max(2),
});

export const analysisOutcomeSchema = z.union([
  approximateOutcomeSchema,
  exactOutcomeSchema,
  indeterminateOutcomeSchema,
]);
export type AnalysisOutcome = z.infer<typeof analysisOutcomeSchema>;

export const analysisResultSchema = z
  .strictObject({
    contractVersion: z.literal(1),
    requestId: requestIdSchema,
    baseline: modelBindingSchema,
    candidate: modelBindingSchema,
    warnings: z.array(warningSchema).max(10_000),
    outcome: analysisOutcomeSchema,
  })
  .superRefine((result, context) => {
    if (result.baseline.modelId === result.candidate.modelId) {
      context.addIssue({
        code: "custom",
        path: ["candidate", "modelId"],
        message: "Baseline and candidate must differ",
      });
    }
    const permittedModelIds = new Set([
      result.baseline.modelId,
      result.candidate.modelId,
    ]);
    const assessedModels = result.outcome.validation.map(
      ({ modelId }) => modelId,
    );
    if (
      new Set(assessedModels).size !== assessedModels.length ||
      assessedModels.some((modelId) => !permittedModelIds.has(modelId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "validation"],
        message: "Validation must uniquely reference a requested model",
      });
    }
    result.outcome.validation.forEach((assessment, index) => {
      const preconditionIds = assessment.preconditions.map(({ id }) => id);
      if (new Set(preconditionIds).size !== preconditionIds.length) {
        context.addIssue({
          code: "custom",
          path: ["outcome", "validation", index, "preconditions"],
          message: "Precondition evidence IDs must be unique per model",
        });
      }
    });
    const warningCodes = result.warnings.map(({ code }) => code);
    if (new Set(warningCodes).size !== warningCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["warnings"],
        message: "Warning codes must be unique",
      });
    }
    if (result.outcome.state !== "complete") return;
    if (
      result.outcome.requestedMethod.id !== result.outcome.effectiveMethod.id ||
      result.outcome.requestedMethod.version !==
        result.outcome.effectiveMethod.version
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "effectiveMethod"],
        message: "A result cannot silently substitute another method",
      });
    }
    if (
      new Set(assessedModels).size !== 2 ||
      !assessedModels.includes(result.baseline.modelId) ||
      !assessedModels.includes(result.candidate.modelId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "validation"],
        message: "Validation must assess baseline and candidate exactly once",
      });
    }
    const metricIds = result.outcome.metrics.map(({ id }) => id);
    if (new Set(metricIds).size !== metricIds.length) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "metrics"],
        message: "Metric IDs must be unique",
      });
    }
    const regionIds = result.outcome.regions.map(({ id }) => id);
    if (new Set(regionIds).size !== regionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "regions"],
        message: "Region IDs must be unique",
      });
    }
    if (
      new Set(
        [
          result.baseline.modelId,
          result.candidate.modelId,
          ...metricIds,
          ...regionIds,
        ].map(String),
      ).size !==
      2 + metricIds.length + regionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Model, metric, and region IDs must not collide",
      });
    }
    const regionIdSet = new Set(regionIds);
    if (
      new Set(result.outcome.orderedRegionIds).size !== regionIds.length ||
      result.outcome.orderedRegionIds.length !== regionIds.length ||
      result.outcome.orderedRegionIds.some((id) => !regionIdSet.has(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "orderedRegionIds"],
        message: "Ordered region IDs must be an exact permutation",
      });
    }
    const metricSet = new Set(metricIds);
    const warningSet = new Set(warningCodes);
    result.outcome.regions.forEach((region, regionIndex) => {
      region.metricIds.forEach((id, metricIndex) => {
        if (!metricSet.has(id))
          context.addIssue({
            code: "custom",
            path: ["outcome", "regions", regionIndex, "metricIds", metricIndex],
            message: "Unknown metric ID",
          });
      });
      region.warningCodes.forEach((code, warningIndex) => {
        if (!warningSet.has(code))
          context.addIssue({
            code: "custom",
            path: [
              "outcome",
              "regions",
              regionIndex,
              "warningCodes",
              warningIndex,
            ],
            message: "Unknown warning code",
          });
      });
    });
    const parameterChanged = !portableEqual(
      result.outcome.requestedMethod.parameters,
      result.outcome.effectiveMethod.parameters,
    );
    const toleranceChanged = !portableEqual(
      result.outcome.requestedTolerance,
      result.outcome.effectiveTolerance,
    );
    const adjustmentFields = new Set(
      result.outcome.adjustments.map(({ field }) => field),
    );
    if (adjustmentFields.size !== result.outcome.adjustments.length) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "adjustments"],
        message: "Adjustment fields must be unique",
      });
    }
    if (parameterChanged && !adjustmentFields.has("parameters")) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "adjustments"],
        message: "Effective parameter changes require an explicit adjustment",
      });
    }
    if (toleranceChanged && !adjustmentFields.has("tolerance")) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "adjustments"],
        message: "Effective tolerance changes require an explicit adjustment",
      });
    }
    if (!parameterChanged && adjustmentFields.has("parameters")) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "adjustments"],
        message: "Parameter adjustments require an effective change",
      });
    }
    if (!toleranceChanged && adjustmentFields.has("tolerance")) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "adjustments"],
        message: "Tolerance adjustments require an effective change",
      });
    }
    if (result.outcome.semantics === "exact-within-validated-preconditions") {
      const required = result.outcome.validatedDomain.preconditionIds;
      if (new Set(required).size !== required.length) {
        context.addIssue({
          code: "custom",
          path: ["outcome", "validatedDomain", "preconditionIds"],
          message: "Validated-domain precondition IDs must be unique",
        });
      }
      result.outcome.validatedDomain.preconditionIds.forEach((id, index) => {
        result.outcome.validation.forEach((assessment, assessmentIndex) => {
          if (!assessment.preconditions.some((evidence) => evidence.id === id))
            context.addIssue({
              code: "custom",
              path: ["outcome", "validation", assessmentIndex, "preconditions"],
              message: `Exact-domain precondition ${String(id)} is not proven for this model`,
            });
        });
      });
    }
  });
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

function portableEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => portableEqual(value, right[index]))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          portableEqual(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return false;
}

export const analysisExchangeSchema = z
  .strictObject({
    request: analysisRequestSchema,
    result: analysisResultSchema,
  })
  .superRefine(({ request, result }, context) => {
    const bindingMatches = (
      requested: z.infer<typeof modelBindingSchema>,
      returned: z.infer<typeof modelBindingSchema>,
    ) =>
      requested.modelId === returned.modelId &&
      requested.modelToComparison.every(
        (value, index) => value === returned.modelToComparison[index],
      );
    if (
      request.requestId !== result.requestId ||
      !bindingMatches(request.baseline, result.baseline) ||
      !bindingMatches(request.candidate, result.candidate)
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Result correlation and model bindings must match the request",
      });
    }
    if (
      request.method.id !== result.outcome.requestedMethod.id ||
      request.method.version !== result.outcome.requestedMethod.version ||
      !portableEqual(
        request.method.parameters,
        result.outcome.requestedMethod.parameters,
      ) ||
      !portableEqual(request.tolerance, result.outcome.requestedTolerance)
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "outcome"],
        message: "Result requested parameters must match the request",
      });
    }
  });

/** Malformed messages and runtime failures are errors, not analysis outcomes. */
export const analysisErrorSchema = z.strictObject({
  contractVersion: z.literal(1),
  requestId: requestIdSchema.optional(),
  code: entityIdSchema,
  message: z.string().min(1).max(2_000),
  details: portableJsonObjectSchema.optional(),
});
export type AnalysisError = z.infer<typeof analysisErrorSchema>;
