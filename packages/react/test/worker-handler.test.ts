import { describe, expect, it } from "vitest";

import { createEngineWorkerHandler } from "../src/worker.js";
import type { EngineWorkerResponse } from "../src/worker.js";
import { analysisRequestFor, boxModel } from "./fixtures.js";

/**
 * Direct unit tests of `createEngineWorkerHandler`, the function a
 * consumer's own worker entry file calls (imported from
 * `@voxelspy/react/worker`, tested here via `../src/worker.js`, its source).
 * These bypass any `Worker`/`postMessage` transport entirely -- they only
 * confirm the handler runs the right engine call and reports the right
 * response shape for each request kind, including failure.
 */
describe("createEngineWorkerHandler", () => {
  function collect() {
    const responses: EngineWorkerResponse[] = [];
    const handler = createEngineWorkerHandler({
      postMessage: (message) => responses.push(message),
    });
    return { responses, handler };
  }

  it("runs inspectModel for an 'inspect' request and reports a closed watertightness verdict", () => {
    const { responses, handler } = collect();
    handler({
      data: { kind: "inspect", requestId: 1, model: boxModel("m") },
    } as never);
    expect(responses).toHaveLength(1);
    const response = responses[0]!;
    expect(response.ok).toBe(true);
    if (response.ok && response.kind === "inspect") {
      expect(response.result.watertightness).toEqual({ state: "closed" });
    }
  });

  it("reports an 'inspect' failure as ok: false with the thrown error's name and message", () => {
    const { responses, handler } = collect();
    handler({
      data: {
        kind: "inspect",
        requestId: 2,
        model: boxModel("m"),
        options: { maxTopologyExamples: -1 },
      },
    } as never);
    const response = responses[0]!;
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.errorName).toBe("RangeError");
      expect(response.message.length).toBeGreaterThan(0);
    }
  });

  it("runs analyzeModelPair for a 'compare' request and reports an indeterminate outcome for unsupported input, not a thrown error", () => {
    const { responses, handler } = collect();
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate");
    handler({
      data: {
        kind: "compare",
        requestId: 3,
        request: analysisRequestFor(baseline, candidate, "surface-distance", {
          executionBudget: { maxMemoryBytes: 1, maxWorkUnits: 1 },
        }),
        baseline,
        candidate,
      },
    } as never);
    const response = responses[0]!;
    expect(response.ok).toBe(true);
    if (response.ok && response.kind === "compare") {
      expect(response.result.outcome.state).toBe("indeterminate");
    }
  });

  it("responds with the same requestId and kind it was given", () => {
    const { responses, handler } = collect();
    handler({
      data: { kind: "inspect", requestId: 42, model: boxModel("m") },
    } as never);
    expect(responses[0]).toMatchObject({ requestId: 42, kind: "inspect" });
  });
});
