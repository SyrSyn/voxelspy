import {
  reportSchema,
  sessionArchiveExchangeSchema,
  sessionArchiveLimitsSchema,
  sessionArchivePreflightSchema,
  sessionBundleSchema,
  sessionLoadRequestSchema,
  sessionManifestSchema,
  type Report,
  type SessionArchiveLimits,
  type SessionBundle,
  type SessionManifest,
} from "@voxelspy/contracts";

import { digestSessionResource } from "./digest.js";
import { SessionArchiveError } from "./error.js";
import { decodeStrictJson, encodeCanonicalJson } from "./json.js";
import { createStoredZip, extractStoredZip, inspectStoredZip } from "./zip.js";

export { SessionArchiveError } from "./error.js";
export type { SessionArchiveErrorCode } from "./error.js";
export { digestSessionResource } from "./digest.js";

export type SessionArchivePreflight = ReturnType<
  typeof sessionArchivePreflightSchema.parse
>;
export type SessionLoadRequest = ReturnType<
  typeof sessionLoadRequestSchema.parse
>;
export type SessionArchiveExchange = ReturnType<
  typeof sessionArchiveExchangeSchema.parse
>;

export interface CreateSessionArchiveInput {
  report: Report;
  sourceModels: ReadonlyMap<string, Uint8Array>;
  limits: SessionArchiveLimits;
}

export interface CreatedSessionArchive {
  bytes: Uint8Array;
  bundle: SessionBundle;
  preflight: SessionArchivePreflight;
}

export interface OpenedSessionArchive {
  exchange: SessionArchiveExchange;
  resources: ReadonlyMap<string, Uint8Array>;
}

export async function createSessionArchive(
  input: CreateSessionArchiveInput,
): Promise<CreatedSessionArchive> {
  const limits = parseLimits(input.limits);
  const report = parseReport(input.report);
  if (limits.maxEntries < 4)
    fail(
      "ARCHIVE_LIMIT",
      "Session archive entry-count limit is too small for version 1",
    );
  const expectedPaths = new Set(
    report.models.map(({ sourcePath }) => sourcePath),
  );
  if (
    input.sourceModels.size !== expectedPaths.size ||
    [...input.sourceModels.keys()].some((path) => !expectedPaths.has(path))
  ) {
    fail(
      "MANIFEST_MISMATCH",
      "Source-model inputs must exactly match the report model paths",
    );
  }
  const reportBytes = encodeCanonicalJson(report);
  if (
    reportBytes.byteLength === 0 ||
    reportBytes.byteLength > limits.maxReportBytes ||
    reportBytes.byteLength > limits.maxEntryBytes
  )
    fail("ARCHIVE_LIMIT", "Session report exceeds its byte limit");
  let totalExpandedBytes = reportBytes.byteLength;
  const reportDigest = await digestSessionResource(reportBytes);
  const entries: SessionManifest["entries"] = [];
  const payloads = new Map<string, Uint8Array>();
  payloads.set("report.json", reportBytes);
  for (const model of report.models) {
    const source = input.sourceModels.get(model.sourcePath);
    if (source === undefined || source.byteLength === 0)
      fail("MANIFEST_MISMATCH", "A report source model is missing or empty");
    if (source.byteLength > limits.maxEntryBytes)
      fail("ARCHIVE_LIMIT", "A source model exceeds the entry byte limit");
    totalExpandedBytes = checkedTotal(
      totalExpandedBytes,
      source.byteLength,
      limits.maxTotalExpandedBytes,
    );
    const ownedSource = source.slice();
    const digest = await digestSessionResource(ownedSource);
    if (digest.value !== model.sourceDigest.value)
      fail(
        "INTEGRITY_ERROR",
        "A source model does not match its report digest",
      );
    payloads.set(model.sourcePath, ownedSource);
    entries.push({
      role: "source-model",
      modelId: model.modelId,
      modelRole: model.role,
      path: model.sourcePath,
      mediaType: model.sourceMediaType,
      bytes: ownedSource.byteLength,
      digest,
    });
  }
  entries.push({
    role: "report",
    path: "report.json",
    mediaType: "application/json",
    bytes: reportBytes.byteLength,
    digest: reportDigest,
  });
  entries.sort((left, right) => compareOrdinal(left.path, right.path));
  const manifest = parseManifest({
    contractVersion: 1,
    kind: "voxelspy-session",
    contentPolicy: "self-contained-source-models",
    reportId: report.id,
    createdAt: report.createdAt,
    reportPath: "report.json",
    entries,
  });
  const manifestBytes = encodeCanonicalJson(manifest);
  if (
    manifestBytes.byteLength > limits.maxManifestBytes ||
    manifestBytes.byteLength > limits.maxEntryBytes
  )
    fail("ARCHIVE_LIMIT", "Session manifest exceeds its byte limit");
  totalExpandedBytes = checkedTotal(
    totalExpandedBytes,
    manifestBytes.byteLength,
    limits.maxTotalExpandedBytes,
  );
  payloads.set("manifest.json", manifestBytes);
  if (estimateStoredZipBytes(payloads) > limits.maxArchiveBytes)
    fail("ARCHIVE_LIMIT", "Session archive exceeds its compressed-byte limit");
  const bytes = createStoredZip(payloads);
  const { preflight } = inspectStoredZip(bytes, limits);
  const bundle = parseBundle({
    manifest,
    manifestDigest: await digestSessionResource(manifestBytes),
    reportDigest,
    report,
  });
  return { bytes, bundle, preflight };
}

