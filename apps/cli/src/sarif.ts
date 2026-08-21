import { writeFileSync } from "node:fs";

/**
 * SARIF (Static Analysis Results Interchange Format) output for `--sarif`,
 * so a code-scanning system (GitHub code scanning, or any other SARIF
 * consumer) can ingest a `voxelspy` run the same way it ingests a linter or
 * SAST tool.
 *
 * This module hand-builds plain objects matching the SARIF 2.1.0 schema
 * shape rather than depending on a SARIF library (no new dependencies are
 * permitted for this slice). The required top-level shape it targets:
 * `sarifLog.version` + `sarifLog.runs[]`, each run carrying
 * `tool.driver.{name,rules[]}`, `artifacts[]`, and `results[]` where every
 * result has `ruleId`, `level`, `message.text`, and `locations[]` pointing
 * at an `artifactLocation.uri`.
 *
 * ## Honesty rules this module enforces
 *
 * - **No invented source positions.** Geometry findings have no line
 *   numbers. Every result's `locations` point only at the model file(s)
 *   involved (`artifactLocation.uri`), with no `region` -- inventing a
 *   `startLine`/`startColumn` for a triangle index would misrepresent what
 *   was actually measured. Triangle/region evidence instead goes in the
 *   result's `message` text and `properties`.
 * - **An unproven pass is never silently "clean."** Every `compare`/
 *   `clearance` run whose method is `semantics: "approximate"` always
 *   contributes an `approximate-result` finding (`note` level) stating the
 *   sampling bound, regardless of whether any policy check failed --
 *   `results: []` never means "nothing to disclose" for an approximate
 *   method, only "no policy violation." When the sample-spacing bound
 *   exceeds the requested tolerance/clearance, a separate
 *   `undersampled-region` finding (`warning` level) is added on top of that.
 * - **A policy failure is `error`.** Any `--max-*`/`--fail-on-*`/
 *   `--require-*` check the caller specified and that failed becomes an
 *   `error`-level result -- SARIF's strongest severity short of a tool
 *   crash, matching this being a hard CI gate.
 * - **Indeterminate is never a pass.** An `indeterminate` analysis outcome,
 *   a `checkClearance` indeterminate result, or an `InspectionResourceLimitError`
 *   always produces an `error`-level `indeterminate-analysis` finding,
 *   independent of `--fail-on-indeterminate` (which only changes the
 *   process *exit code*, never whether this SARIF finding is recorded).
 *
 * ## Determinism
 *
 * No result carries a generated timestamp or random identifier. SARIF's
 * `invocation.startTimeUtc` is only ever set from an explicitly passed-in
 * `timestampUtc` string (never `Date.now()` internally), and is omitted
 * entirely by default -- so `voxelspy ... --sarif out.sarif` run twice
 * against the same inputs and options produces byte-identical output,
 * matching the determinism guarantee the rest of this CLI's JSON output
 * already makes.
 */

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA_URI =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/**
 * Duplicated from `apps/cli/package.json#version` rather than imported: this
 * workspace's shared `tsconfig.base.json` does not enable JSON module
 * resolution, and wiring that up (plus copying the JSON into `dist` for the
 * built CLI to read at runtime) was judged not worth it for one constant in
 * a private, unpublished package. Keep this in sync by hand when the
 * package version changes.
 */
export const CLI_TOOL_VERSION = "0.1.0";

export type SarifLevel = "error" | "warning" | "note" | "none";

/**
 * The complete rule catalogue this CLI ever emits. Every id below is
 * referenced by exactly one policy-check id or one universal
 * provenance/indeterminacy condition in `src/commands/*.ts` -- see each
 * command's `buildSarifFindings`-equivalent function for the mapping.
 */
export type SarifRuleId =
  | "deviation-exceeds-threshold"
  | "region-count-exceeds-threshold"
  | "not-watertight"
  | "non-manifold-edges"
  | "degenerate-triangles"
  | "clearance-violation"
  | "indeterminate-analysis"
  | "approximate-result"
  | "undersampled-region";

