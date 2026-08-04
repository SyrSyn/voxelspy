export type SessionArchiveErrorCode =
  | "INVALID_REQUEST"
  | "ARCHIVE_LIMIT"
  | "INVALID_ZIP"
  | "UNSUPPORTED_ZIP"
  | "INVALID_PATH"
  | "DUPLICATE_PATH"
  | "INVALID_JSON"
  | "UNSUPPORTED_VERSION"
  | "INVALID_MANIFEST"
  | "INVALID_REPORT"
  | "MANIFEST_MISMATCH"
  | "INTEGRITY_ERROR";

export class SessionArchiveError extends Error {
  public override readonly name = "SessionArchiveError";
  public constructor(
    public readonly code: SessionArchiveErrorCode,
    message: string,
  ) {
    super(message);
  }
}
