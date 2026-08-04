import { parentPort } from "node:worker_threads";
import { defaultInitializationHooks } from "./default-hooks.js";
import { createWorkerRuntime } from "./runtime.js";

if (!parentPort)
  throw new Error("This entry point must run in a worker thread");

const port = parentPort;
const runtime = createWorkerRuntime(
  {
    post(message, transfer = []) {
      port.postMessage(message, transfer as ArrayBuffer[]);
    },
    close() {
      port.close();
    },
    async yieldToHost() {
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  },
  defaultInitializationHooks,
);

port.on("message", (message: unknown) => {
  void runtime.receive(message);
});
