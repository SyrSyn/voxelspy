import type { ComparisonSource } from "./worker-client";

type Point3 = readonly [x: number, y: number, z: number];
type Triangle = readonly [Point3, Point3, Point3];

const SAMPLE_FILE_TIMESTAMP = 0;
const BASE_TOP = 4;

export interface BuiltInSamplePair {
  readonly id: "mounting-bracket-reinforcement";
  readonly title: string;
  readonly summary: string;
  readonly change: string;
  readonly baseline: ComparisonSource;
  readonly candidate: ComparisonSource;
}

/**
 * Creates fresh local files for the built-in comparison example.
 *
 * The files use an explicit millimetre, right-handed Z-up source frame so they
 * can be passed directly to runComparison without any additional user input.
 */
export function createBuiltInSamplePair(): BuiltInSamplePair {
  return {
    id: "mounting-bracket-reinforcement",
    title: "Mounting bracket reinforcement",
    summary:
      "Compare two versions of an L-shaped bracket with a bored mounting boss.",
    change:
      "The candidate raises the mounting boss, enlarges one gusset, and adds a mirrored gusset.",
    baseline: createSource(
      "sample-mounting-bracket-baseline.stl",
      createMountingBracket("baseline"),
    ),
    candidate: createSource(
      "sample-mounting-bracket-candidate.stl",
      createMountingBracket("candidate"),
    ),
  };
}

function createSource(
  name: string,
  triangles: readonly Triangle[],
): ComparisonSource {
  return {
    file: new File([createAsciiStl(triangles)], name, {
      type: "model/stl",
      lastModified: SAMPLE_FILE_TIMESTAMP,
    }),
    unit: "millimetre" as const,
    axis: "right-handed-z-up" as const,
  };
}

function createMountingBracket(version: "baseline" | "candidate"): Triangle[] {
  const triangles = [
    ...cuboid([0, 0, 0], [48, 32, BASE_TOP]),
    ...cuboid([0, 28, BASE_TOP], [48, 32, 34]),
    ...annularCylinder(
      [24, 12],
      7,
      3,
      BASE_TOP,
      version === "baseline" ? 12 : 18,
    ),
  ];

  if (version === "baseline") {
    triangles.push(...triangularGusset(7, 12, 19, 18));
  } else {
    triangles.push(
      ...triangularGusset(6, 13, 13, 26),
      ...triangularGusset(35, 42, 13, 26),
    );
  }
  return triangles;
}

function cuboid(min: Point3, max: Point3): Triangle[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const points = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ] as const satisfies readonly Point3[];
  return trianglesFromIndices(points, [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ]);
}

function triangularGusset(
  x0: number,
  x1: number,
  forwardY: number,
  topZ: number,
): Triangle[] {
  const points = [
    [x0, forwardY, BASE_TOP],
    [x0, 28, BASE_TOP],
    [x0, 28, topZ],
    [x1, forwardY, BASE_TOP],
    [x1, 28, BASE_TOP],
    [x1, 28, topZ],
  ] as const satisfies readonly Point3[];
  return trianglesFromIndices(points, [
    [0, 2, 1],
    [3, 4, 5],
    [0, 1, 4],
    [0, 4, 3],
    [1, 2, 5],
    [1, 5, 4],
    [2, 0, 3],
    [2, 3, 5],
  ]);
}

function annularCylinder(
  center: readonly [x: number, y: number],
  outerRadius: number,
  innerRadius: number,
  bottom: number,
  top: number,
  segments = 16,
): Triangle[] {
  const triangles: Triangle[] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const outerBottom = circlePoint(
      center,
      outerRadius,
      index,
      segments,
      bottom,
    );
    const outerBottomNext = circlePoint(
      center,
      outerRadius,
      next,
      segments,
      bottom,
    );
    const outerTop = circlePoint(center, outerRadius, index, segments, top);
    const outerTopNext = circlePoint(center, outerRadius, next, segments, top);
    const innerBottom = circlePoint(
      center,
      innerRadius,
      index,
      segments,
      bottom,
    );
    const innerBottomNext = circlePoint(
      center,
      innerRadius,
      next,
      segments,
      bottom,
    );
    const innerTop = circlePoint(center, innerRadius, index, segments, top);
    const innerTopNext = circlePoint(center, innerRadius, next, segments, top);

    triangles.push(
      [outerBottom, outerBottomNext, outerTopNext],
      [outerBottom, outerTopNext, outerTop],
      [innerBottom, innerTopNext, innerBottomNext],
      [innerBottom, innerTop, innerTopNext],
      [outerTop, outerTopNext, innerTopNext],
      [outerTop, innerTopNext, innerTop],
      [outerBottom, innerBottomNext, outerBottomNext],
      [outerBottom, innerBottom, innerBottomNext],
    );
  }
  return triangles;
}

function circlePoint(
  center: readonly [x: number, y: number],
  radius: number,
  index: number,
  segments: number,
  z: number,
): Point3 {
  const angle = (index * Math.PI * 2) / segments;
  return [
    normalizeNumber(center[0] + radius * Math.cos(angle)),
    normalizeNumber(center[1] + radius * Math.sin(angle)),
    z,
  ];
}

function trianglesFromIndices(
  points: readonly Point3[],
  indices: ReadonlyArray<readonly [number, number, number]>,
): Triangle[] {
  return indices.map(([first, second, third]) => [
    points[first]!,
    points[second]!,
    points[third]!,
  ]);
}

function createAsciiStl(triangles: readonly Triangle[]): string {
  const body = triangles
    .map((triangle) => {
      const normal = triangleNormal(triangle);
      return [
        `  facet normal ${normal.map(formatNumber).join(" ")}`,
        "    outer loop",
        ...triangle.map(
          (point) => `      vertex ${point.map(formatNumber).join(" ")}`,
        ),
        "    endloop",
        "  endfacet",
      ].join("\n");
    })
    .join("\n");
  return `solid sample-mounting-bracket\n${body}\nendsolid sample-mounting-bracket\n`;
}

function triangleNormal([first, second, third]: Triangle): Point3 {
  const a = subtract(second, first);
  const b = subtract(third, first);
  const cross: Point3 = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const length = Math.hypot(...cross);
  return [
    normalizeNumber(cross[0] / length),
    normalizeNumber(cross[1] / length),
    normalizeNumber(cross[2] / length),
  ];
}

function subtract(left: Point3, right: Point3): Point3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function normalizeNumber(value: number): number {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatNumber(value: number): string {
  return normalizeNumber(value).toString();
}
