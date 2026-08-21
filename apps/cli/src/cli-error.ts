/**
 * Thrown for any problem detected before a geometry engine runs: a bad flag,
 * a missing positional argument, an out-of-range option value, an unreadable
 * file, or an unsupported format. Every command's top-level handler catches
 * this specifically and maps it to `EXIT_USAGE_ERROR` with `message` printed
 * verbatim -- never a generic "something went wrong."
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
