import { describe, expect, it } from "vitest";

import {
  engineStatusReducer,
  IDLE_STATUS,
  isCancelledStatus,
  type EngineStatus,
} from "../src/index.js";

describe("engineStatusReducer", () => {
  it("starts idle", () => {
    expect(IDLE_STATUS).toEqual({ status: "idle" });
  });

  it("transitions idle -> running -> complete, carrying the result unmodified", () => {
    const running = engineStatusReducer(IDLE_STATUS, { type: "start" });
    expect(running).toEqual({ status: "running" });

    const result = { some: "engine result", nested: { indeterminate: true } };
    const complete = engineStatusReducer(running, { type: "success", result });
    expect(complete).toEqual({ status: "complete", result });
    // Identity, not a deep-equal copy: the reducer must never clone or
    // reshape the engine's own result.
    expect((complete as { result: unknown }).result).toBe(result);
  });

  it("reports a genuine failure as failed with reason.kind 'error'", () => {
    const running = engineStatusReducer(IDLE_STATUS, { type: "start" });
    const error = new Error("boom");
    const failed = engineStatusReducer(running, { type: "failure", error });
    expect(failed).toEqual({
      status: "failed",
      reason: { kind: "error", error },
    });
    expect(isCancelledStatus(failed)).toBe(false);
  });

  it("reports a cancellation as failed with reason.kind 'cancelled', distinct from a genuine failure", () => {
    const running = engineStatusReducer(IDLE_STATUS, { type: "start" });
    const cancelled = engineStatusReducer(running, { type: "cancelled" });
    expect(cancelled).toEqual({
      status: "failed",
      reason: { kind: "cancelled" },
    });
    expect(isCancelledStatus(cancelled)).toBe(true);
  });

  it("reset always returns to idle from any state", () => {
    const result = { anything: true };
    const states: EngineStatus<typeof result>[] = [
      { status: "idle" },
      { status: "running" },
      { status: "complete", result },
      { status: "failed", reason: { kind: "cancelled" } },
    ];
    for (const state of states) {
      expect(engineStatusReducer(state, { type: "reset" })).toEqual({
        status: "idle",
      });
    }
  });

  it("never has a fifth top-level status", () => {
    const running = engineStatusReducer(IDLE_STATUS, { type: "start" });
    const cancelled = engineStatusReducer(running, { type: "cancelled" });
    const failed = engineStatusReducer(running, {
      type: "failure",
      error: new Error("x"),
    });
    for (const status of [IDLE_STATUS, running, cancelled, failed]) {
      expect(["idle", "running", "complete", "failed"]).toContain(
        status.status,
      );
    }
  });
});
