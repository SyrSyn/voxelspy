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
      "Neither STL nor the OBJ subset this release supports declares a unit or an up-axis authoritatively, so an import of either format starts from millimetre, right-handed Z-up defaults and records exactly that choice as provenance. glTF/GLB and 3MF are different: both declare their own frame (glTF/GLB always metres and right-handed Y-up; 3MF its own unit and right-handed Z-up), so an import of either resolves that frame from the file itself rather than defaulting -- still shown here, and still overridable. This page leads with the resulting dimensions and the control that lets you say the file actually meant something else -- open below.",
      "Reinterpreting a unit is a deliberate, provenance-recorded choice you make before inspecting, never a silent rescale: the source unit and axis you select stay attached to the result and are shown next to what the file itself declared or suggested.",
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
          "This release accepts STL, OBJ, glTF, GLB, and 3MF. STL and OBJ import starts with common millimetre and right-handed Z-up settings, since neither format declares a source frame; glTF/GLB and 3MF resolve their frame from the file itself instead. If a source needs a different interpretation than what it starts from or declares, change its Expert settings before comparison; the selected interpretation remains attached to the result.",
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
        id: "clearance-and-fit",
        title: "Checking clearance between two parts",
        paragraphs: [
          "Clearance & Fit (/tools/clearance-fit/) checks two independently placed parts against each other: the minimum surface-to-surface distance with its closest-point pair, regions below a desired clearance, and interference evidence. Each part's placement transform is an explicit, deliberate input -- both parts start at the identity placement and this tool never auto-positions or auto-aligns either one.",
          "Two different kinds of precision live in one result. Interference (intersecting triangle pairs) is detected with an exact triangle-triangle intersection test, independent of tessellation. The minimum distance and tight regions are sampled the same way surface comparison is, so they carry the same sample-spacing bound described above: when that spacing exceeds the desired clearance, a small feature can violate it without being reported, and a “clear” verdict is flagged as not a geometric guarantee at that tessellation. No interference volume is computed for either verdict -- only concrete intersecting triangle pairs are ever reported as interference evidence.",
        ],
      },
      {
        id: "measure-and-section",
        title: "Measuring and sectioning one model",
        paragraphs: [
          "Measure & Section (/tools/measure-section/) answers click-to-measure and cross-section questions against one loaded model's own tessellated surface: exact snap-to-vertex/edge/face results, exact point-to-point distances, and exact cross-section loops from an exact triangle/plane intersection -- none of it sampled, unlike Compare's or Clearance & Fit's surface-distance methods.",
          "“Exact” there is still a claim about the mesh as imported, not about any original curved or CAD geometry that mesh approximates: a section through a part that was originally a cylinder still returns straight polyline segments through its triangulated facets, not a reconstructed arc. A plane that lies exactly in one or more faces contributes no segment from those faces on its own -- reported as a coincident-triangle count and a warning rather than a guessed outline.",
        ],
      },
      {
        id: "printability",
        title: "Checking printability evidence",
        paragraphs: [
          "Printability (/tools/printability/) reports evidence for a human decision, never a print/no-print verdict: approximate directional wall-thickness findings, exact overhang region area, exact disconnected-island evidence, and axis-aligned build-volume fit across every orientation. Slicer settings, material, and printer calibration decide whether a model actually prints, and this tool has no access to any of them -- every result it returns carries an explicit disclaimer saying so.",
          "Its checks carry different kinds of precision and are never combined into one badge. Wall thickness is sampled and directional: it probes a bounded set of triangles along each one's own inward normal, so it reports a sample-spacing bound, an unsampled-triangle count, and a missed-probe count alongside every finding, and a thin feature outside that coverage goes unreported rather than being assumed absent. Overhang area and island connectivity are exact for the tessellated mesh, the same exact-coordinate connectivity Inspect's watertightness and Clearance & Fit's region grouping already use. Build-volume fit checks only the six axis-order permutations of the model's own bounding box, never an arbitrary rotation search, so a model that fits only when reoriented is reported as such rather than as a plain failure.",
        ],
      },
      {
        id: "convert",
        title: "Simplifying and exporting a model",
        paragraphs: [
          "Convert (/tools/convert/) composes two steps against one loaded model: an optional simplification (`simplifyModel`, @voxelspy/analysis) to a triangle-count or reduction-ratio target, and an export (`exportModel`, @voxelspy/importers) to binary STL, ASCII STL, or OBJ. Simplification's own point is not the decimation -- a commodity -- but the certified, measured deviation it reports: the maximum and mean sampled distance between the original and simplified surfaces, in both directions, always shown next to its disclaimer rather than as a bare number, with `targetReached: false` reported plainly rather than hidden when the requested target could not be fully reached.",
          "Export never guesses a unit or axis: format, output unit, and output up-axis are all explicit choices with no default, because neither STL nor OBJ can declare a unit or axis inside the file itself -- every export states that plainly, alongside the exact interpretation a later re-import must declare to recover equivalent geometry. Binary STL's coordinates are IEEE-754 float32, so its round trip is bounded by float32 precision regardless of unit; the text formats (ASCII STL, OBJ) round-trip exactly at millimetre and to ordinary floating-point tolerance at any other unit.",
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
          "This release imports binary and text STL, a documented OBJ subset of vertices and faces, static mesh geometry from glTF 2.0 and GLB, and mesh geometry from the 3MF Core specification. Each source file is accepted up to 32 MiB and 500,000 triangles (1,500,000 vertices for OBJ). Content outside those documented subsets -- materials, curves, free-form surfaces, animations, skins, morph targets, and 3MF's Beam Lattice, Slice, Materials/Colours, and Production extensions -- is refused with a stated reason, or ignored with a named warning, rather than partially or silently reinterpreted.",
          "Neither STL nor OBJ authoritatively declares a unit or an up-axis, so importing either begins with millimetres and right-handed Z-up and exposes other interpretations as expert settings. glTF/GLB and 3MF are different: both declare their own frame in the file itself (glTF/GLB always metres and right-handed Y-up; 3MF its own unit, defaulting to millimetre, and right-handed Z-up per specification), so importing either resolves that declaration rather than defaulting -- an expert override is still available and is recorded distinctly from the file's own declaration. Whichever way a source's frame was resolved, the interpretation stays attached to the result.",
          "3MF's container is a ZIP archive, so its decompression carries its own bounded limits (entry count, per-entry and total decompressed bytes, and compression-ratio ceilings) independent of the triangle/vertex ceilings every format shares -- a maliciously crafted archive fails closed well before its declared content could be fully expanded.",
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
 *  comparing 3D geometry. `Compare`, `Inspect`, `File Forensics`, and
 *  `Clearance & Fit` are built today -- every other entry is `planned` and
 *  says so plainly; the catalog page renders planned tools as non-link cards
 *  rather than dead links. Keep this honest: add a tool here only once it is
 *  real, and flip `status` to `"available"` (and add its `path` to `routes`
 *  below) only once the route actually exists. */
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
      "Load a single local model, click its surface (or type coordinates) to build exact point-to-point measurements with their axis deltas, and cut a section plane to see cross-section loops with perimeter, closed/terminated status, and area where available. Runs entirely in your browser.",
    status: "available",
    question: "How big is this, and what does it look like sliced open?",
  },
  {
    id: "clearance-fit",
    path: "/tools/clearance-fit/",
    name: "Clearance & Fit",
    description: "Check the gap or interference between two parts.",
    summary:
      "Load two local parts, place each one deliberately, and check whether they fit: minimum surface-to-surface clearance with its closest-point pair, ranked tight regions, and exact triangle-pair interference evidence -- with no interference volume claimed and no auto-alignment. Runs entirely in your browser.",
    status: "available",
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
    description: "Get local evidence for wall thickness, overhangs, and fit.",
    summary:
      "Open a single local model and get evidence, not a verdict: approximate directional wall-thickness findings, exact overhang regions and their area, exact disconnected-island evidence, and axis-aligned build-volume fit across every orientation -- with the sampling bounds, truncation counts, and disclaimer shown next to each check. Runs entirely in your browser.",
    status: "available",
    question: "What does this model's surface actually measure like?",
  },
  {
    id: "file-forensics",
    path: "/tools/file-forensics/",
    name: "File Forensics",
    description: "Understand what a model file actually encodes, byte by byte.",
    summary:
      "Open a single model file (STL, OBJ, glTF, GLB, or 3MF) from your device and see what this importer actually saw: the detected format, byte size against its declared ceilings, content digest, mesh and instance structure, the declared-vs-resolved unit and axis with the exact applied transform, and every warning, note, and refused input. Runs entirely in your browser.",
    status: "available",
    question: "What is this file actually telling me, and can I trust it?",
  },
  {
    id: "convert",
    path: "/tools/convert/",
    name: "Convert",
    description: "Simplify a model with a certified deviation, then export it.",
    summary:
      "Load a single local model, optionally simplify it toward a triangle-count or reduction-ratio target with a measured, disclaimed certification of how far the result deviates from the original, then export the result (or the untouched original) to binary STL, ASCII STL, or OBJ in a unit and axis you choose explicitly. Runs entirely in your browser.",
    status: "available",
    question:
      "How do I simplify or convert this model, and how far off is the result?",
  },
];

export const routes = [
  "/",
  "/tools/",
  "/compare/",
  "/tools/inspect/",
  ...inspectFocusPages.map((page) => page.path),
  "/tools/file-forensics/",
  "/tools/clearance-fit/",
  "/tools/measure-section/",
  "/tools/printability/",
  "/tools/convert/",
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