interface SarifRuleDefinition {
  readonly id: SarifRuleId;
  readonly name: string;
  readonly shortDescription: string;
  readonly fullDescription: string;
  /** Fixed per rule: this catalogue never reports the same rule at two different levels across commands. */
  readonly level: SarifLevel;
}

/**
 * Declaration order also fixes the order rules are ever listed in
 * `tool.driver.rules` (filtered to only the rules a given run actually
 * used), independent of the order findings happen to be pushed in.
 */
const SARIF_RULE_CATALOGUE: readonly SarifRuleDefinition[] = [
  {
    id: "deviation-exceeds-threshold",
    name: "DeviationExceedsThreshold",
    shortDescription:
      "Measured maximum surface deviation exceeds the configured threshold.",
    fullDescription:
      "`compare --max-deviation` failed: the true maximum surface-distance " +
      "(across all detected changed regions, independent of --max-regions " +
      "truncation) exceeds the configured threshold. surface-distance is a " +
      "sampled method -- see this run's approximate-result finding for the " +
      "sampling bound this measurement is subject to.",
    level: "error",
  },
  {
    id: "region-count-exceeds-threshold",
    name: "RegionCountExceedsThreshold",
    shortDescription:
      "The true detected changed-region count exceeds the configured threshold.",
    fullDescription:
      "`compare --fail-on-regions` failed: the true number of detected " +
      "changed regions (independent of --max-regions truncation) exceeds " +
      "the configured threshold.",
    level: "error",
  },
  {
    id: "not-watertight",
    name: "NotWatertight",
    shortDescription:
      "A model is not watertight (closed): it has boundary or non-manifold edges.",
    fullDescription:
      "`--require-watertight` failed for `compare` or `inspect`: at least " +
      "one referenced model is not topologically closed. This is an exact " +
      "finding over the tessellated mesh, not a sampled measurement.",
    level: "error",
  },
  {
    id: "non-manifold-edges",
    name: "NonManifoldEdges",
    shortDescription: "At least one non-manifold edge is present.",
    fullDescription:
      "`inspect --fail-on-non-manifold` failed: the model has at least one " +
      "edge shared by more than two triangles. This is an exact topology " +
      "finding over the tessellated mesh, not a sampled measurement.",
    level: "error",
  },
  {
    id: "degenerate-triangles",
    name: "DegenerateTriangles",
    shortDescription: "At least one zero/non-finite-area triangle is present.",
    fullDescription:
      "`inspect --fail-on-degenerate` failed: the model has at least one " +
      "degenerate (zero-area or non-finite) triangle. This is an exact " +
      "topology finding over the tessellated mesh, not a sampled measurement.",
    level: "error",
  },
  {
    id: "clearance-violation",
    name: "ClearanceViolation",
    shortDescription:
      'The clearance state is "tight" or "interfering" against the configured policy.',
    fullDescription:
      '`clearance`\'s fit-gate policy failed: the state is "interfering" ' +
      "(confirmed by an exact triangle-triangle intersection, or the sampled " +
      'minimum distance landed exactly on zero), or "tight" and ' +
      "--allow-tight was not passed. See the finding's properties for which.",
    level: "error",
  },
  {
    id: "indeterminate-analysis",
    name: "IndeterminateAnalysis",
    shortDescription: "The engine could not produce a decidable result.",
    fullDescription:
      'The analysis/clearance/inspection engine hit `state: "indeterminate"`, ' +
      "an execution-budget ceiling, or a resource-limit refusal. Nothing " +
      "about the geometry was proven true or false -- this is fail-closed, " +
      "reported as `error` regardless of whether --fail-on-indeterminate was " +
      "passed (that flag only changes the process exit code, never whether " +
      "this finding is recorded).",
    level: "error",
  },
  {
    id: "approximate-result",
    name: "ApproximateResult",
    shortDescription:
      "This run's method is approximate, not an exact geometric proof.",
    fullDescription:
      "`surface-distance` and `clearance-fit-check` sample each triangle's " +
      "vertices and centroid rather than measuring continuously across the " +
      "surface. This finding is recorded on every approximate-method run -- " +
      "passing or failing -- so a passing policy result never reads, on its " +
      "own, as a stronger claim than the reported sampling bound supports.",
    level: "note",
  },
  {
    id: "undersampled-region",
    name: "UndersampledRegion",
    shortDescription:
      "The sample-spacing bound exceeds the requested tolerance/clearance.",
    fullDescription:
      "The farthest any point on an analyzed triangle could be from its " +
      "nearest sample exceeds the requested tolerance/clearance value: a " +
      "feature confined to a single coarse triangle's interior could have " +
      "been missed entirely, with no defect in the tolerance value itself.",
    level: "warning",
  },
];

