import { unzipSync } from "fflate";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createCanonicalEvidence } from "../src/canonical.js";
import {
  generateDocx,
  generatePdf,
  renderFigureSvg,
  stableJson,
  validateDocx,
  validatePdf,
} from "../src/export.js";
import { parseReport } from "../src/schema.js";

describe("canonical report exports", () => {
  it("contains bounded markups, an automatic finding, and saved review state", () => {
    const { report, models } = createCanonicalEvidence();
    expect(models.size).toBe(2);
    expect(report.models.map(({ role }) => role)).toEqual([
      "baseline",
      "candidate",
    ]);
    expect(report.markups.map(({ type }) => type)).toEqual([
      "callout",
      "distance",
    ]);
    expect(report.findings[0]?.origin).toBe("automatic");
    expect(report.savedViews[0]?.selectedFindingIds).toEqual([
      "finding.width-change",
    ]);
    expect(report.review.activeViewId).toBe("view.width-review");
  });

  it("generates byte-deterministic PDF, DOCX, SVG, and JSON", () => {
    const { report } = createCanonicalEvidence();
    expect(generatePdf(report)).toEqual(generatePdf(report));
    expect(generateDocx(report)).toEqual(generateDocx(report));
    expect(renderFigureSvg(report.figures[0]!)).toBe(
      renderFigureSvg(report.figures[0]!),
    );
    expect(stableJson(report)).toBe(stableJson(report));
  });

  it("generates a structurally valid PDF", () => {
    const bytes = generatePdf(createCanonicalEvidence().report);
    expect(() => validatePdf(bytes)).not.toThrow();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("Width exceeds baseline");
    expect(text).toContain("Candidate width: 42 mm");
  });

  it("generates editable OOXML text and a related deterministic SVG figure", () => {
    const bytes = generateDocx(createCanonicalEvidence().report);
    expect(() => validateDocx(bytes)).not.toThrow();
    const files = unzipSync(bytes);
    const document = new TextDecoder().decode(files["word/document.xml"]);
    expect(document).toContain("<w:t");
    expect(document).toContain("Width exceeds baseline");
    expect(new TextDecoder().decode(files["word/media/figure.svg"])).toContain(
      "Candidate 42 mm / baseline 40 mm",
    );
  });
});

describe("report schema invariants", () => {
  it("rejects unbounded callouts and inconsistent two-point distances", () => {
    const oversized = structuredClone(createCanonicalEvidence().report);
    const callout = oversized.markups[0]!;
    if (callout.type !== "callout")
      throw new Error("canonical markup order changed");
    callout.text = "x".repeat(401);
    expect(() => parseReport(oversized)).toThrow();

    const inconsistent = structuredClone(createCanonicalEvidence().report);
    const distance = inconsistent.markups[1]!;
    if (distance.type !== "distance")
      throw new Error("canonical markup order changed");
    distance.value = 41;
    expect(() => parseReport(inconsistent)).toThrow(/two endpoints/);
  });

  it("rejects broken references and non-finite geometry values", () => {
    const broken = structuredClone(createCanonicalEvidence().report);
    broken.findings[0]!.markupIds = ["markup.missing"];
    expect(() => parseReport(broken)).toThrow(/Unknown finding markup/);

    const nonFinite = structuredClone(createCanonicalEvidence().report);
    const callout = nonFinite.markups[0]!;
    if (callout.type !== "callout")
      throw new Error("canonical markup order changed");
    callout.anchor[0] = Number.NaN;
    expect(() => parseReport(nonFinite)).toThrow();
  });

  it("checks computed distances across generated finite endpoints", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({
            min: -1_000,
            max: 1_000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          fc.double({
            min: -1_000,
            max: 1_000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          fc.double({
            min: -1_000,
            max: 1_000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
        ),
        fc.tuple(
          fc.double({
            min: -1_000,
            max: 1_000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          fc.double({
            min: -1_000,
            max: 1_000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          fc.double({
            min: -1_000,
            max: 1_000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
        ),
        (start, end) => {
          const candidate = structuredClone(createCanonicalEvidence().report);
          const distance = candidate.markups[1]!;
          if (distance.type !== "distance") return false;
          distance.start = start;
          distance.end = end;
          distance.value = Math.hypot(
            end[0] - start[0],
            end[1] - start[1],
            end[2] - start[2],
          );
          return parseReport(candidate).markups.length === 2;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("escapes bounded generated callout strings in document formats", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 80 })
          .filter((value) => value.trim().length > 0),
        (text) => {
          const candidate = structuredClone(createCanonicalEvidence().report);
          const callout = candidate.markups[0]!;
          if (callout.type !== "callout") return false;
          callout.text = text;
          const parsed = parseReport(candidate);
          validatePdf(generatePdf(parsed));
          validateDocx(generateDocx(parsed));
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
