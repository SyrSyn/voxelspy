import { writeFileSync } from "node:fs";

/**
 * Deterministic SVG "comparison figure" for `compare --figure <path>`: a
 * text-only, dependency-free rendering that gives a reviewer reading a PR
 * comment a sense of WHERE a model changed, without a browser or a GPU.
 *
 * ## Viewpoint choice: three fixed axis-aligned orthographic views
 *
 * The figure draws three panels -- top (X-Y), front (X-Z), and side (Y-Z) --
 * the standard engineering multiview convention, instead of a single
 * isometric view. Two reasons: (1) an axis-aligned orthographic projection
 * of a point is just dropping one coordinate -- no rotation matrix, no
 * trigonometry, nothing to get subtly wrong or need a unit test to pin down
 * -- so the renderer's geometry math is close to trivial to verify by
 * reading it; (2) a single isometric angle can hide a changed region behind
 * the silhouette it draws, where three axis-aligned views together cannot
 * both hide the same region (a region invisible face-on in one view is
 * edge-on, not hidden, in one of the other two).
 *
 * ## Non-colour encoding (hard project rule: never colour alone)
 *
 * Every changed-region category (`added` | `removed` | `deviation`) is
 * encoded on at least three independent non-colour channels, so the figure
 * remains legible in grayscale or to a colour-blind reader:
 * - a distinct fill hatch pattern (`hatch-added` / `hatch-removed` /
 *   `hatch-deviation`, defined once in `<defs>`),
 * - a distinct stroke `stroke-dasharray` (solid "0" / dashed "6,3" / dotted
 *   "1,3"),
 * - a distinct anchor-marker shape (circle / square / triangle), each also
 *   carrying its category letter as a text label.
 * The legend spells out colour, pattern, dash, shape, and a full-word label
 * for all three categories, plus the baseline/candidate silhouette styling,
 * every time -- never only some categories the current comparison happens
 * to use.
 *
 * ## Determinism
 *
 * No timestamp, random id, or platform-dependent formatting is ever
 * emitted. Every coordinate written into an SVG attribute is rounded to two
 * decimal places by `formatCoordinate` before being converted to a string
 * (`toFixed(2)`, with `-0` normalized to `0`) -- SVG does not need Float64
 * precision, and fixing the rounding rule keeps output both small and
 * byte-identical across runs of the same input, independent of whatever
 * long, run-to-run-irrelevant tail of digits the projection arithmetic
 * happens to produce.
 *
 * ## Bounded output (never a gigabyte of SVG for a million-triangle model)
 *
 * This module never draws unchanged surface geometry -- only its bounding
 * box (an O(1) rectangle per view, regardless of triangle count) is ever
 * drawn for the baseline and candidate as a whole. Changed-region geometry
 * is drawn from the actual reported triangles, but bounded twice over:
 * - at most `MAX_DRAWN_REGIONS` regions (by caller-supplied rank order,
 *   i.e. `orderedRegionIds` order) get any drawing at all; the rest are
 *   counted and stated, never silently dropped;
 * - across those regions, at most `MAX_DRAWN_TRIANGLES` triangles total are
 *   drawn; a region beyond that per-region/global budget still gets its
 *   anchor marker, label, and bounds rectangle (from `boundsMinMm`/
 *   `boundsMaxMm`, always supplied), just not its full triangle silhouette.
 * Every omission this module makes -- truncated regions, truncated
 * triangles, or a region reported with no resolved geometry at all -- is
 * stated in the figure's own caption text, not only in this file's
 * comments: a reviewer looking at the image, not the source, still learns
 * what was left out.
 *
 * ## Accessibility
 *
 * Every figure carries a `<title>` (short) and `<desc>` (the verdict plus a
 * summary of what the three views show and omit), so a screen reader gets
 * the substance of the comparison, not silence.
 *
 * ## Honesty
 *
 * The `<desc>` and the on-figure caption both state plainly that this is a
 * projection of tessellated, sampled comparison geometry, not a rendered
 * proof of exact shape -- matching this CLI's package-wide "never overclaim"
 * principle (see `README.md`).
 */

