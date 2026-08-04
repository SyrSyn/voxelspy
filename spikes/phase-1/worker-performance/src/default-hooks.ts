import type { InitializationHooks } from "./runtime.js";

export const defaultInitializationHooks: InitializationHooks = {
  async initializeGeometry({ scratchBytes }) {
    if (scratchBytes > 256 * 1024 * 1024) {
      throw new Error("Requested scratch allocation exceeds the spike limit");
    }
    return { provider: "typed-array-baseline" };
  },
  async initializeCad({ wasmUrl }) {
    const response = await fetch(wasmUrl);
    if (!response.ok)
      throw new Error(`CAD module request failed with ${response.status}`);
    const bytes = await response.arrayBuffer();
    await WebAssembly.instantiate(bytes, {});
    return { provider: "optional-wasm-module" };
  },
};
