import { clearanceCommand, CLEARANCE_HELP } from "./commands/clearance.js";
import { compareCommand, COMPARE_HELP } from "./commands/compare.js";
import { inspectCommand, INSPECT_HELP } from "./commands/inspect.js";
import { CliUsageError } from "./cli-error.js";
import { EXIT_OK, EXIT_USAGE_ERROR, type ExitCode } from "./exit-codes.js";
import type { CommandIO } from "./io.js";

const TOP_HELP = `voxelspy -- headless geometry comparison and inspection for scripts and CI.

Usage: voxelspy <command> [options]

Commands:
  compare <baseline> <candidate>   sampled surface-distance comparison
  inspect <model>                  single-model topology and watertightness
  clearance <first> <second>       fit/clearance check between two parts

Run "voxelspy <command> --help" for command-specific options.

Every command distinguishes four outcomes with a stable exit code:
  0  policy passed (or no policy was configured -- informational run)
  1  policy failed
  2  indeterminate / fail-closed (nothing was proven either way)
  3  usage or input error

Reads local files only. No network access, no telemetry.
`;

/** Dispatches to a subcommand and returns the process exit code. Never throws for an ordinary usage mistake -- `CliUsageError` is caught here and reported through `io.stderr`. */
export async function run(
  argv: readonly string[],
  io: CommandIO,
): Promise<ExitCode> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "compare":
        return await compareCommand(rest, io);
      case "inspect":
        return await inspectCommand(rest, io);
      case "clearance":
        return await clearanceCommand(rest, io);
      case "--help":
      case "-h":
        io.stdout(TOP_HELP);
        return EXIT_OK;
      case undefined:
        io.stderr("Missing command.");
        io.stdout(TOP_HELP);
        return EXIT_USAGE_ERROR;
      default:
        io.stderr(`Unknown command "${command}".`);
        io.stdout(TOP_HELP);
        return EXIT_USAGE_ERROR;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(error.message);
      return EXIT_USAGE_ERROR;
    }
    // node:util's `parseArgs` throws a plain `TypeError` carrying an
    // `ERR_PARSE_ARGS_*` code for an unknown flag or a missing/invalid
    // option value -- exactly a usage error, just not one of ours.
    if (
      error instanceof TypeError &&
      typeof (error as NodeJS.ErrnoException).code === "string" &&
      (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      io.stderr(error.message);
      return EXIT_USAGE_ERROR;
    }
    throw error;
  }
}

export { CLEARANCE_HELP, COMPARE_HELP, INSPECT_HELP, TOP_HELP };
