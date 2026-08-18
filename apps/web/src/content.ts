export interface DocPage {
  path: string;
  eyebrow: string;
  title: string;
  description: string;
  sections: { id: string; title: string; paragraphs: string[] }[];
}

export const docs: DocPage[] = [
  {
    path: "/docs/getting-started/",
    eyebrow: "First comparison",
    title: "Getting started",
    description: "Prepare two models for a private, local comparison.",
    sections: [
      {
        id: "choose-files",
        title: "Choose a baseline and candidate",
        paragraphs: [
          "The baseline is the model you trust. The candidate is the revision you want to inspect. Choose both from your device; normal comparison keeps their geometry in your browser.",
          "The import starts with common millimetre and right-handed Z-up settings. If either source uses a different frame, change its Expert settings before comparison; the selected interpretation remains attached to the result.",
        ],
      },
      {
        id: "review-import",
        title: "Review the import",
        paragraphs: [
          "Review the interpreted units, coordinate transforms, unsupported content, and approximation warnings before relying on a difference. Corrections are deliberate inputs and remain visible in the result.",
        ],
      },
      {
        id: "inspect-results",
        title: "Inspect before sharing",
        paragraphs: [
          "Move from the overview to ranked regions and sections. Exporting a report or saving a session are both separate, explicit actions; selecting local files does not upload them.",
        ],
      },
    ],
  },
  {
    path: "/docs/privacy/",
    eyebrow: "Data boundary",
    title: "Privacy by default",
    description:
      "Understand what stays on your device and where explicit sharing begins.",
    sections: [
      {
        id: "local-comparison",
        title: "Normal comparison stays local",
        paragraphs: [
          "Model files and geometry buffers remain inside the browser comparison runtime. Local comparison does not require an account, hosted storage, or a server API.",
        ],
      },
      {
        id: "network-boundary",
        title: "Sharing must be deliberate",
        paragraphs: [
          "Any future action that sends a model or result off-device must identify the destination and require an explicit action. Local file selection is never consent to upload.",
        ],
      },
      {
        id: "portable-artifacts",
        title: "Portable artifacts are explicit",
        paragraphs: [
          "A saved session is a self-contained .voxelspy file: it embeds both original models, the analysis result, and the comparison configuration, so saving or sharing one is itself a model-data transfer, not just a result summary. Saving and reopening a session are both explicit, local actions with no network step.",
          "Exporting a report renders the comparison to one standalone, self-contained .html document (findings, an overview view, and a geometry-summary narrative) and downloads it directly, with no network step. Unlike a saved session, an exported report does not embed either model's raw geometry.",
        ],
      },
    ],
  },
  {
    path: "/docs/geometry/",
    eyebrow: "Correctness boundary",
    title: "Geometry interpretation",
    description: "The invariants that keep comparison results interpretable.",
    sections: [
      {
        id: "preserve-source",
        title: "Preserve source meaning",
        paragraphs: [
          "Importers normalize geometry into typed arrays while preserving declared units, transforms, warnings, provenance, and uncertainty. They do not silently recenter, rescale, align, repair, or reinterpret a model.",
        ],
      },
      {
        id: "method-preconditions",
        title: "Methods have preconditions",
        paragraphs: [
          "Boolean, voxel, and distance methods answer different questions. A result identifies the selected method, validates its preconditions, and reports when an answer is approximate or indeterminate.",
        ],
      },
      {
        id: "sampling-semantics",
        title: "Sampled distance has a spacing bound",
        paragraphs: [
          "Surface comparison measures sampled points on each triangle against the opposite surface. Every reported distance is exact for the points it measured, but a feature smaller than the spacing between samples can fall between them and go unreported.",
          "Each result states the worst-case sample spacing in millimetres next to the tolerance you requested. When the spacing is larger than the tolerance, the result carries an explicit warning that features below that size can be missed. Finding no changed regions therefore means no change was observed at that sampling density, which is not the same as proving two models identical.",
        ],
      },
      {
        id: "evidence",
        title: "Prefer reproducible evidence",
        paragraphs: [
          "Fixtures, deterministic outputs, hostile-input limits, cancellation, and recovery behavior are acceptance evidence. A convincing render cannot substitute for correct data.",
        ],
      },
    ],
  },
  {
    path: "/docs/limits/",
    eyebrow: "Resource boundary",
    title: "Limits and control",
    description:
      "What this release accepts, how much it will spend, and how to stop it.",
    sections: [
      {
        id: "supported-input",
        title: "Supported input",
        paragraphs: [
          "This release imports binary and text STL and a documented OBJ subset of vertices and faces. Each source file is accepted up to 32 MiB and 500,000 triangles. Content outside those subsets, including materials, curves, and free-form surfaces, is refused with a stated reason rather than partially interpreted.",
          "Neither format authoritatively declares units or an up-axis, so import begins with millimetres and right-handed Z-up and exposes other interpretations as expert settings. The interpretation you choose stays attached to the result.",
        ],
      },
      {
        id: "allowance",
        title: "The analysis allowance",
        paragraphs: [
          "Comparison runs inside a memory allowance you control, between 128 and 768 MiB. The starting value is recommended from what your browser reports about the device, and is deliberately conservative when a reading is unavailable. The recommendation is never a cap: the whole range stays available.",
          "The allowance is a fail-closed ceiling on an estimate, not reserved memory. A comparison that would exceed it stops with an explicit resource outcome instead of returning a partial or misleading difference. Raising it lets a capable device attempt more work; it does not make an exhausted browser tab succeed.",
        ],
      },
      {
        id: "stopping-work",
        title: "Stopping and recovering",
        paragraphs: [
          "A running comparison can be cancelled from the interface, and leaving the page stops the work rather than leaving it running. Cancellation returns the page to a ready state without an error.",
          "If the comparison worker fails or stops responding, the interface reports a structured failure and recovers instead of waiting indefinitely. Comparison itself is bounded, deterministic, and repeatable: the same inputs and settings produce the same result.",
        ],
      },
    ],
  },
];

export const routes = [
  "/",
  "/compare/",
  "/docs/",
  ...docs.map((doc) => doc.path),
];

export function searchDocs(query: string) {
  const terms = query
    .trim()
    .toLocaleLowerCase("en-US")
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return [];
  return docs.filter((doc) => {
    const text = [
      doc.title,
      doc.description,
      doc.eyebrow,
      ...doc.sections.flatMap((section) => [
        section.title,
        ...section.paragraphs,
      ]),
    ]
      .join(" ")
      .toLocaleLowerCase("en-US");
    return terms.every((term) => text.includes(term));
  });
}
