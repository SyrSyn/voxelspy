import { describe, expect, it } from "vitest";

import {
  ComparisonFindings,
  createEngineRunner,
  engineStatusReducer,
  IDLE_STATUS,
  InspectionFindings,
  useModelComparison,
  useModelInspection,
} from "../src/index.js";
import type { EngineStatus } from "../src/index.js";
import {
  runModelInspection,
  runModelComparison,
} from "../src/worker-client.js";
import { FakeEngineWorker } from "./fake-worker.js";
import { analysisRequestFor, boxModel } from "./fixtures.js";

/**
 * Consumer-facing tests: everything imported here comes through this
 * package's public entry point (`@voxelspy/react`, i.e. `../src/index.js`),
 * the same way an application would import it. `status.test.ts` and
 * `runner.test.ts` already cover the reducer and control-flow logic in
 * isolation; this file confirms the public surface a consumer actually sees
 * is wired together correctly and produces the documented status shape for
 * the three paths the bead calls out explicitly: cancellation, failure, and
 * an indeterminate engine outcome. It drives `createEngineRunner` directly
 * with the real `runModelInspection`/`runModelComparison` engine calls
 * (against a fake in-process worker) rather than rendering
 * `useModelInspection`/`useModelComparison` -- this repository has no DOM
 * test renderer (see the README's "What is verified and what is not"), and
 * both hooks are documented as thin `useReducer` wrappers around exactly
 * this runner, so driving the runner this way exercises the same logic the
 * hooks expose.
 */
describe("public entry point surface", () => {
  it("exports the hooks and components as functions", () => {
    expect(typeof useModelInspection).toBe("function");
    expect(typeof useModelComparison).toBe("function");
    expect(typeof InspectionFindings).toBe("function");
    expect(typeof ComparisonFindings).toBe("function");
  });
});

describe("documented status shape: cancellation, failure, and indeterminate paths", () => {
  it("cancellation produces { status: 'failed', reason: { kind: 'cancelled' } }, never 'complete'", async () => {
    let status: EngineStatus<unknown> = IDLE_STATUS;
    const dispatch = (action: Parameters<typeof engineStatusReducer>[1]) => {
      status = engineStatusReducer(status, action);
    };
    const worker = new FakeEngineWorker({ delayMs: 20 });
    const runner = createEngineRunner(
      (signal) =>
        runModelInspection(() => worker as never, boxModel("m"), undefined, {
          signal,
        }),
      dispatch,
    );
    runner.run();
    expect(status).toEqual({ status: "running" });
    runner.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(status).toEqual({ status: "failed", reason: { kind: "cancelled" } });
  });

  it("a genuine engine failure produces { status: 'failed', reason: { kind: 'error' } } carrying the real error", async () => {
    let status: EngineStatus<unknown> = IDLE_STATUS;
    const dispatch = (action: Parameters<typeof engineStatusReducer>[1]) => {
      status = engineStatusReducer(status, action);
    };
    const worker = new FakeEngineWorker();
    const runner = createEngineRunner(
      (signal) =>
        runModelInspection(
          () => worker as never,
          boxModel("m"),
          { maxTopologyExamples: -1 },
          {
            signal,
          },
        ),
      dispatch,
    );
    runner.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(status.status).toBe("failed");
    if (status.status === "failed" && status.reason.kind === "error") {
      expect(status.reason.error.name).toBe("RangeError");
    } else {
      expect.unreachable("expected a genuine 'error' failure reason");
    }
  });

  it("an indeterminate AnalysisResult is reported as 'complete', not 'failed'", async () => {
    let status: EngineStatus<{ outcome: { state: string } }> = IDLE_STATUS;
    const dispatch = (
      action: Parameters<
        typeof engineStatusReducer<{ outcome: { state: string } }>
      >[1],
    ) => {
      status = engineStatusReducer(status, action);
    };
    const worker = new FakeEngineWorker();
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate");
    const runner = createEngineRunner(
      (signal) =>
        runModelComparison(
          () => worker as never,
          analysisRequestFor(baseline, candidate, "surface-distance", {
            executionBudget: { maxMemoryBytes: 1, maxWorkUnits: 1 },
          }),
          baseline,
          candidate,
          { signal },
        ),
      dispatch,
    );
    runner.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(status.status).toBe("complete");
    if (status.status === "complete") {
      expect(status.result.outcome.state).toBe("indeterminate");
    }
  });
});
