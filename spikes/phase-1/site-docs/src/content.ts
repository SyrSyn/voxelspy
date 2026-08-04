export interface DocSection {
  id: string;
  title: string;
  body: string[];
}

export interface DocPage {
  path: string;
  title: string;
  description: string;
  eyebrow: string;
  sections: DocSection[];
}

export const docs: DocPage[] = [
  {
    path: "/docs/getting-started/",
    title: "Getting started",
    description: "Prepare two models for a private, local comparison.",
    eyebrow: "First comparison",
    sections: [
      {
        id: "choose-files",
        title: "Choose a baseline and candidate",
        body: [
          "The baseline is the model you trust. The candidate is the revision you want to inspect. Choose both from your device; normal comparison is designed to keep their geometry in the browser.",
          "Use models with known units and coordinate systems. VoxelSpy should preserve source units and transforms rather than silently shifting or resizing either model.",
        ],
      },
      {
        id: "review-warnings",
        title: "Review import warnings",
        body: [
          "Warnings are part of the result, not incidental console output. Check declared units, transforms, missing metadata, unsupported entities, and any approximation before interpreting a difference.",
        ],
      },
      {
        id: "inspect-results",
        title: "Inspect, then share deliberately",
        body: [
          "Move between overview, sections, and individual findings. Export only when you intend to create a portable artifact; selecting local files alone should not transmit model data.",
        ],
      },
    ],
  },
  {
    path: "/docs/privacy/",
    title: "Privacy by default",
    description:
      "Understand what stays on your device and where explicit sharing begins.",
    eyebrow: "Data boundary",
    sections: [
      {
        id: "local-comparison",
        title: "Normal comparison stays local",
        body: [
          "Model files and heavy geometry buffers belong in the browser comparison runtime. Hosted identity, persistence, and collaboration are separate capabilities and are not prerequisites for local analysis.",
        ],
      },
      {
        id: "network-boundary",
        title: "Make network boundaries visible",
        body: [
          "Any future action that sends a model, report, finding, or saved view off-device should identify the destination and require a deliberate user action. Local file selection is not consent to upload.",
        ],
      },
      {
        id: "portable-artifacts",
        title: "Portable artifacts are explicit",
        body: [
          "Reports and sessions should use versioned, serializable schemas. This lets recipients understand an artifact without relying on hidden application state.",
        ],
      },
    ],
  },
  {
    path: "/docs/geometry-contract/",
    title: "Geometry contract",
    description: "The invariants that keep comparison results interpretable.",
    eyebrow: "Correctness boundary",
    sections: [
      {
        id: "preserve-source",
        title: "Preserve source meaning",
        body: [
          "Importers normalize geometry into typed arrays while preserving declared units, source transforms, warnings, provenance, and uncertainty. They must not silently recenter, rescale, align, repair, or reinterpret a model.",
        ],
      },
      {
        id: "algorithm-adapters",
        title: "Validate algorithm preconditions",
        body: [
          "Boolean, voxel, and distance methods answer different questions. Each comparison algorithm should sit behind an adapter that validates its preconditions and returns explicit warnings when the input falls outside them.",
        ],
      },
      {
        id: "deterministic-evidence",
        title: "Prefer reproducible evidence",
        body: [
          "Fixtures, deterministic outputs, hostile-input limits, cancellation, and recovery behavior are acceptance evidence. A convincing render cannot substitute for a correct data contract.",
        ],
      },
    ],
  },
  {
    path: "/docs/brand/",
    title: "Brand assets",
    description: "Scalable mark and wordmark treatments for product surfaces.",
    eyebrow: "Visual system",
    sections: [
      {
        id: "mark",
        title: "Voxel eye",
        body: [
          "The mark is a compact voxel ring around a clear center. It remains recognizable at favicon scale and can render in brand color or a single current color.",
        ],
      },
      {
        id: "wordmark",
        title: "Wordmark",
        body: [
          "The wordmark pairs a sturdy neutral name with a restrained green accent. Use the icon alone where width is limited and the complete lockup when identity needs to be explicit.",
        ],
      },
    ],
  },
];

export const searchableDocs = docs.flatMap((doc) => [
  {
    path: doc.path,
    title: doc.title,
    excerpt: doc.description,
    keywords: `${doc.eyebrow} ${doc.sections.map((section) => `${section.title} ${section.body.join(" ")}`).join(" ")}`,
  },
  ...doc.sections.map((section) => ({
    path: `${doc.path}#${section.id}`,
    title: section.title,
    excerpt: section.body[0],
    keywords: `${doc.title} ${doc.eyebrow} ${section.body.join(" ")}`,
  })),
]);

export const prerenderRoutes = [
  "/",
  "/tools/",
  "/docs/",
  ...docs.map((doc) => doc.path),
];
