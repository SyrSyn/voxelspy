import {
  SPIKE_PROTOCOL_VERSION,
  createInlineWorker,
  createModuleWorker,
  detectTransportCapabilities,
  type SpikeWorker,
  type WorkerResponse,
} from "@voxelspy/worker-performance-spike";

const output = document.querySelector<HTMLPreElement>("#output");
if (!output) throw new Error("Consumer output element is missing");
const outputElement = output;

outputElement.textContent = JSON.stringify(
  detectTransportCapabilities(),
  null,
  2,
);

document.querySelector("#module")?.addEventListener("click", () => {
  run(createModuleWorker());
});
document.querySelector("#inline")?.addEventListener("click", () => {
  run(createInlineWorker());
});

function run(worker: SpikeWorker): void {
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    outputElement.textContent = JSON.stringify(data, typedArrayReplacer, 2);
    if (data.type === "ready") {
      worker.postMessage(
        {
          type: "initialize",
          requestId: "consumer-init",
          protocolVersion: SPIKE_PROTOCOL_VERSION,
          geometry: { scratchBytes: 1024 },
        },
        [],
      );
    }
    if (data.type === "initialized") {
      const values = new Float64Array([1, 2, 3, 4]);
      worker.postMessage(
        {
          type: "run",
          requestId: "consumer-run",
          values,
          chunkSize: 2,
          multiplier: 3,
        },
        [values.buffer],
      );
    }
    if (data.type === "result" || data.type === "error") worker.terminate();
  };
}

function typedArrayReplacer(_key: string, value: unknown): unknown {
  return value instanceof Float64Array ? Array.from(value) : value;
}
