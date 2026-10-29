import { STEP_RUNTIME_METADATA, type StepRuntime } from "./step.js";

/** Explicit Node-only opt-in. WASM asset bytes must be provided by the caller; no implicit asset fetch. */
export async function createNodeStepRuntime(options: {
  readonly wasmBinary: Uint8Array;
}): Promise<StepRuntime> {
  const binary = Uint8Array.from(options.wasmBinary);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    binary.buffer,
  );
  const hex = [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== STEP_RUNTIME_METADATA.wasmSha256)
    throw new TypeError(
      "STEP WASM does not match the qualified occt-import-js 0.0.23 binary.",
    );
  // A variable specifier keeps this optional CJS runtime outside browser entry bundles.
  const specifier = "occt-import-js";
  const imported = (await import(specifier)) as { default: unknown };
  if (typeof imported.default !== "function")
    throw new TypeError("STEP runtime factory is unavailable.");
  const factory = imported.default as (options: {
    wasmBinary: Uint8Array;
    print: () => void;
    printErr: () => void;
  }) => Promise<{
    ReadStepFile(bytes: Uint8Array, parameters: unknown): unknown;
  }>;
  const module = await factory({
    wasmBinary: binary,
    print: () => {},
    printErr: () => {},
  });
  return {
    version: "0.0.23",
    occtVersion: "7.6.1",
    readStepFile: (bytes, parameters) => module.ReadStepFile(bytes, parameters),
  };
}