const SARIF_RULES: Readonly<Record<SarifRuleId, SarifRuleDefinition>> =
  Object.fromEntries(
    SARIF_RULE_CATALOGUE.map((rule) => [rule.id, rule]),
  ) as Record<SarifRuleId, SarifRuleDefinition>;

/** One geometry finding, ready to become one SARIF `result`. `level` is intentionally not a field here -- it is always looked up from the fixed per-rule level in `SARIF_RULE_CATALOGUE`, so a finding can never drift from its rule's documented severity. */
export interface SarifFinding {
  readonly ruleId: SarifRuleId;
  readonly message: string;
  /** Model file(s) this finding concerns. Rendered as `artifactLocation.uri` with no `region` -- see this module's doc comment. */
  readonly artifactUris: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface SarifArtifactInput {
  readonly uri: string;
}

export interface SarifBuildInput {
  readonly command: string;
  readonly artifacts: readonly SarifArtifactInput[];
  readonly findings: readonly SarifFinding[];
  /** Run-level provenance: method, version, tolerance, sampling bound, uncertainty -- the same evidence the text/--json output already carries. */
  readonly runProperties: Readonly<Record<string, unknown>>;
  /**
   * Explicit, caller-supplied timestamp only. Never generated from
   * `Date.now()` internally -- omit this to keep output deterministic
   * (the default), or pass a fixed string when a consumer specifically
   * wants `invocations[].startTimeUtc` recorded.
   */
  readonly timestampUtc?: string;
}

/** Builds a SARIF 2.1.0 log object (one run) from a command's findings. Pure and deterministic: identical input always produces a deep-equal (and, once serialized, byte-identical) result. */
export function buildSarifLog(input: SarifBuildInput): Record<string, unknown> {
  const usedRuleIds = new Set(input.findings.map((finding) => finding.ruleId));
  const orderedRuleIds = SARIF_RULE_CATALOGUE.map((rule) => rule.id).filter(
    (id) => usedRuleIds.has(id),
  );
  const ruleIndexById = new Map(orderedRuleIds.map((id, index) => [id, index]));

  const rules = orderedRuleIds.map((id) => {
    const rule = SARIF_RULES[id];
    return {
      id: rule.id,
      name: rule.name,
      shortDescription: { text: rule.shortDescription },
      fullDescription: { text: rule.fullDescription },
      defaultConfiguration: { level: rule.level },
    };
  });

  const results = input.findings.map((finding) => {
    const rule = SARIF_RULES[finding.ruleId];
    return {
      ruleId: finding.ruleId,
      ruleIndex: ruleIndexById.get(finding.ruleId),
      level: rule.level,
      message: { text: finding.message },
      locations: finding.artifactUris.map((uri) => ({
        physicalLocation: { artifactLocation: { uri } },
      })),
      ...(finding.properties === undefined
        ? {}
        : { properties: finding.properties }),
    };
  });

  return {
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "voxelspy",
            version: CLI_TOOL_VERSION,
            rules,
          },
        },
        artifacts: input.artifacts.map((artifact) => ({
          location: { uri: artifact.uri },
        })),
        results,
        ...(input.timestampUtc === undefined
          ? {}
          : {
              invocations: [
                { executionSuccessful: true, startTimeUtc: input.timestampUtc },
              ],
            }),
        properties: { command: input.command, ...input.runProperties },
      },
    ],
  };
}

export function writeSarifFile(
  path: string,
  log: Record<string, unknown>,
): void {
  writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}
