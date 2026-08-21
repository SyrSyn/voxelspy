import { useEffect, useState } from "react";
import { Link } from "react-router";
import { createBuiltInSamplePair } from "./sample-models";
import { SamplePreview } from "./SamplePreview";
import { Workbench } from "./Workbench";
import {
  runComparison,
  type ComparisonProgress,
  type CompletedComparison,
} from "./worker-client";

const sample = createBuiltInSamplePair();
let comparisonPromise: Promise<CompletedComparison> | undefined;
const progressListeners = new Set<(value: ComparisonProgress) => void>();

function broadcastProgress(next: ComparisonProgress) {
  for (const listener of progressListeners) listener(next);
}

function getComparisonPromise(): Promise<CompletedComparison> {
  comparisonPromise ??= runComparison(
    sample.baseline,
    sample.candidate,
    broadcastProgress,
  ).catch((reason: unknown) => {
    // Do not cache a failed comparison forever: let the next subscriber retry.
    comparisonPromise = undefined;
    throw reason;
  });
  return comparisonPromise;
}

// Exposed for regression tests covering the module-level cache/broadcast
// behavior without requiring a DOM/React rendering environment. Not used by
// the component itself.
export const __testing = {
  getComparisonPromise,
  subscribeProgress(listener: (value: ComparisonProgress) => void): () => void {
    progressListeners.add(listener);
    return () => progressListeners.delete(listener);
  },
  resetCache(): void {
    comparisonPromise = undefined;
    progressListeners.clear();
  },
};

export function HomeDemoClient() {
  const [progress, setProgress] = useState<ComparisonProgress>({
    stage: "starting",
    message: "Loading the built-in sample",
  });
  const [result, setResult] = useState<CompletedComparison>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const listener = (next: ComparisonProgress) => {
      if (active) setProgress(next);
    };
    progressListeners.add(listener);
    void getComparisonPromise()
      .then((next) => {
        if (active) setResult(next);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The built-in comparison could not be prepared.",
        );
      });
    return () => {
      active = false;
      progressListeners.delete(listener);
    };
  }, []);

  if (error)
    return (
      <section className="sample-error shell" role="alert">
        <span className="eyebrow">Built-in sample</span>
        <h1>Sample comparison unavailable</h1>
        <p>{error}</p>
        <Link className="button button-primary" to="/compare/">
          Import models
        </Link>
      </section>
    );

  if (!result) return <SamplePreview status={progress.message} />;

  return (
    <Workbench
      baseline={result.baseline}
      candidate={result.candidate}
      analysis={result.analysis}
      title="A 3D Toolkit, Free Forever."
      label="Built-in sample · approximate surface analysis"
      variant="sample"
      enableKeyboardShortcuts={false}
      headerAction={
        <>
          <a className="button button-secondary" href="#home-tools-title">
            All tools
          </a>
          <Link className="button button-primary" to="/compare/">
            Import Models
          </Link>
        </>
      }
    />
  );
}
