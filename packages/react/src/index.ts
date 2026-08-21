/**
 * `@voxelspy/react` -- optional React hooks and components over
 * `@voxelspy/analysis`'s public engine surface. See the package README for
 * the full worker-supply contract, status model, and what the presentational
 * components do and do not guarantee.
 *
 * This module is the main-thread half of the package: it imports `react`
 * (a peer dependency, never bundled by this package itself) and is never
 * imported from a worker file -- worker-side code imports
 * `@voxelspy/react/worker` instead (see `worker.ts`).
 */
export {
  EngineCancelledError,
  EngineProtocolError,
  describeEngineFailure,
} from "./errors.js";
export {
  engineStatusReducer,
  IDLE_STATUS,
  isCancelledStatus,
  type EngineAction,
  type EngineFailureReason,
  type EngineStatus,
} from "./status.js";
export type {
  EngineCallOptions,
  EngineWorkerFactory,
} from "./worker-client.js";
export { createEngineRunner, type EngineRunnerController } from "./runner.js";
export {
  useModelInspection,
  type RunModelInspectionOptions,
  type UseModelInspectionResult,
} from "./useModelInspection.js";
export {
  useModelComparison,
  type RunModelComparisonOptions,
  type UseModelComparisonResult,
} from "./useModelComparison.js";
export {
  InspectionFindings,
  type InspectionFindingsProps,
} from "./components/InspectionFindings.js";
export {
  ComparisonFindings,
  type ComparisonFindingsProps,
} from "./components/ComparisonFindings.js";
