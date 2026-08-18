export interface DocPage {
  path: string;
  eyebrow: string;
  title: string;
  description: string;
  sections: { id: string; title: string; paragraphs: string[] }[];
}

export type ToolStatus = "available" | "planned";

/** A serializable catalog entry for one tool in the VoxelSpy toolbox. Holds
 *  no React or DOM references so it can be shared with a prerendered page,
 *  a test, or (later) a non-web consumer without changes. */
export interface Tool {
  /** Stable, URL-safe identifier, also used as the React list key. */
  id: string;
  /** Canonical route. For a `planned` tool this is the route it will use
   *  once built, not a route that exists yet -- see `routes` below, which
   *  only lists routes the build actually emits. */
  path: string;
  name: string;
  /** One line, used in compact contexts (catalog card headline, nav). */
  description: string;
  /** A longer paragraph of detail, used where there is room to explain what
   *  the tool does and, for a planned tool, what it will do. */
  summary: string;
  status: ToolStatus;
  /** The user question this tool answers, stated plainly. */
  question: string;
  /** Focused landing pages that lead with one aspect of this tool's report
   *  rather than duplicating the tool itself -- see `InspectFocusPage`. The
   *  catalog renders these as a sub-list under the tool's own card, never as
   *  additional `Tool` entries: they share this tool's implementation, so
   *  listing them as siblings in `tools` would overstate how many tools
   *  actually exist. Only ever set on an `available` tool. */
  entryPoints?: { id: string; path: string; name: string; question: string }[];
}

export type InspectFocusId = "scale" | "volume" | "watertight";

/**
 * A focused landing route into the Inspect tool: the same worker-backed,
 * single-model inspection and the same full report as `/tools/inspect/`,
 * parameterised by which aspect of that report leads. Someone who searches
 * "STL volume calculator" or "is my STL watertight" should land on a page
 * that answers exactly that question in its own words and then reveals the
 * fuller report, rather than a generic "Inspect" landing page or a second
 * implementation. `InspectFlow`'s `focus` prop reads this list; `App`'s
 * routing and metadata do too, so a focus page needs no metadata or routing
 * code of its own beyond an entry here and in `routes` below.
 */
export interface InspectFocusPage {
  id: InspectFocusId;
  path: string;
  eyebrow: string;
  title: string;
  /** One line: the ToolShell description and the page's meta description. */
  description: string;
  /** Intro paragraphs shown above the shared Inspect report, answering this
   *  page's own question before the fuller report appears below the fold. */
  intro: string[];
  /** The user question this page answers, stated plainly -- echoed in the
   *  tools catalog's entry-point sub-list. */
  question: string;
}

