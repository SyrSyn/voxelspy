#!/usr/bin/env node
import { processIO } from "./io.js";
import { run } from "./run.js";

const exitCode = await run(process.argv.slice(2), processIO);
process.exitCode = exitCode;
