/**
 * Entry point for `@voxelspy/react/worker` -- the half of this package's
 * worker-supply contract meant to be imported from a consumer's own worker
 * file, never from application code that runs on the main thread. See
 * `createEngineWorkerHandler`'s doc comment and the package README's
 * "Worker supply contract" section for the full copy-pasteable pattern.
 *
 * This module has no dependency on `react`: a worker is not a React
 * environment, and this package's main entry point (`@voxelspy/react`,
 * built from `src/index.ts`) is a separate, independent build target that
 * this file's module graph never reaches into.
 */
export { createEngineWorkerHandler } from "./worker-handler.js";
export type {
  CompareWorkerFailure,
  CompareWorkerRequest,
  CompareWorkerSuccess,
  EngineWorkerRequest,
  EngineWorkerResponse,
  EngineWorkerScope,
  InspectWorkerFailure,
  InspectWorkerRequest,
  InspectWorkerSuccess,
} from "./protocol.js";