export type FigureRegionCategory = "added" | "removed" | "deviation";

export type Vec3Triple = readonly [number, number, number];
export type TriangleTriple = readonly [Vec3Triple, Vec3Triple, Vec3Triple];

export interface FigureRegionInput {
  readonly id: string;
  readonly category: FigureRegionCategory;
  readonly boundsMinMm: Vec3Triple;
  readonly boundsMaxMm: Vec3Triple;
  readonly anchorMm: Vec3Triple;
  /**
   * Resolved triangle geometry for (a bounded prefix of) this region,
   * already looked up by the caller via `@voxelspy/analysis`'s
   * `flattenedTriangleLocator` -- this module never resolves a
   * `triangleIndex` itself. `undefined` when the caller had no resolved
   * geometry for this region (an omitted `ChangeRegion.geometry`, or a
   * region beyond the caller's own triangle budget); such a region is
   * drawn from `boundsMinMm`/`boundsMaxMm` only.
   */
  readonly triangles?: readonly TriangleTriple[];
}

export interface FigureBoundsMm {
  readonly min: Vec3Triple;
  readonly max: Vec3Triple;
}

export interface FigureInput {
  /** One-line description of what was compared, e.g. the same headline text the Markdown summary uses. */
  readonly headline: string;
  /** e.g. "policy passed", "policy failed", "indeterminate", "informational (no policy configured)". Printed verbatim, matching `markdown-report.ts`'s convention of never simplifying a verdict to a bare glyph. */
  readonly verdict: string;
  readonly baselineLabel: string;
  readonly candidateLabel: string;
  readonly baselineBoundsMm: FigureBoundsMm;
  readonly candidateBoundsMm: FigureBoundsMm;
  /**
   * The regions to attempt to draw, in rank order (best-evidence-first --
   * the same order `orderedRegionIds` gives). This module applies its own
   * `MAX_DRAWN_REGIONS`/`MAX_DRAWN_TRIANGLES` bounds on top of whatever the
   * caller already passed, and states whatever it omits.
   */
  readonly regions: readonly FigureRegionInput[];
  /**
   * The true total detected region count, independent of `regions.length`
   * (which may already be smaller, e.g. because the caller applied
   * `--max-regions` upstream). Used only to state an honest "showing N of
   * the true M" count; never itself bounds what this module draws.
   */
  readonly totalDetectedRegionCount: number;
}

/** At most this many regions (by rank order) ever receive any drawing. */
export const MAX_DRAWN_REGIONS = 50;
/** At most this many triangles, summed across all drawn regions, are ever drawn as full geometry. */
export const MAX_DRAWN_TRIANGLES = 400;

const PANEL_SIZE = 240;
const PANEL_PADDING = 16;
const PANEL_GAP = 24;
const PANEL_TITLE_HEIGHT = 20;
const MARGIN = 20;
const HEADER_HEIGHT = 60;
const LEGEND_LINE_HEIGHT = 18;
const LEGEND_TITLE_HEIGHT = 24;
const LEGEND_TOP_GAP = 20;
const LEGEND_SWATCH_WIDTH = 34;

interface ViewDefinition {
  readonly title: string;
  readonly axisA: 0 | 1 | 2;
  readonly axisB: 0 | 1 | 2;
}

const VIEWS: readonly ViewDefinition[] = [
  { title: "Top (X-Y)", axisA: 0, axisB: 1 },
  { title: "Front (X-Z)", axisA: 0, axisB: 2 },
  { title: "Side (Y-Z)", axisA: 1, axisB: 2 },
];

interface CategoryStyle {
  readonly label: string;
  readonly description: string;
  readonly color: string;
  readonly patternId: string;
  /** SVG `stroke-dasharray` value. `"0"` renders as a solid line (SVG treats an all-zero dasharray as solid) -- an explicit value is always present so every category, including the solid one, carries the same attribute for a consumer to inspect. */
  readonly dashArray: string;
  readonly markerShape: "circle" | "square" | "triangle";
  readonly letter: string;
}