export const inspectFocusPages: InspectFocusPage[] = [
  {
    id: "scale",
    path: "/tools/scale/",
    eyebrow: "Inspect · Units & scale",
    title: "Is this model in millimetres or inches?",
    description:
      "Check a model's dimensions against the unit and axis VoxelSpy actually resolved, and reinterpret them deliberately if the file guessed wrong.",
    intro: [
      "Neither STL nor the OBJ subset this release supports declares a unit or an up-axis authoritatively, so an import starts from millimetre, right-handed Z-up defaults and records exactly that choice as provenance. This page leads with the resulting dimensions and the control that lets you say the file actually meant something else -- open below.",
      "Reinterpreting a unit is a deliberate, provenance-recorded choice you make before inspecting, never a silent rescale: the source unit and axis you select stay attached to the result and are shown next to what the file itself suggested.",
    ],
    question: "Is this model in millimetres or inches?",
  },
  {
    id: "volume",
    path: "/tools/volume/",
    eyebrow: "Inspect · Volume & surface area",
    title: "What is this model's volume?",
    description:
      "Get a model's enclosed volume and surface area, or, when the mesh cannot support one, the specific structural reason a volume figure is withheld.",
    intro: [
      "An enclosed-volume figure is only meaningful for a mesh that is genuinely closed and consistently oriented: open boundary edges, non-manifold edges, or inconsistent triangle winding make the number meaningless, so it is withheld rather than printed anyway with false confidence. This page leads with that number, or with the exact reason it is missing.",
      "Surface area does not depend on the mesh being closed, so it is always reported alongside volume, whichever way that turns out.",
    ],
    question: "What is this model's volume, and can it be trusted?",
  },
  {
    id: "watertight",
    path: "/tools/watertight/",
    eyebrow: "Inspect · Watertightness",
    title: "Is this model watertight?",
    description:
      "Get a closed/not-closed verdict for a model's mesh topology, with every open boundary edge or non-manifold edge that keeps it from closing.",
    intro: [
      "A mesh is watertight only when every edge is shared by exactly two triangle corners, checked with exact-coordinate adjacency rather than a tolerance-based weld: two triangle corners count as the same point only when their coordinates are bit-for-bit identical. This page leads with that verdict and the topology findings behind it.",
      "A model assembled from parts that are geometrically touching but not exactly coincident can still report open boundary edges even though it looks closed when rendered.",
    ],
    question: "Is this model watertight?",
  },
];

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
    description:
      "The invariants that keep comparison and single-model inspection results interpretable.",
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
        id: "single-model-inspection",
        title: "Inspecting one model alone",
        paragraphs: [
          "Inspect reports on one model without a baseline: bounds and dimensions, surface area, volume (or the reasons volume is withheld), placed vertex/triangle/mesh/instance/component counts, a bounded list of topology findings, a watertightness verdict, and a per-mesh breakdown, alongside the file's provenance and the unit/axis interpretation actually applied.",
          "Topology findings and the watertightness verdict use the same exact-coordinate adjacency as comparison: two triangle corners are the same point only when their coordinates are bit-for-bit identical, with no tolerance-based welding anywhere in the pipeline. A model assembled from parts that are geometrically touching but not exactly coincident can therefore report open boundary edges even though it looks closed when rendered.",
          "File Forensics (/tools/file-forensics/) complements Inspect rather than duplicating it: instead of geometric measurements, it reports the file's own structural and provenance truth -- the format this importer detected, mesh and instance structure, the declared-vs-resolved unit and axis with the exact applied transform, and every warning, note, or refused input the importer recorded. It reports what this importer saw, not a general verdict on the file: a file it accepts may still be rejected elsewhere, and vice versa.",
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

/** The VoxelSpy toolbox: tools for understanding, validating, measuring, and
 *  comparing 3D geometry. `Compare` and `Inspect` are built today -- every
 *  other entry is `planned` and says so plainly; the catalog page renders
 *  planned tools as non-link cards rather than dead links. Keep this
 *  honest: add a tool here only once it is real, and flip `status` to
 *  `"available"` (and add its `path` to `routes` below) only once the
 *  route actually exists. */
export const tools: Tool[] = [
  {
    id: "compare",
    path: "/compare/",
    name: "Compare",
    description: "Diff a baseline and a candidate model, region by region.",
    summary:
      "Load a trusted baseline and a candidate revision from your device and see exactly what moved, was added, was removed, or deviated beyond tolerance, with per-region evidence and an exportable report or session. Comparison runs entirely in your browser.",
    status: "available",
    question: "What changed between this baseline and this candidate?",
  },
  {
    id: "inspect",
    path: "/tools/inspect/",
    name: "Inspect",
    description:
      "Look inside one model without a second one to compare against.",
    summary:
      "Open a single model from your device and get a full local report: dimensions, surface area, volume (or the reasons it is withheld), watertightness, bounded topology findings, and a per-mesh breakdown, alongside the exact unit and axis interpretation applied. Runs entirely in your browser.",
    status: "available",
    question: "What is actually inside this one model?",
    entryPoints: inspectFocusPages.map((page) => ({
      id: page.id,
      path: page.path,
      name: page.title,
      question: page.question,
    })),
  },
  {
    id: "measure-section",
    path: "/tools/measure-section/",
    name: "Measure & Section",
    description: "Take dimensions and cross-sections straight off a model.",
    summary:
      "Place point-to-point and section-plane measurements directly on a model's geometry, with source units preserved. Measure & Section is not built yet.",
    status: "planned",
    question: "How big is this, and what does it look like sliced open?",
  },
  {
    id: "clearance-fit",
    path: "/tools/clearance-fit/",
    name: "Clearance & Fit",
    description: "Check the gap or interference between two parts.",
    summary:
      "Test whether two models fit together the way they are supposed to: minimum clearance, overlap volume, and where along the surface the fit gets tight. Clearance & Fit is not built yet.",
    status: "planned",
    question: "Will these two parts actually fit together?",
  },
  {
    id: "mesh-health",
    path: "/tools/mesh-health/",
    name: "Mesh Health",
    description: "Find non-manifold edges, holes, and other mesh defects.",
    summary:
      "Scan a mesh for the structural problems that break downstream tools: non-manifold edges, holes, self-intersections, and inverted normals, each located and explained. Mesh Health is not built yet.",
    status: "planned",
    question:
      "Is this mesh actually sound, or does it just look fine rendered?",
  },
  {
    id: "printability",
    path: "/tools/printability/",
    name: "Printability",
    description: "Check a model against practical 3D-printing constraints.",
    summary:
      "Evaluate wall thickness, overhang angles, and unsupported spans against limits for a given process, before committing material and time to a print. Printability is not built yet.",
    status: "planned",
    question: "Will this actually print the way I expect?",
  },
  {
    id: "file-forensics",
    path: "/tools/file-forensics/",
    name: "File Forensics",
    description: "Understand what a model file actually encodes, byte by byte.",
    summary:
      "Open a single STL or OBJ file from your device and see what this importer actually saw: the detected format, byte size against its declared ceilings, content digest, mesh and instance structure, the declared-vs-resolved unit and axis with the exact applied transform, and every warning, note, and refused input. Runs entirely in your browser.",
    status: "available",
    question: "What is this file actually telling me, and can I trust it?",
  },
];

export const routes = [
  "/",
  "/tools/",
  "/compare/",
  "/tools/inspect/",
  ...inspectFocusPages.map((page) => page.path),
  "/tools/file-forensics/",
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
