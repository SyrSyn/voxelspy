/** Output sink every command writes through, so tests can capture text instead of touching real stdio. */
export interface CommandIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export const processIO: CommandIO = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};
