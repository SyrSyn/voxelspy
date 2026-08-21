import { analyzeModelPair, inspectModel } from "@voxelspy/analysis";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComparisonFindings, InspectionFindings } from "../src/index.js";
import type { EngineStatus } from "../src/index.js";
import { analysisRequestFor, boxModel } from "./fixtures.js";

/**
 * Structural accessibility verification, not runtime interaction testing.
 *
 * This repository has no DOM test environment (no `jsdom`, no
 * `@testing-library/*` -- see `AGENTS.md`'s no-new-dependency constraint and
 * `apps/web`'s own split: pure helpers in Vitest, DOM interaction in
 * Playwright). `@voxelspy/react` cannot add a browser test environment of
 * its own without a new dependency, so what follows renders each component
 * to a static HTML string with React's own `react-dom/server` (available
 * transitively through the `react`/`react-dom` peer/dev dependency, not a
 * new one) and asserts on the emitted markup: correct ARIA roles, live
 * regions, associated labels, and that state is conveyed through visible
 * text rather than colour alone.
 *
 * What this proves: the markup these components emit has the right
 * structure for assistive technology to key off of, for every status this
 * package's own status model can produce.
 *
 * What this does NOT prove: that a screen reader announces it correctly,
 * that keyboard focus behaves as expected, that live-region timing works in
 * a real browser, or anything about interaction. Neither `InspectionFindings`
 * nor `ComparisonFindings` has any interactive element today (both are
 * read-only report views), so there is nothing here to keyboard-test yet;
 * a consumer building interactive controls around these components (e.g. a
 * "run again" button) is responsible for testing that interaction in a real
 * browser, e.g. with Playwright, the same way `apps/web` already does for
 * its own UI.
 */

function idleInspection(): EngineStatus<ReturnType<typeof inspectModel>> {
  return { status: "idle" };
}

describe("InspectionFindings: static markup", () => {
  it("idle renders plain text, no role claims about activity", () => {
    const html = renderToStaticMarkup(
      <InspectionFindings status={idleInspection()} />,
    );
    expect(html).toContain("No inspection has run yet.");
    expect(html).not.toContain("role=");
  });

  it("running announces itself through a role=status live region", () => {
    const html = renderToStaticMarkup(
      <InspectionFindings status={{ status: "running" }} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Inspecting model");
  });

  it("a cancelled run and a genuine failure are both role=alert but distinguishable by text, not colour", () => {
    const cancelledHtml = renderToStaticMarkup(
      <InspectionFindings
        status={{ status: "failed", reason: { kind: "cancelled" } }}
      />,
    );
    const failedHtml = renderToStaticMarkup(
      <InspectionFindings
        status={{
          status: "failed",
          reason: {
            kind: "error",
            error: new Error("resource limit exceeded"),
          },
        }}
      />,
    );
    expect(cancelledHtml).toContain('role="alert"');
    expect(failedHtml).toContain('role="alert"');
    expect(cancelledHtml).toContain("Inspection cancelled");
    expect(failedHtml).toContain("Inspection failed");
    expect(failedHtml).toContain("resource limit exceeded");
    // The two must read differently in plain text, not merely via a CSS class.
    expect(cancelledHtml).not.toEqual(failedHtml);
  });

  it("a closed model states 'Closed' in text, not only via a class name", () => {
    const result = inspectModel(boxModel("closed"));
    const html = renderToStaticMarkup(
      <InspectionFindings status={{ status: "complete", result }} />,
    );
    expect(html).toContain("Closed");
    expect(html).toContain("No topology issues found.");
  });

  it("a not-closed model states 'Not closed' plus its reasons in text", () => {
    const result = inspectModel(boxModel("open", { open: true }));
    const html = renderToStaticMarkup(
      <InspectionFindings status={{ status: "complete", result }} />,
    );
    expect(html).toContain("Not closed");
    expect(html).toContain("boundary-edges");
    expect(html).toContain("boundary-edges"); // topology finding kind, also in text
  });

  it("every heading has a stable id an aria-labelledby section can reference", () => {
    const result = inspectModel(boxModel("closed"));
    const html = renderToStaticMarkup(
      <InspectionFindings
        status={{ status: "complete", result }}
        idPrefix="x"
      />,
    );
    expect(html).toContain('id="x-heading"');
    expect(html).toContain('aria-labelledby="x-heading"');
  });
});

describe("ComparisonFindings: static markup", () => {
  it("running announces itself through a role=status live region", () => {
    const html = renderToStaticMarkup(
      <ComparisonFindings status={{ status: "running" }} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("an approximate complete outcome states 'Approximate' in text, never presented as exact", () => {
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate");
    const result = analyzeModelPair({
      request: analysisRequestFor(baseline, candidate, "surface-distance"),
      baseline,
      candidate,
    });
    const html = renderToStaticMarkup(
      <ComparisonFindings status={{ status: "complete", result }} />,
    );
    expect(html).toContain("Approximate");
    expect(html).not.toContain(">Exact<");
  });

  it("an exact-within-validated-preconditions outcome states 'Exact' in text", () => {
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate", { maximum: [3, 2, 2] });
    const result = analyzeModelPair({
      request: analysisRequestFor(
        baseline,
        candidate,
        "axis-aligned-box-solid",
      ),
      baseline,
      candidate,
    });
    const html = renderToStaticMarkup(
      <ComparisonFindings status={{ status: "complete", result }} />,
    );
    expect(html).toContain("Exact");
  });

  it("an indeterminate outcome renders as role=alert with its code and reasons, never as a pass", () => {
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate");
    const result = analyzeModelPair({
      request: analysisRequestFor(baseline, candidate, "surface-distance", {
        executionBudget: { maxMemoryBytes: 1, maxWorkUnits: 1 },
      }),
      baseline,
      candidate,
    });
    expect(result.outcome.state).toBe("indeterminate");
    const html = renderToStaticMarkup(
      <ComparisonFindings status={{ status: "complete", result }} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Comparison indeterminate");
    expect(html).not.toContain("Comparison findings");
    if (result.outcome.state === "indeterminate") {
      expect(html).toContain(result.outcome.code);
    }
  });
});
