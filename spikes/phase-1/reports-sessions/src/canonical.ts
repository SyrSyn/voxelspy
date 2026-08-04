import { createHash } from "node:crypto";

import { parseReport, type Report } from "./schema.js";

const encoder = new TextEncoder();

export interface CanonicalEvidence {
  report: Report;
  models: ReadonlyMap<string, Uint8Array>;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function facet(
  normal: readonly number[],
  vertices: readonly (readonly number[])[],
): string {
  const rows = [
    `  facet normal ${normal.join(" ")}`,
    "    outer loop",
    ...vertices.map((vertex) => `      vertex ${vertex.join(" ")}`),
    "    endloop",
    "  endfacet",
  ];
  return rows.join("\n");
}

function cuboidStl(name: string, x: number, y: number, z: number): Uint8Array {
  type VertexIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  const v = [
    [0, 0, 0],
    [x, 0, 0],
    [x, y, 0],
    [0, y, 0],
    [0, 0, z],
    [x, 0, z],
    [x, y, z],
    [0, y, z],
  ] as const;
  const faces: readonly [
    readonly number[],
    readonly [VertexIndex, VertexIndex, VertexIndex],
    readonly [VertexIndex, VertexIndex, VertexIndex],
  ][] = [
    [
      [0, 0, -1],
      [0, 2, 1],
      [0, 3, 2],
    ],
    [
      [0, 0, 1],
      [4, 5, 6],
      [4, 6, 7],
    ],
    [
      [0, -1, 0],
      [0, 1, 5],
      [0, 5, 4],
    ],
    [
      [1, 0, 0],
      [1, 2, 6],
      [1, 6, 5],
    ],
    [
      [0, 1, 0],
      [2, 3, 7],
      [2, 7, 6],
    ],
    [
      [-1, 0, 0],
      [3, 0, 4],
      [3, 4, 7],
    ],
  ];
  const body = faces.flatMap(([normal, a, b]) => [
    facet(
      normal,
      a.map((index) => v[index]),
    ),
    facet(
      normal,
      b.map((index) => v[index]),
    ),
  ]);
  return encoder.encode(
    `solid ${name}\n${body.join("\n")}\nendsolid ${name}\n`,
  );
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

export function createCanonicalEvidence(): CanonicalEvidence {
  const baseline = cuboidStl("baseline-cuboid", 40, 30, 20);
  const candidate = cuboidStl("candidate-cuboid", 42, 30, 20);
  const models = new Map<string, Uint8Array>([
    ["models/baseline.stl", baseline],
    ["models/candidate.stl", candidate],
  ]);
  const generatedAt = "2025-01-01T00:00:00.000Z";
  const report = parseReport({
    schema: "https://voxelspy.dev/schemas/report/v1",
    schemaVersion: 1,
    id: "report.synthetic-cuboids",
    title: "Synthetic cuboid comparison",
    generatedAt,
    generator: { name: "VoxelSpy", version: "0.0.0-spike" },
    models: [
      {
        id: "model.baseline",
        role: "baseline",
        name: "Baseline cuboid",
        archivePath: "models/baseline.stl",
        mediaType: "model/stl",
        unit: "mm",
        sha256: sha256(baseline),
        transform: identity,
        provenance: {
          kind: "generated",
          generator: "reports-sessions canonical cuboid generator",
          license: "CC0-1.0",
        },
      },
      {
        id: "model.candidate",
        role: "candidate",
        name: "Candidate cuboid",
        archivePath: "models/candidate.stl",
        mediaType: "model/stl",
        unit: "mm",
        sha256: sha256(candidate),
        transform: identity,
        provenance: {
          kind: "generated",
          generator: "reports-sessions canonical cuboid generator",
          license: "CC0-1.0",
        },
      },
    ],
    markups: [
      {
        id: "markup.width-callout",
        type: "callout",
        label: "Width change",
        visible: true,
        createdAt: generatedAt,
        author: "automatic review",
        modelId: "model.candidate",
        anchor: [42, 15, 10],
        text: "Candidate extends 2 mm beyond the baseline on the positive X face.",
      },
      {
        id: "markup.width-distance",
        type: "distance",
        label: "Candidate width",
        visible: true,
        createdAt: generatedAt,
        author: "automatic review",
        modelId: "model.candidate",
        start: [0, 0, 0],
        end: [42, 0, 0],
        value: 42,
        unit: "mm",
      },
    ],
    findings: [
      {
        id: "finding.width-change",
        origin: "automatic",
        detector: {
          id: "dimension-delta",
          version: "1.0.0",
          parameters: { toleranceMm: 0.25 },
        },
        severity: "warning",
        title: "Width exceeds baseline",
        summary: "The candidate width is 42 mm; the baseline width is 40 mm.",
        confidence: 1,
        markupIds: ["markup.width-callout", "markup.width-distance"],
        createdAt: generatedAt,
      },
    ],
    savedViews: [
      {
        id: "view.width-review",
        name: "Width review",
        camera: {
          position: [80, 65, 55],
          target: [20, 15, 10],
          up: [0, 0, 1],
          projection: "perspective",
          fieldOfViewDegrees: 35,
        },
        visibility: { "model.baseline": true, "model.candidate": true },
        selectedFindingIds: ["finding.width-change"],
        selectedMarkupIds: ["markup.width-callout", "markup.width-distance"],
        sectionPlane: null,
      },
    ],
    figures: [
      {
        id: "figure.width-overlay",
        title: "Front-view width overlay",
        width: 640,
        height: 360,
        viewId: "view.width-review",
        primitives: [
          {
            kind: "line",
            from: [80, 280],
            to: [500, 280],
            color: "#1967d2",
            width: 3,
          },
          {
            kind: "line",
            from: [500, 280],
            to: [500, 80],
            color: "#1967d2",
            width: 3,
          },
          {
            kind: "line",
            from: [500, 80],
            to: [80, 80],
            color: "#1967d2",
            width: 3,
          },
          {
            kind: "line",
            from: [80, 80],
            to: [80, 280],
            color: "#1967d2",
            width: 3,
          },
          {
            kind: "line",
            from: [80, 280],
            to: [480, 280],
            color: "#d93025",
            width: 2,
          },
          {
            kind: "line",
            from: [480, 280],
            to: [480, 80],
            color: "#d93025",
            width: 2,
          },
          {
            kind: "line",
            from: [480, 80],
            to: [80, 80],
            color: "#d93025",
            width: 2,
          },
          {
            kind: "label",
            at: [220, 55],
            text: "Candidate 42 mm / baseline 40 mm",
            color: "#202124",
          },
          { kind: "label", at: [505, 175], text: "+2 mm", color: "#202124" },
        ],
      },
    ],
    review: {
      activeViewId: "view.width-review",
      notes:
        "Review state intentionally uses generated geometry and fixed values.",
      status: "draft",
    },
  });
  return { report, models };
}
