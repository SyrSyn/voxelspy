import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComparisonProgress } from "./worker-client";

const runComparison = vi.fn();

// Only `runComparison` itself needs mocking; the rest of the module's real
// exports (e.g. the ANALYSIS_MEMORY_* constants) still need to be present
// because `Workbench` -> `capability` reads them at module scope.
vi.mock("./worker-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-client")>()),
  runComparison: (...args: unknown[]) => runComparison(...args),
}));
vi.mock("./sample-models", () => ({
  createBuiltInSamplePair: () => ({
    id: "test-sample",
    title: "Test sample",
    summary: "",
    baseline: { name: "baseline" },
    candidate: { name: "candidate" },
  }),
}));

describe("HomeDemoClient built-in comparison cache", () => {
  afterEach(() => {
    vi.resetModules();
    runComparison.mockReset();
  });

  it("does not cache a rejected comparison forever: the next subscriber retries", async () => {
    // Constructed inside the mock implementation (rather than passed as an
    // already-created rejected promise) so a `.catch` is always attached in
    // the same synchronous step that creates it, avoiding a spurious
    // unhandled-rejection warning.
    runComparison.mockImplementationOnce(() =>
      Promise.reject(new Error("boom")),
    );
    runComparison.mockImplementationOnce(() =>
      Promise.resolve({ ok: true } as never),
    );
    const { __testing } = await import("./HomeDemoClient");

    await expect(__testing.getComparisonPromise()).rejects.toThrow("boom");
    // A second subscriber (e.g. navigate away and back) must retry, not
    // replay the same cached rejection forever.
    await expect(__testing.getComparisonPromise()).resolves.toEqual({
      ok: true,
    });
    expect(runComparison).toHaveBeenCalledTimes(2);
  });

  it("routes progress updates to every currently subscribed listener, not only the first", async () => {
    let deliverProgress: ((value: ComparisonProgress) => void) | undefined;
    runComparison.mockImplementationOnce(
      (
        _baseline: unknown,
        _candidate: unknown,
        progress: (value: ComparisonProgress) => void,
      ) => {
        deliverProgress = progress;
        return new Promise(() => {
          // never settles; we only care about progress delivery here.
        });
      },
    );
    const { __testing } = await import("./HomeDemoClient");

    const first: ComparisonProgress[] = [];
    const second: ComparisonProgress[] = [];
    const unsubscribeFirst = __testing.subscribeProgress((value) =>
      first.push(value),
    );
    const unsubscribeSecond = __testing.subscribeProgress((value) =>
      second.push(value),
    );
    void __testing.getComparisonPromise();

    expect(deliverProgress).toBeDefined();
    deliverProgress!({ stage: "starting", message: "step one" });
    expect(first).toEqual([{ stage: "starting", message: "step one" }]);
    expect(second).toEqual([{ stage: "starting", message: "step one" }]);

    // Unsubscribing (component unmount) must stop future delivery to that
    // listener while the still-mounted subscriber keeps receiving updates.
    unsubscribeFirst();
    deliverProgress!({ stage: "starting", message: "step two" });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);

    unsubscribeSecond();
  });
});