export function inspectSessionArchive(
  request: SessionLoadRequest,
): SessionArchivePreflight {
  const parsed = parseLoadRequest(request);
  return inspectStoredZip(parsed.bytes, parsed.limits).preflight;
}

export async function openSessionArchive(
  request: SessionLoadRequest,
): Promise<OpenedSessionArchive> {
  const parsedRequest = parseLoadRequest(request);
  const { preflight, entries } = inspectStoredZip(
    parsedRequest.bytes,
    parsedRequest.limits,
  );
  const resources = extractStoredZip(parsedRequest.bytes, entries);
  const manifestBytes = requiredResource(
    resources,
    "manifest.json",
    "Session manifest is missing",
  );
  const manifestValue = parseJson(manifestBytes, "manifest");
  assertVersion(manifestValue, "session manifest");
  const manifest = parseManifest(manifestValue);
  const expectedPaths = new Set([
    "manifest.json",
    ...manifest.entries.map(({ path }) => path),
  ]);
  if (
    expectedPaths.size !== resources.size ||
    [...resources.keys()].some((path) => !expectedPaths.has(path))
  )
    fail(
      "MANIFEST_MISMATCH",
      "Manifest entries do not exactly match the archive contents",
    );

  const verifiedResources = [];
  for (const [path, bytes] of resources)
    verifiedResources.push({
      path,
      bytes: bytes.byteLength,
      digest: await digestSessionResource(bytes),
    });
  const verifiedByPath = new Map(
    verifiedResources.map((resource) => [resource.path, resource]),
  );
  for (const entry of manifest.entries) {
    const verified = verifiedByPath.get(entry.path);
    if (
      verified === undefined ||
      verified.bytes !== entry.bytes ||
      verified.digest.value !== entry.digest.value
    )
      fail(
        "INTEGRITY_ERROR",
        "A session payload does not match its manifest size and digest",
      );
  }
  const reportBytes = requiredResource(
    resources,
    manifest.reportPath,
    "Session report is missing",
  );
  const reportValue = parseJson(reportBytes, "report");
  assertVersion(reportValue, "report");
  const report = parseReport(reportValue);
  const reportDigest = await digestSessionResource(reportBytes);
  const bundle = parseBundle({
    manifest,
    manifestDigest: verifiedByPath.get("manifest.json")!.digest,
    reportDigest,
    report,
  });
  const exchange = sessionArchiveExchangeSchema.safeParse({
    request: parsedRequest,
    preflight,
    bundle,
    verifiedResources,
  });
  if (!exchange.success)
    fail(
      "MANIFEST_MISMATCH",
      "Session archive evidence is internally inconsistent",
    );
  return { exchange: exchange.data, resources };
}

function parseLimits(value: unknown): SessionArchiveLimits {
  const result = sessionArchiveLimitsSchema.safeParse(value);
  if (!result.success)
    fail("INVALID_REQUEST", "Session archive limits are invalid");
  return result.data;
}
function parseLoadRequest(value: unknown): SessionLoadRequest {
  const result = sessionLoadRequestSchema.safeParse(value);
  if (!result.success)
    fail("INVALID_REQUEST", "Session load request is invalid");
  return result.data;
}
function parseManifest(value: unknown): SessionManifest {
  const result = sessionManifestSchema.safeParse(value);
  if (!result.success)
    fail(
      "INVALID_MANIFEST",
      "Session manifest does not satisfy contract version 1",
    );
  return result.data;
}
function parseReport(value: unknown): Report {
  const result = reportSchema.safeParse(value);
  if (!result.success)
    fail(
      "INVALID_REPORT",
      "Session report does not satisfy contract version 1",
    );
  return result.data;
}
function parseBundle(value: unknown): SessionBundle {
  const result = sessionBundleSchema.safeParse(value);
  if (!result.success)
    fail("MANIFEST_MISMATCH", "Session report and manifest do not agree");
  return result.data;
}
function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return decodeStrictJson(bytes);
  } catch {
    fail("INVALID_JSON", `Session ${label} is not strict UTF-8 JSON`);
  }
}
function assertVersion(value: unknown, label: string): void {
  const version =
    typeof value === "object" && value !== null && "contractVersion" in value
      ? (value as { contractVersion?: unknown }).contractVersion
      : undefined;
  if (version !== 1)
    fail("UNSUPPORTED_VERSION", `Unsupported ${label} contract version`);
}
function requiredResource(
  resources: ReadonlyMap<string, Uint8Array>,
  path: string,
  message: string,
): Uint8Array {
  const value = resources.get(path);
  if (value === undefined) fail("MANIFEST_MISMATCH", message);
  return value;
}
function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function checkedTotal(
  current: number,
  addition: number,
  maximum: number,
): number {
  const total = current + addition;
  if (!Number.isSafeInteger(total) || total > maximum)
    fail(
      "ARCHIVE_LIMIT",
      "Session payloads exceed the total expanded-byte limit",
    );
  return total;
}
function estimateStoredZipBytes(
  files: ReadonlyMap<string, Uint8Array>,
): number {
  let total = 22;
  const encoder = new TextEncoder();
  for (const [path, bytes] of files) {
    total += 76 + encoder.encode(path).byteLength * 2 + bytes.byteLength;
    if (!Number.isSafeInteger(total))
      fail("ARCHIVE_LIMIT", "Session archive size is not safely representable");
  }
  return total;
}
function fail(
  code: ConstructorParameters<typeof SessionArchiveError>[0],
  message: string,
): never {
  throw new SessionArchiveError(code, message);
}
