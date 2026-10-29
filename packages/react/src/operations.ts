import type { NormalizedModel } from "@voxelspy/contracts";
import type {
  CheckClearanceInput,
  CheckClearanceOptions,
  ClearanceCheckResult,
  MeasurementQuery,
  MeasureOptions,
  MeasurementResult,
  SectionPlane,
  SectionOptions,
  SectionResult,
  AssessPrintabilityOptions,
  PrintabilityAssessment,
  SimplifyOptions,
  SimplificationResult,
  EstimateAlignmentInput,
  EstimateAlignmentOptions,
  AlignmentEstimate,
} from "@voxelspy/analysis";
import { collectModelBuffers } from "./protocol.js";

/** Structured-clone payloads, never engine objects, functions, or browser files. */
export interface EngineOperationInputs {
  clearance: {
    readonly input: CheckClearanceInput;
    readonly options?: CheckClearanceOptions;
  };
  measure: {
    readonly model: NormalizedModel;
    readonly query: MeasurementQuery;
    readonly options?: MeasureOptions;
  };
  section: {
    readonly model: NormalizedModel;
    readonly plane: SectionPlane;
    readonly options?: SectionOptions;
  };
  printability: {
    readonly model: NormalizedModel;
    readonly options?: AssessPrintabilityOptions;
  };
  simplify: {
    readonly model: NormalizedModel;
    readonly options: SimplifyOptions;
  };
  alignment: {
    readonly input: EstimateAlignmentInput;
    readonly options?: EstimateAlignmentOptions;
  };
}
export interface EngineOperationResults {
  clearance: ClearanceCheckResult;
  measure: MeasurementResult;
  section: SectionResult;
  printability: PrintabilityAssessment;
  simplify: SimplificationResult;
  alignment: AlignmentEstimate;
}
export type EngineOperationKind = keyof EngineOperationInputs;
export type OperationWorkerRequest = {
  [K in EngineOperationKind]: {
    readonly version: 1;
    readonly kind: K;
    readonly requestId: number;
    readonly input: EngineOperationInputs[K];
  };
}[EngineOperationKind];
export type OperationWorkerResponse = {
  [K in EngineOperationKind]: {
    readonly version: 1;
    readonly kind: K;
    readonly requestId: number;
  } & (
    | { readonly ok: true; readonly result: EngineOperationResults[K] }
    | {
        readonly ok: false;
        readonly message: string;
        readonly errorName: string | undefined;
      }
  );
}[EngineOperationKind];

/** Models are borrowed by default; only an explicit transfer detaches them. */
export function operationModelBuffers(
  request: OperationWorkerRequest,
): readonly ArrayBuffer[] {
  let models: readonly NormalizedModel[];
  switch (request.kind) {
    case "clearance":
      models = [
        request.input.input.first.model,
        request.input.input.second.model,
      ];
      break;
    case "alignment":
      models =
        request.input.input.method === "iterative-closest-point"
          ? [request.input.input.moving, request.input.input.fixed.model]
          : [];
      break;
    default:
      models = [request.input.model];
  }
  return [
    ...new Set(models.flatMap((model) => [...collectModelBuffers(model)])),
  ];
}
