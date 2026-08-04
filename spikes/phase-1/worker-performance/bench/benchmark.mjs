import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import {
  detectTransportCapabilities,
  SPIKE_PROTOCOL_VERSION,
} from "../dist/index.js";

const elementCount = positiveInteger(process.env.SPIKE_ELEMENTS, 250_000);
const iterations = positiveInteger(process.env.SPIKE_ITERATIONS, 3);
const chunkSize = positiveInteger(process.env.SPIKE_CHUNK_SIZE, 16_384);
const capabilities = detectTransportCapabilities();
const modes = ["clone", "transfer"];
if (capabilities.sharedMemoryUsable) modes.push("shared");

const results = [];
for (const mode of modes) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await runSample(mode, iteration));
  }
  results.push({
    mode,
    samplesMs: samples.map((sample) => round(sample.durationMs)),
    medianMs: round(median(samples.map((sample) => sample.durationMs))),
    inputDetachedAfterSend: samples.every(
      (sample) => sample.inputDetachedAfterSend,
    ),
    checksum: samples[0]?.checksum,
  });
}

console.log(
  JSON.stringify(
    {
      scope: "single Node runtime; values are not browser or mobile claims",
      environment: {
        runtime: "node",
        version: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
      },
      configuration: {
        elementCount,
        iterations,
        chunkSize,
        bytesPerInput: elementCount * 8,
      },
      capabilities,
      results,
    },
    null,
    2,
  ),
);

async function runSample(mode, iteration) {
  const worker = new Worker(
    new URL("../dist/node-worker.js", import.meta.url),
    { type: "module" },
  );
  try {
    await nextMessage(worker, (message) => message.type === "ready");
    worker.postMessage({
      type: "initialize",
      requestId: "init",
      protocolVersion: SPIKE_PROTOCOL_VERSION,
      geometry: { scratchBytes: 0 },
    });
    await nextMessage(worker, (message) => message.type === "initialized");

    const buffer =
      mode === "shared"
        ? new SharedArrayBuffer(elementCount * 8)
        : new ArrayBuffer(elementCount * 8);
    const values = new Float64Array(buffer);
    for (let index = 0; index < values.length; index += 1)
      values[index] = ((index + iteration) % 17) - 8;
    const expectedChecksum = values.reduce(
      (sum, value) => sum + value * 1.5,
      0,
    );
    const request = {
      type: "run",
      requestId: `sample-${iteration}`,
      values,
      chunkSize,
      multiplier: 1.5,
    };
    const start = performance.now();
    if (mode === "transfer") worker.postMessage(request, [values.buffer]);
    else worker.postMessage(request);
    const inputDetachedAfterSend = values.byteLength === 0;
    const result = await nextMessage(
      worker,
      (message) => message.type === "result",
    );
    const durationMs = performance.now() - start;
    if (result.type !== "result" || result.checksum !== expectedChecksum) {
      throw new Error("Benchmark checksum did not match deterministic input");
    }
    return { durationMs, inputDetachedAfterSend, checksum: result.checksum };
  } finally {
    await worker.terminate();
  }
}

function nextMessage(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for benchmark worker")),
      10_000,
    );
    const onMessage = (message) => {
      if (predicate(message)) finish(undefined, message);
    };
    const onError = (error) => finish(error);
    function finish(error, message) {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      if (error) reject(error);
      else resolve(message);
    }
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0)
    throw new Error("Benchmark settings must be positive integers");
  return number;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
