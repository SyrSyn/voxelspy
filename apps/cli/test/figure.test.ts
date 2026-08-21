import { describe, expect, it } from "vitest";
import {
  MAX_DRAWN_REGIONS,
  MAX_DRAWN_TRIANGLES,
  buildComparisonFigureSvg,
  buildFigureUnavailableSvg,
  type FigureInput,
  type FigureRegionInput,
  type TriangleTriple,
} from "../src/figure.js";

function baseInput(overrides: Partial<FigureInput> = {}): FigureInput {
  return {
    headline:
      "Compared `baseline.stl` (baseline) against `candidate.stl` (candidate) with surface-distance 1.0.0.",
    verdict: "policy passed",
    baselineLabel: "baseline.stl",
    candidateLabel: "candidate.stl",
    baselineBoundsMm: { min: [0, 0, 0], max: [10, 10, 10] },
    candidateBoundsMm: { min: [0, 0, 0], max: [10, 10, 12] },
    regions: [],
    totalDetectedRegionCount: 0,
    ...overrides,
  };
}

function triangle(z: number): TriangleTriple {
  return [
    [0, 0, z],
    [1, 0, z],
    [0, 1, z],
  ];
}

function region(
  id: string,
  category: FigureRegionInput["category"],
  options: { readonly triangles?: readonly TriangleTriple[] } = {},
): FigureRegionInput {
  return {
    id,
    category,
    boundsMinMm: [0, 0, 10],
    boundsMaxMm: [1, 1, 12],
    anchorMm: [0.5, 0.5, 11],
    ...(options.triangles === undefined
      ? {}
      : { triangles: options.triangles }),
  };
}

