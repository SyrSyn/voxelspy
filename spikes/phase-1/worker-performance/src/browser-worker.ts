/// <reference lib="webworker" />

import { defaultInitializationHooks } from "./default-hooks.js";
import { createWorkerRuntime } from "./runtime.js";

const workerScope = self as DedicatedWorkerGlobalScope;
const runtime = createWorkerRuntime(
  {
    post(message, transfer = []) {
      workerScope.postMessage(message, transfer);
    },
    close() {
      workerScope.close();
    },
    async yieldToHost() {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  },
  defaultInitializationHooks,
);

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  void runtime.receive(event.data);
});
