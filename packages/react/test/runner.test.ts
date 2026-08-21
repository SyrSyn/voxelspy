import { describe, expect, it } from "vitest";

import { createEngineRunner, EngineCancelledError } from "../src/index.js";
import type { EngineAction } from "../src/index.js";

/** Resolves/rejects only when told to, so tests can control exactly when an
 *  in-flight `execute` call settles relative to a subsequent `run()`/`cancel()`. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createEngineRunner", () => {
  it("dispatches start then success on a completed run", async () => {
    const actions: EngineAction<string>[] = [];
    const runner = createEngineRunner<[value: string], string>(
      async (_signal, value) => value.toUpperCase(),
      (action) => actions.push(action),
    );
    runner.run("hello");
    expect(actions).toEqual([{ type: "start" }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(actions).toEqual([
      { type: "start" },
      { type: "success", result: "HELLO" },
    ]);
  });

  it("dispatches failure for a genuine rejection", async () => {
    const actions: EngineAction<string>[] = [];
    const failure = new Error("engine exploded");
    const runner = createEngineRunner<[], string>(
      async () => {
        throw failure;
      },
      (action) => actions.push(action),
    );
    runner.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions).toEqual([
      { type: "start" },
      { type: "failure", error: failure },
    ]);
  });

  it("dispatches cancelled (not failure) when execute rejects with EngineCancelledError", async () => {
    const actions: EngineAction<string>[] = [];
    const runner = createEngineRunner<[], string>(
      async () => {
        throw new EngineCancelledError();
      },
      (action) => actions.push(action),
    );
    runner.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions).toEqual([{ type: "start" }, { type: "cancelled" }]);
  });

  it("cancel() aborts the run's own signal", async () => {
    const actions: EngineAction<string>[] = [];
    let observedSignal: AbortSignal | undefined;
    const runner = createEngineRunner<[], string>(
      (signal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () =>
            reject(new EngineCancelledError()),
          );
        }),
      (action) => actions.push(action),
    );
    runner.run();
    expect(observedSignal?.aborted).toBe(false);
    runner.cancel();
    expect(observedSignal?.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(actions).toEqual([{ type: "start" }, { type: "cancelled" }]);
  });

  it("a newer run() supersedes and aborts the previous one, and only the newer result is dispatched", async () => {
    const actions: EngineAction<string>[] = [];
    const first = deferred<string>();
    const second = deferred<string>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const runner = createEngineRunner<[], string>(
      (signal) => {
        signals.push(signal);
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
      (action) => actions.push(action),
    );
    runner.run();
    runner.run();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    // The stale first call resolving late must never overwrite the newer run's outcome.
    first.resolve("stale");
    second.resolve("current");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(actions).toEqual([
      { type: "start" },
      { type: "start" },
      { type: "success", result: "current" },
    ]);
  });

  it("reset() aborts any in-flight run, discards its outcome, and dispatches reset", async () => {
    const actions: EngineAction<string>[] = [];
    const pending = deferred<string>();
    const runner = createEngineRunner<[], string>(
      () => pending.promise,
      (action) => actions.push(action),
    );
    runner.run();
    runner.reset();
    pending.resolve("too late");
    await Promise.resolve();
    await Promise.resolve();
    expect(actions).toEqual([{ type: "start" }, { type: "reset" }]);
  });

  it("wraps a non-Error rejection in an Error for the failure action", async () => {
    const actions: EngineAction<string>[] = [];
    const runner = createEngineRunner<[], string>(
      () => Promise.reject("plain string rejection"),
      (action) => actions.push(action),
    );
    runner.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions).toHaveLength(2);
    const failureAction = actions[1];
    expect(failureAction?.type).toBe("failure");
    if (failureAction?.type === "failure") {
      expect(failureAction.error).toBeInstanceOf(Error);
      expect(failureAction.error.message).toContain("plain string rejection");
    }
  });
});
