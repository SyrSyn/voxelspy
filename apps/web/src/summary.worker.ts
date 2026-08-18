/// <reference lib="webworker" />

import { summarizeModelComparison } from "@voxelspy/analysis";

import type {
  SummaryWorkerRequest,
  SummaryWorkerResponse,
} from "./summary-worker-client";

const scope = self as DedicatedWorkerGlobalScope;

scope.addEventListener(
  "message",
  (event: MessageEvent<SummaryWorkerRequest>) => {
    const { requestId, baseline, candidate, analysis } = event.data;
    let response: SummaryWorkerResponse;
    try {
      const summary = summarizeModelComparison(baseline, candidate, analysis);
      response = { requestId, ok: true, summary };
    } catch (error) {
      response = {
        requestId,
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Geometry summary failed safely.",
      };
    }
    scope.postMessage(response);
  },
);
