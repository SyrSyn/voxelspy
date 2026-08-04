import { detectTransportCapabilities } from "./capabilities.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import inlineWorkerSource from "virtual:inline-worker-source";

export { detectTransportCapabilities } from "./capabilities.js";
export { SPIKE_PROTOCOL_VERSION } from "./protocol.js";
export type { TransportCapabilities } from "./capabilities.js";
export type { WorkerRequest, WorkerResponse } from "./protocol.js";

export type SpikeWorker = Omit<Worker, "postMessage" | "onmessage"> & {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onmessage:
    ((this: Worker, event: MessageEvent<WorkerResponse>) => unknown) | null;
};

export function createModuleWorker(): SpikeWorker {
  return new Worker(new URL("./browser-worker.js", import.meta.url), {
    type: "module",
    name: "worker-performance-spike",
  }) as SpikeWorker;
}

export function createInlineWorker(): SpikeWorker {
  const capabilities = detectTransportCapabilities();
  if (capabilities.runtime !== "browser") {
    throw new Error("Inline workers require a browser Worker implementation");
  }
  const url = URL.createObjectURL(
    new Blob([inlineWorkerSource], { type: "text/javascript" }),
  );
  const worker = new Worker(url, {
    type: "module",
    name: "inline-worker-performance-spike",
  });
  URL.revokeObjectURL(url);
  return worker as SpikeWorker;
}
