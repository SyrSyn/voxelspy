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
        id: "evidence",
        title: "Prefer reproducible evidence",
        paragraphs: [
          "Fixtures, deterministic outputs, hostile-input limits, cancellation, and recovery behavior are acceptance evidence. A convincing render cannot substitute for correct data.",
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
