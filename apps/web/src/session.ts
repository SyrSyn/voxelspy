import type { ModelComparisonPresentationSummary } from "@voxelspy/analysis";
import type {
  AnalysisResult,
  NormalizedModel,
  Report,
  SessionArchiveLimits,
} from "@voxelspy/contracts";
import {
  createSessionArchive,
  openSessionArchive,
  SessionArchiveError,
  type OpenedSessionArchive,
  type SessionArchiveErrorCode,
} from "@voxelspy/session-archive";
import { brandId, buildComparisonReport } from "./report";
import type { SessionImportSpec } from "./worker-client";

/**
 * This app's `tsconfig.json` combines the DOM and Node type libraries, which
 * (as a side effect of that combination) makes a bare `Uint8Array` resolve to
 * the more general `Uint8Array<ArrayBufferLike>` here, while
 * `@voxelspy/session-archive` and the DOM `Blob` constructor were both
 * declared against the narrower `Uint8Array<ArrayBuffer>`. Every byte array
 * this module produces is genuinely backed by a real `ArrayBuffer` (never a
 * `SharedArrayBuffer`), so this is a type-only bridge between two valid
 * defaults, not a runtime behavior change.
 */
export function asArrayBufferBacked(
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

/** File extension used for downloaded and reopened portable sessions. */
export const SESSION_FILE_EXTENSION = ".voxelspy";
/** Media type used for the downloaded archive Blob (it is a plain ZIP). */
export const SESSION_FILE_MEDIA_TYPE = "application/zip";

/**
 * The session contract requires a `createdAt` UTC instant on the report and
 * on its saved view, but saving must be byte-for-byte deterministic: saving
 * the same comparison twice has to produce the same archive, so this module
 * never reads the wall clock. This fixed sentinel satisfies the contract's
 * shape (a valid, round-tripping UTC instant) honestly, without pretending
 * to record when the save happened. See the handoff report for this
 * tradeoff; changing the contract to make "createdAt" optional or
 * content-derived would be a coordinated contracts change, not this one.
 */
const SESSION_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * Fixed `Report["id"]` embedded in every saved session's report.
 *
 * `buildComparisonReport` deliberately leaves report identity to its
 * caller. The interactive "Export report" action (see `ComparisonFlow.tsx`)
 * mints a fresh `crypto.randomUUID()`-derived id per export, because each
 * export is a distinct document the user is choosing to create right now.
 * A session is different: there is exactly one report per session archive
 * by construction, saving the same comparison twice must be byte-identical
 * (asserted by this module's tests), and nothing in this application ever
 * needs to distinguish one session's embedded report from another by id --
 * the archive's own model source digests are its real content-identity
 * signal. Deriving the id from `analysis.requestId` (as an earlier version
 * of this function did) would still have been deterministic, but it would
 * entangle report identity with analysis-request identity for no product
 * benefit. A single fixed literal is the most honest option: it does not
 * imply a uniqueness this application does not need or provide.
 */
const SESSION_REPORT_ID = brandId<Report["id"]>("report.session");

/**
 * Caller-supplied archive limits (the contracts package has no implicit
 * product default; every save and open call must provide one explicitly).
 * Sized generously above the importer's 32 MiB single-model safety ceiling
 * so a save never fails for a model this application would otherwise have
 * accepted. Version 1 sessions always use the archive's uncompressed
 * "stored" profile, so the compression ratio never legitimately exceeds 1;
 * the small headroom below guards only against benign rounding.
 */
export const SESSION_ARCHIVE_LIMITS: SessionArchiveLimits = {
  maxArchiveBytes: 192 * 1024 * 1024,
  maxEntries: 4,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalExpandedBytes: 192 * 1024 * 1024,
  maxCompressionRatio: 1.5,
  maxManifestBytes: 1024 * 1024,
  maxReportBytes: 64 * 1024 * 1024,
};

export interface SessionSourceModels {
  baseline: Uint8Array;
  candidate: Uint8Array;
}

export interface SessionComparison {
  baseline: NormalizedModel;
  candidate: NormalizedModel;
  analysis: AnalysisResult;
  /**
   * The same presentation summary the workbench displays for this
   * comparison. Computing it is heavy enough that this application always
   * derives it off the main thread (see `summary-worker-client.ts`); this
   * module stays a plain function of an already-computed summary so it has
   * no worker or browser dependency of its own.
   */
  summary: ModelComparisonPresentationSummary;
}

export interface SaveSessionInput extends SessionComparison {
  sourceModels: SessionSourceModels;
}

export interface SavedSession {
  bytes: Uint8Array;
  report: Report;
  fileName: string;
}

/**
 * Builds the versioned `Report` a saved session embeds.
 *
 * This delegates entirely to the same `buildComparisonReport` engine the
 * interactive "Export report" action uses (see `ComparisonFlow.tsx`), so a
 * saved session now embeds the same rich findings, overview saved view,
 * and geometry-summary narrative an exported report would show for an
 * identical comparison -- there is no separate, thinner "session report"
 * format to keep in sync. Only the `id` and `createdAt` differ from an
 * interactive export, and both are fixed constants rather than
 * clock/random-derived: this module never reads the wall clock or `crypto`,
 * so saving the same comparison twice is still byte-for-byte deterministic
 * (asserted by this module's tests). See `SESSION_REPORT_ID` and
 * `SESSION_TIMESTAMP` above for why each is fixed rather than derived.
 *
 * The product has no markup or saved-view authoring UI yet, so `markups`
 * and `figures` stay empty and there is always exactly one saved view (the
 * engine's overview view); reopening a session does not depend on that
 * view's framing being anything specific -- the workbench frames the
 * restored models with its usual default camera, exactly as it does for a
 * freshly completed comparison.
 */
export function buildSessionReport(input: SessionComparison): Report {
  return buildComparisonReport({
    id: SESSION_REPORT_ID,
    createdAt: SESSION_TIMESTAMP,
    baseline: input.baseline,
    candidate: input.candidate,
    analysis: input.analysis,
    summary: input.summary,
  });
}

export function slug(value: string | undefined): string {
  const cleaned = (value ?? "")
    .replace(/\.[^./]+$/u, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return cleaned || "model";
}

export function sessionFileName(report: Report): string {
  const baseline = report.models.find((model) => model.role === "baseline");
  const candidate = report.models.find((model) => model.role === "candidate");
  return `voxelspy-session-${slug(baseline?.sourceName)}-vs-${slug(candidate?.sourceName)}${SESSION_FILE_EXTENSION}`;
}

/**
 * Builds the report and calls the session-archive writer. Deterministic
 * given the same inputs: no timestamps or randomness are introduced here or
 * in `buildSessionReport`.
 */
export async function saveSession(
  input: SaveSessionInput,
): Promise<SavedSession> {
  const report = buildSessionReport(input);
  const sourceModels = new Map<string, Uint8Array>();
  for (const model of report.models) {
    const bytes =
      model.role === "baseline"
        ? input.sourceModels.baseline
        : input.sourceModels.candidate;
    sourceModels.set(model.sourcePath, bytes);
  }
  const { bytes } = await createSessionArchive({
    report,
    sourceModels,
    limits: SESSION_ARCHIVE_LIMITS,
  });
  return { bytes, report, fileName: sessionFileName(report) };
}

/**
 * Opens and fully validates a `.voxelspy` session archive. All hostile-input
 * validation (structure, limits, digests, manifest/report agreement) is
 * performed by `@voxelspy/session-archive`; this is a thin wrapper that
 * supplies this application's archive limits.
 */
export async function openSession(
  bytes: Uint8Array,
): Promise<OpenedSessionArchive> {
  return openSessionArchive({
    contractVersion: 1,
    bytes: asArrayBufferBacked(bytes),
    limits: SESSION_ARCHIVE_LIMITS,
  });
}

/**
 * Converts one report model entry plus its extracted source bytes into the
 * shape the comparison worker's import protocol needs to deterministically
 * reproduce the same normalized geometry that was originally saved.
 */
export function sessionImportSpecFor(
  model: Report["models"][number],
  bytes: Uint8Array,
): SessionImportSpec {
  const provenance = model.normalizationProvenance;
  const options: SessionImportSpec["options"] = {};
  if (provenance.sourceResolution.unit === "user")
    options.userUnit = provenance.sourceUnit;
  else if (provenance.sourceResolution.unit === "declared")
    options.declaredUnit = provenance.sourceUnit;
  if (provenance.sourceResolution.axis === "user")
    options.userAxis = provenance.sourceAxis;
  else if (provenance.sourceResolution.axis === "declared")
    options.declaredAxis = provenance.sourceAxis;
  return {
    targetModelId: model.modelId,
    format: provenance.formatId,
    sourceName: model.sourceName,
    bytes,
    options,
  };
}

const SESSION_ERROR_MESSAGES: Record<SessionArchiveErrorCode, string> = {
  INVALID_REQUEST: "That file could not be read as a session request.",
  ARCHIVE_LIMIT:
    "That session file is larger, or has more content, than this application accepts.",
  INVALID_ZIP:
    "That file is not a valid, uncompressed VoxelSpy session archive.",
  UNSUPPORTED_ZIP:
    "That archive uses a ZIP feature this application intentionally does not support, such as compression or encryption.",
  INVALID_PATH: "That archive contains an invalid or unsafe internal path.",
  DUPLICATE_PATH: "That archive contains duplicate internal entries.",
  INVALID_JSON: "That archive's session data is not valid, strict JSON.",
  UNSUPPORTED_VERSION:
    "That session was saved with a newer or unrecognized VoxelSpy version. Open it with a newer version of this application, or re-save it from one this version supports.",
  INVALID_MANIFEST:
    "That archive's manifest does not match the expected session format.",
  INVALID_REPORT:
    "That archive's report does not match the format this version of VoxelSpy understands; it may have been saved by a newer or different build.",
  MANIFEST_MISMATCH: "That archive's contents do not match its own manifest.",
  INTEGRITY_ERROR:
    "That archive failed an integrity check; its contents may be corrupted.",
};

/** Maps a session-open failure to a clear, user-facing message. Fail-closed: any unrecognized failure gets a safe generic message instead of leaking internals. */
export function describeSessionError(error: unknown): string {
  if (error instanceof SessionArchiveError)
    return SESSION_ERROR_MESSAGES[error.code] ?? error.message;
  return "That session file could not be opened safely.";
}