describe("buildComparisonFigureSvg", () => {
  it("produces a valid SVG with a viewBox, title, and desc", () => {
    const svg = buildComparisonFigureSvg(baseInput());
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ [\d.]+" role="img">/u,
    );
    expect(svg).toContain(
      "<title>Compared `baseline.stl` (baseline) against `candidate.stl` (candidate) with surface-distance 1.0.0.</title>",
    );
    expect(svg).toMatch(/<desc>.*Verdict: policy passed.*<\/desc>/u);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("includes three axis-aligned view panels", () => {
    const svg = buildComparisonFigureSvg(baseInput());
    expect(svg).toContain("Top (X-Y)");
    expect(svg).toContain("Front (X-Z)");
    expect(svg).toContain("Side (Y-Z)");
  });

  it("includes a legend with a text label for every category, even when unused", () => {
    const svg = buildComparisonFigureSvg(baseInput());
    expect(svg).toContain(">Legend<");
    expect(svg).toMatch(/Added \(present in candidate only/u);
    expect(svg).toMatch(/Removed \(present in baseline only/u);
    expect(svg).toMatch(/Deviation \(present in both/u);
    expect(svg).toContain("Baseline surface (bounding box only");
    expect(svg).toContain("Candidate surface (bounding box only");
  });

  it("marks each changed-region category by pattern, outline, and marker shape -- not colour alone", () => {
    const svg = buildComparisonFigureSvg(
      baseInput({
        regions: [
          region("region.a", "added", { triangles: [triangle(10)] }),
          region("region.b", "removed", { triangles: [triangle(10)] }),
          region("region.c", "deviation", { triangles: [triangle(10)] }),
        ],
        totalDetectedRegionCount: 3,
      }),
    );

    expect(svg).toContain('data-region-category="added"');
    expect(svg).toContain('data-region-category="removed"');
    expect(svg).toContain('data-region-category="deviation"');

    // Distinct fill patterns.
    expect(svg).toContain('fill="url(#hatch-added)"');
    expect(svg).toContain('fill="url(#hatch-removed)"');
    expect(svg).toContain('fill="url(#hatch-deviation)"');

    // Distinct stroke-dasharray outlines per category.
    expect(svg).toContain('stroke-dasharray="0"');
    expect(svg).toContain('stroke-dasharray="6,3"');
    expect(svg).toContain('stroke-dasharray="1,3"');

    // Distinct marker shapes per category.
    expect(svg).toContain('data-marker-shape="circle"');
    expect(svg).toContain('data-marker-shape="square"');
    expect(svg).toContain('data-marker-shape="triangle"');
  });

  it("draws a bounds-only rectangle, not triangle geometry, for a region with no resolved triangles", () => {
    const svg = buildComparisonFigureSvg(
      baseInput({
        regions: [region("region.a", "removed")],
        totalDetectedRegionCount: 1,
      }),
    );
    expect(svg).toContain('data-region-shape="bounds-only"');
    expect(svg).not.toContain('data-region-shape="triangle"');
    expect(svg).toMatch(
      /1 shown region\(s\) had no resolved triangle geometry/u,
    );
  });

  it("states plainly when no changed regions were detected", () => {
    const svg = buildComparisonFigureSvg(
      baseInput({ regions: [], totalDetectedRegionCount: 0 }),
    );
    expect(svg).toContain("No changed regions were detected within tolerance.");
  });

  it("states the region count and any truncation caused by the figure's own region cap", () => {
    const manyRegions = Array.from(
      { length: MAX_DRAWN_REGIONS + 5 },
      (_unused, index) =>
        region(`region.${String(index)}`, "added", {
          triangles: [triangle(10)],
        }),
    );
    const svg = buildComparisonFigureSvg(
      baseInput({
        regions: manyRegions,
        totalDetectedRegionCount: manyRegions.length,
      }),
    );
    expect(svg).toContain(
      `Showing ${String(MAX_DRAWN_REGIONS)} of ${String(manyRegions.length)} detected changed region(s).`,
    );
    expect(svg).toMatch(
      /5 additional region\(s\) available to this figure were not drawn/u,
    );
  });

  it("states upstream truncation when totalDetectedRegionCount exceeds the regions actually made available", () => {
    const svg = buildComparisonFigureSvg(
      baseInput({
        regions: [region("region.a", "added", { triangles: [triangle(10)] })],
        totalDetectedRegionCount: 40,
      }),
    );
    expect(svg).toMatch(
      /39 further detected region\(s\) were not even made available to this figure/u,
    );
  });

  it("states the omitted triangle count when a region's geometry exceeds the drawing bound", () => {
    const manyTriangles = Array.from({ length: MAX_DRAWN_TRIANGLES + 7 }, () =>
      triangle(10),
    );
    const svg = buildComparisonFigureSvg(
      baseInput({
        regions: [
          region("region.a", "deviation", { triangles: manyTriangles }),
        ],
        totalDetectedRegionCount: 1,
      }),
    );
    expect(svg).toMatch(/7 triangle\(s\) among shown regions were omitted/u);
  });

  it("never overclaims: always states this is a projection of sampled geometry, not an exact rendering", () => {
    const svg = buildComparisonFigureSvg(baseInput());
    expect(svg).toMatch(
      /projection of tessellated, sampled comparison geometry/u,
    );
    expect(svg).toMatch(
      /not (a )?(rendered proof of exact shape|an exact rendering)/u,
    );
  });

  it("escapes headline/label text embedded in title, desc, and legend", () => {
    const svg = buildComparisonFigureSvg(
      baseInput({
        headline: 'Compared <baseline & "tricky".stl>',
        baselineLabel: '<baseline & "tricky".stl>',
      }),
    );
    expect(svg).not.toContain("<baseline &");
    expect(svg).toContain("&lt;baseline &amp; &quot;tricky&quot;.stl&gt;");
  });

  it("is byte-identical across repeated calls with identical input", () => {
    const input = baseInput({
      regions: [
        region("region.a", "added", {
          triangles: [triangle(10), triangle(10.5)],
        }),
        region("region.b", "removed"),
      ],
      totalDetectedRegionCount: 2,
    });
    const first = buildComparisonFigureSvg(input);
    const second = buildComparisonFigureSvg(input);
    expect(first).toBe(second);
  });

  it("rounds coordinates to a fixed two-decimal format", () => {
    const svg = buildComparisonFigureSvg(
      baseInput({
        baselineBoundsMm: { min: [0, 0, 0], max: [10.123456789, 10, 10] },
        candidateBoundsMm: { min: [0, 0, 0], max: [10.123456789, 10, 10] },
      }),
    );
    // Every projected coordinate/size attribute (produced by formatCoordinate)
    // should have exactly two decimal digits -- unlike fixed style constants
    // (e.g. stroke-width="1.5"), which this module never rounds because they
    // never come from the projection arithmetic.
    const numbers = [
      ...svg.matchAll(/(?<=[\s<])(?:x|y|width|height|cx|cy)="(-?\d+\.\d+)"/gu),
    ].map((match) => match[1]!);
    expect(numbers.length).toBeGreaterThan(0);
    for (const value of numbers) {
      expect(value).toMatch(/^-?\d+\.\d{2}$/u);
    }
  });
});

describe("buildFigureUnavailableSvg", () => {
  it("is a valid, accessible SVG stating the failure reason without affecting anything else", () => {
    const svg = buildFigureUnavailableSvg({
      headline: "Compared a vs b.",
      reason: "budget exceeded",
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<title>Comparison figure unavailable</title>");
    expect(svg).toContain("Reason: budget exceeded");
    expect(svg).toMatch(
      /does not affect the comparison&apos;s own result or exit code/u,
    );
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});
