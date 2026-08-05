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

export function HomeDemoClient() {
  const [progress, setProgress] = useState<ComparisonProgress>({
    stage: "starting",
    message: "Loading the built-in sample",
  });
  const [result, setResult] = useState<CompletedComparison>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    comparisonPromise ??= runComparison(
      sample.baseline,
      sample.candidate,
      (next) => {
        if (active) setProgress(next);
      },
    );
    void comparisonPromise
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
        <Link className="button button-primary" to="/compare/">
          Import Models
        </Link>
      }
    />
  );
}