const CATEGORY_STYLES: Readonly<Record<FigureRegionCategory, CategoryStyle>> = {
  added: {
    label: "Added",
    description: "present in candidate only (not in baseline)",
    color: "#1d6f42",
    patternId: "hatch-added",
    dashArray: "0",
    markerShape: "circle",
    letter: "A",
  },
  removed: {
    label: "Removed",
    description: "present in baseline only (not in candidate)",
    color: "#8a1620",
    patternId: "hatch-removed",
    dashArray: "6,3",
    markerShape: "square",
    letter: "R",
  },
  deviation: {
    label: "Deviation",
    description: "present in both; surface moved beyond tolerance",
    color: "#6a3ea1",
    patternId: "hatch-deviation",
    dashArray: "1,3",
    markerShape: "triangle",
    letter: "D",
  },
};

const CATEGORY_ORDER: readonly FigureRegionCategory[] = [
  "added",
  "removed",
  "deviation",
];

interface ViewFrame {
  readonly view: ViewDefinition;
  readonly originX: number;
  readonly originY: number;
  readonly centerA: number;
  readonly centerB: number;
  readonly scale: number;
}

/** Rounds to two decimal places and formats with a fixed two-decimal-digit rule -- see this module's doc comment ("Determinism"). */
function formatCoordinate(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return normalized.toFixed(2);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function componentwiseMin(a: Vec3Triple, b: Vec3Triple): Vec3Triple {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

function componentwiseMax(a: Vec3Triple, b: Vec3Triple): Vec3Triple {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

function buildViewFrames(
  combinedMin: Vec3Triple,
  combinedMax: Vec3Triple,
): readonly ViewFrame[] {
  const drawable = PANEL_SIZE - 2 * PANEL_PADDING;
  return VIEWS.map((view, index) => {
    const minA = combinedMin[view.axisA];
    const maxA = combinedMax[view.axisA];
    const minB = combinedMin[view.axisB];
    const maxB = combinedMax[view.axisB];
    const extentA = Math.max(maxA - minA, 1e-6);
    const extentB = Math.max(maxB - minB, 1e-6);
    const scale = drawable / Math.max(extentA, extentB);
    return {
      view,
      originX: MARGIN + index * (PANEL_SIZE + PANEL_GAP),
      originY: HEADER_HEIGHT,
      centerA: (minA + maxA) / 2,
      centerB: (minB + maxB) / 2,
      scale,
    };
  });
}

function projectAB(
  frame: ViewFrame,
  a: number,
  b: number,
): readonly [number, number] {
  const sx = frame.originX + PANEL_SIZE / 2 + (a - frame.centerA) * frame.scale;
  const sy =
    frame.originY +
    PANEL_TITLE_HEIGHT +
    PANEL_SIZE / 2 -
    (b - frame.centerB) * frame.scale;
  return [sx, sy];
}

function projectPoint(
  frame: ViewFrame,
  point: Vec3Triple,
): readonly [number, number] {
  return projectAB(frame, point[frame.view.axisA], point[frame.view.axisB]);
}

interface RectPixels {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function projectBoundsRect(
  frame: ViewFrame,
  min: Vec3Triple,
  max: Vec3Triple,
): RectPixels {
  const [x0, y0] = projectAB(
    frame,
    min[frame.view.axisA],
    min[frame.view.axisB],
  );
  const [x1, y1] = projectAB(
    frame,
    max[frame.view.axisA],
    max[frame.view.axisB],
  );
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function rectMarkup(rect: RectPixels, attributes: string): string {
  return `<rect x="${formatCoordinate(rect.x)}" y="${formatCoordinate(rect.y)}" width="${formatCoordinate(rect.width)}" height="${formatCoordinate(rect.height)}" ${attributes}/>`;
}

function markerMarkup(
  shape: CategoryStyle["markerShape"],
  x: number,
  y: number,
  color: string,
): string {
  if (shape === "circle") {
    return `<circle cx="${formatCoordinate(x)}" cy="${formatCoordinate(y)}" r="5" fill="${color}" stroke="#111111" stroke-width="0.75" data-marker-shape="circle"/>`;
  }
  if (shape === "square") {
    const half = 5;
    return rectMarkup(
      { x: x - half, y: y - half, width: half * 2, height: half * 2 },
      `fill="${color}" stroke="#111111" stroke-width="0.75" data-marker-shape="square"`,
    );
  }
  const h = 6;
  const points = [
    `${formatCoordinate(x)},${formatCoordinate(y - h)}`,
    `${formatCoordinate(x - h)},${formatCoordinate(y + h)}`,
    `${formatCoordinate(x + h)},${formatCoordinate(y + h)}`,
  ].join(" ");
  return `<polygon points="${points}" fill="${color}" stroke="#111111" stroke-width="0.75" data-marker-shape="triangle"/>`;
}

function trianglePolygonMarkup(
  frame: ViewFrame,
  triangle: TriangleTriple,
  style: CategoryStyle,
): string {
  const points = triangle
    .map((vertex) => {
      const [x, y] = projectPoint(frame, vertex);
      return `${formatCoordinate(x)},${formatCoordinate(y)}`;
    })
    .join(" ");
  return `<polygon points="${points}" fill="url(#${style.patternId})" stroke="${style.color}" stroke-width="1" stroke-dasharray="${style.dashArray}" data-region-category="${style.label.toLowerCase()}" data-region-shape="triangle"/>`;
}

function boundsOnlyRectMarkup(
  frame: ViewFrame,
  min: Vec3Triple,
  max: Vec3Triple,
  style: CategoryStyle,
): string {
  const rect = projectBoundsRect(frame, min, max);
  return rectMarkup(
    rect,
    `fill="url(#${style.patternId})" fill-opacity="0.55" stroke="${style.color}" stroke-width="1.5" stroke-dasharray="${style.dashArray}" data-region-category="${style.label.toLowerCase()}" data-region-shape="bounds-only"`,
  );
}

function patternDefsMarkup(): string {
  const added = CATEGORY_STYLES.added;
  const removed = CATEGORY_STYLES.removed;
  const deviation = CATEGORY_STYLES.deviation;
  return [
    `<pattern id="${added.patternId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`,
    `<rect width="6" height="6" fill="none"/>`,
    `<line x1="0" y1="0" x2="0" y2="6" stroke="${added.color}" stroke-width="2"/>`,
    `</pattern>`,
    `<pattern id="${removed.patternId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">`,
    `<rect width="6" height="6" fill="none"/>`,
    `<line x1="0" y1="0" x2="0" y2="6" stroke="${removed.color}" stroke-width="2"/>`,
    `</pattern>`,
    `<pattern id="${deviation.patternId}" width="6" height="6" patternUnits="userSpaceOnUse">`,
    `<rect width="6" height="6" fill="none"/>`,
    `<line x1="0" y1="0" x2="0" y2="6" stroke="${deviation.color}" stroke-width="1.5"/>`,
    `<line x1="0" y1="6" x2="6" y2="0" stroke="${deviation.color}" stroke-width="1.5"/>`,
    `</pattern>`,
  ].join("");
}

function legendSwatchMarkup(
  x: number,
  y: number,
  style: CategoryStyle,
): string {
  const rect = rectMarkup(
    { x, y: y - 11, width: LEGEND_SWATCH_WIDTH, height: 14 },
    `fill="url(#${style.patternId})" stroke="${style.color}" stroke-width="1.5" stroke-dasharray="${style.dashArray}"`,
  );
  const marker = markerMarkup(
    style.markerShape,
    x + LEGEND_SWATCH_WIDTH + 12,
    y - 4,
    style.color,
  );
  return `${rect}${marker}`;
}

function textMarkup(
  x: number,
  y: number,
  text: string,
  attributes = "",
): string {
  return `<text x="${formatCoordinate(x)}" y="${formatCoordinate(y)}" ${attributes}>${escapeXml(text)}</text>`;
}

export function buildComparisonFigureSvg(input: FigureInput): string {
  let combinedMin = componentwiseMin(
    input.baselineBoundsMm.min,
    input.candidateBoundsMm.min,
  );
  let combinedMax = componentwiseMax(
    input.baselineBoundsMm.max,
    input.candidateBoundsMm.max,
  );
  for (const region of input.regions) {
    combinedMin = componentwiseMin(combinedMin, region.boundsMinMm);
    combinedMax = componentwiseMax(combinedMax, region.boundsMaxMm);
  }

  const frames = buildViewFrames(combinedMin, combinedMax);

  const drawnRegions = input.regions.slice(0, MAX_DRAWN_REGIONS);
  const hiddenByFigureCap = Math.max(
    0,
    input.regions.length - drawnRegions.length,
  );

  let trianglesRemaining = MAX_DRAWN_TRIANGLES;
  let omittedTriangleCount = 0;
  const preparedRegions = drawnRegions.map((region, index) => {
    let drawnTriangles: readonly TriangleTriple[] | undefined;
    if (region.triangles !== undefined) {
      const take = Math.min(trianglesRemaining, region.triangles.length);
      drawnTriangles = region.triangles.slice(0, take);
      trianglesRemaining -= take;
      omittedTriangleCount += region.triangles.length - take;
    }
    return { region, drawnTriangles, rank: index + 1 };
  });

  const bodyParts: string[] = [];
  for (const frame of frames) {
    bodyParts.push(
      rectMarkup(
        {
          x: frame.originX,
          y: frame.originY + PANEL_TITLE_HEIGHT,
          width: PANEL_SIZE,
          height: PANEL_SIZE,
        },
        `fill="none" stroke="#999999" stroke-width="1"`,
      ),
    );
    bodyParts.push(
      textMarkup(
        frame.originX,
        frame.originY + PANEL_TITLE_HEIGHT - 6,
        frame.view.title,
        `font-size="13" font-family="sans-serif"`,
      ),
    );
    bodyParts.push(
      rectMarkup(
        projectBoundsRect(
          frame,
          input.baselineBoundsMm.min,
          input.baselineBoundsMm.max,
        ),
        `fill="none" stroke="#666666" stroke-width="1.5" stroke-dasharray="0" data-model="baseline"`,
      ),
    );
    bodyParts.push(
      rectMarkup(
        projectBoundsRect(
          frame,
          input.candidateBoundsMm.min,
          input.candidateBoundsMm.max,
        ),
        `fill="none" stroke="#2b6cb0" stroke-width="1.5" stroke-dasharray="4,2" data-model="candidate"`,
      ),
    );

    for (const { region, drawnTriangles, rank } of preparedRegions) {
      const style = CATEGORY_STYLES[region.category];
      if (drawnTriangles !== undefined && drawnTriangles.length > 0) {
        for (const triangle of drawnTriangles) {
          bodyParts.push(trianglePolygonMarkup(frame, triangle, style));
        }
      } else {
        bodyParts.push(
          boundsOnlyRectMarkup(
            frame,
            region.boundsMinMm,
            region.boundsMaxMm,
            style,
          ),
        );
      }
      const [ax, ay] = projectPoint(frame, region.anchorMm);
      bodyParts.push(markerMarkup(style.markerShape, ax, ay, style.color));
      bodyParts.push(
        textMarkup(
          ax + 7,
          ay - 6,
          `${style.letter}${String(rank)}`,
          `font-size="9" font-family="sans-serif" fill="#111111"`,
        ),
      );
    }
  }

  const panelsBottom = HEADER_HEIGHT + PANEL_TITLE_HEIGHT + PANEL_SIZE;
  const legendTop = panelsBottom + LEGEND_TOP_GAP;

  const captionLines: string[] = [];
  captionLines.push(
    "Unchanged surface is shown only as a bounding-box silhouette per model (solid = baseline, dashed blue = candidate); individual unchanged triangles are never drawn, regardless of model size.",
  );
  if (input.regions.length === 0) {
    captionLines.push("No changed regions were detected within tolerance.");
  } else {
    captionLines.push(
      `Showing ${String(drawnRegions.length)} of ${String(input.totalDetectedRegionCount)} detected changed region(s).`,
    );
    if (hiddenByFigureCap > 0) {
      captionLines.push(
        `${String(hiddenByFigureCap)} additional region(s) available to this figure were not drawn (figure limit: ${String(MAX_DRAWN_REGIONS)} regions); see --json/--sarif for the full list.`,
      );
    }
    if (input.regions.length < input.totalDetectedRegionCount) {
      captionLines.push(
        `${String(input.totalDetectedRegionCount - input.regions.length)} further detected region(s) were not even made available to this figure (upstream truncation, e.g. --max-regions).`,
      );
    }
  }
  if (omittedTriangleCount > 0) {
    captionLines.push(
      `${String(omittedTriangleCount)} triangle(s) among shown regions were omitted from this figure's drawn geometry (figure limit: ${String(MAX_DRAWN_TRIANGLES)} triangles total); their marker and bounding box are still shown.`,
    );
  }
  const boundsOnlyCount = preparedRegions.filter(
    (entry) => entry.region.triangles === undefined,
  ).length;
  if (boundsOnlyCount > 0) {
    captionLines.push(
      `${String(boundsOnlyCount)} shown region(s) had no resolved triangle geometry available and are drawn as a bounding box only.`,
    );
  }
  captionLines.push(
    "This figure is a projection of tessellated, sampled comparison geometry -- it shows where the analysis reported a difference, not a rendered proof of exact shape.",
  );

  const legendParts: string[] = [];
  legendParts.push(
    textMarkup(
      MARGIN,
      legendTop,
      "Legend",
      `font-size="14" font-family="sans-serif" font-weight="bold"`,
    ),
  );
  let legendY = legendTop + LEGEND_TITLE_HEIGHT;
  for (const category of CATEGORY_ORDER) {
    const style = CATEGORY_STYLES[category];
    legendParts.push(legendSwatchMarkup(MARGIN, legendY, style));
    legendParts.push(
      textMarkup(
        MARGIN + LEGEND_SWATCH_WIDTH + 30,
        legendY,
        `${style.label} (${style.description}) -- hatch + ${style.dashArray === "0" ? "solid" : "dashed"} outline + ${style.markerShape} marker "${style.letter}n"`,
        `font-size="12" font-family="sans-serif"`,
      ),
    );
    legendY += LEGEND_LINE_HEIGHT;
  }
  legendParts.push(
    rectMarkup(
      { x: MARGIN, y: legendY - 11, width: LEGEND_SWATCH_WIDTH, height: 14 },
      `fill="none" stroke="#666666" stroke-width="1.5" stroke-dasharray="0"`,
    ),
  );
  legendParts.push(
    textMarkup(
      MARGIN + LEGEND_SWATCH_WIDTH + 30,
      legendY,
      `Baseline surface (bounding box only; geometry not drawn) -- ${escapeXmlSafeLabel(input.baselineLabel)}`,
      `font-size="12" font-family="sans-serif"`,
    ),
  );
  legendY += LEGEND_LINE_HEIGHT;
  legendParts.push(
    rectMarkup(
      { x: MARGIN, y: legendY - 11, width: LEGEND_SWATCH_WIDTH, height: 14 },
      `fill="none" stroke="#2b6cb0" stroke-width="1.5" stroke-dasharray="4,2"`,
    ),
  );
  legendParts.push(
    textMarkup(
      MARGIN + LEGEND_SWATCH_WIDTH + 30,
      legendY,
      `Candidate surface (bounding box only; geometry not drawn) -- ${escapeXmlSafeLabel(input.candidateLabel)}`,
      `font-size="12" font-family="sans-serif"`,
    ),
  );
  legendY += LEGEND_LINE_HEIGHT + 4;
  for (const line of captionLines) {
    legendParts.push(
      textMarkup(
        MARGIN,
        legendY,
        line,
        `font-size="11" font-family="sans-serif" fill="#333333"`,
      ),
    );
    legendY += LEGEND_LINE_HEIGHT;
  }

  const width =
    MARGIN * 2 + VIEWS.length * PANEL_SIZE + (VIEWS.length - 1) * PANEL_GAP;
  const height = legendY + MARGIN;

  const descriptionText =
    `Comparison figure: ${input.headline} Verdict: ${input.verdict}. ` +
    "Three fixed axis-aligned orthographic views (top X-Y, front X-Z, side Y-Z) show each model's bounding box " +
    "(never its full geometry) and up to " +
    `${String(MAX_DRAWN_REGIONS)} of the detected changed regions (categories: added, removed, deviation), each drawn from its ` +
    "reported triangle geometry where available and marked by fill pattern, outline style, and marker shape, not colour alone. " +
    "This is a projection of tessellated, sampled comparison geometry, not an exact rendering.";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${formatCoordinate(width)} ${formatCoordinate(height)}" role="img">`,
    `<title>${escapeXml(input.headline)}</title>`,
    `<desc>${escapeXml(descriptionText)}</desc>`,
    `<defs>${patternDefsMarkup()}</defs>`,
    `<rect x="0" y="0" width="${formatCoordinate(width)}" height="${formatCoordinate(height)}" fill="#ffffff"/>`,
    textMarkup(
      MARGIN,
      22,
      input.headline,
      `font-size="13" font-family="sans-serif"`,
    ),
    textMarkup(
      MARGIN,
      42,
      `Verdict: ${input.verdict.toUpperCase()}`,
      `font-size="13" font-family="sans-serif" font-weight="bold"`,
    ),
    ...bodyParts,
    ...legendParts,
    `</svg>`,
  ].join("");
}

/** `escapeXml`, given a distinct name at this call site so a reader scanning the legend-building code sees explicitly that a caller-supplied label (a source file name) is being escaped, same as every other text node. */
function escapeXmlSafeLabel(value: string): string {
  return escapeXml(value);
}

export function writeFigureFile(path: string, svg: string): void {
  writeFileSync(path, svg, "utf8");
}

/**
 * A minimal, still-valid, still-accessible SVG for the case where figure
 * generation itself failed (e.g. `flattenedTriangleLocator` hit its own
 * resource-limit ceiling on a model an already-completed comparison could
 * still describe in text). Never thrown from `buildComparisonFigureSvg`
 * itself -- callers that catch such an error write this instead, so
 * `--figure` never turns a successful `compare` run into a crash.
 */
export function buildFigureUnavailableSvg(details: {
  readonly headline: string;
  readonly reason: string;
}): string {
  const width = 640;
  const height = 140;
  const descriptionText = `Comparison figure unavailable for: ${details.headline} Reason: ${details.reason}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${formatCoordinate(width)} ${formatCoordinate(height)}" role="img">`,
    `<title>Comparison figure unavailable</title>`,
    `<desc>${escapeXml(descriptionText)}</desc>`,
    `<rect x="0" y="0" width="${formatCoordinate(width)}" height="${formatCoordinate(height)}" fill="#ffffff" stroke="#999999"/>`,
    textMarkup(
      20,
      30,
      details.headline,
      `font-size="13" font-family="sans-serif"`,
    ),
    textMarkup(
      20,
      55,
      "Comparison figure unavailable.",
      `font-size="13" font-family="sans-serif" font-weight="bold"`,
    ),
    textMarkup(
      20,
      78,
      `Reason: ${details.reason}`,
      `font-size="12" font-family="sans-serif"`,
    ),
    textMarkup(
      20,
      101,
      "This does not affect the comparison's own result or exit code -- see the text/--json/--sarif output for the full, unaffected result.",
      `font-size="11" font-family="sans-serif" fill="#333333"`,
    ),
    `</svg>`,
  ].join("");
}
