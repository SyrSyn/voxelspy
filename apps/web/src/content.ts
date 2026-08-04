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
          "Use models with known units and coordinate systems. VoxelSpy preserves source meaning instead of silently shifting or resizing either model.",
        ],
      },
      {
        id: "review-import",
        title: "Review the import",
        paragraphs: [
          "Confirm units, coordinate transforms, unsupported content, and approximation warnings before interpreting a difference. Corrections are deliberate inputs and remain visible in the result.",
        ],
      },
      {
        id: "inspect-results",
        title: "Inspect before sharing",
        paragraphs: [
          "Move from the overview to ranked regions and sections. Export is a separate action; selecting local files does not upload them.",
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
          "Reports and sessions have versioned, serializable data boundaries, but portable export is not connected to the browser workflow yet.",
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
