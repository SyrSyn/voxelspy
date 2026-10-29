/* Isolated, replaceable LGPL runtime host. No model data leaves this worker's origin. */
importScripts("./occt-import-js.js");
// Replaced from third-party/step/manifest.json by the STEP asset plugin.
const expectedWasmSha256 = "__VOXELSPY_STEP_WASM_SHA256__";
class StepRuntimeRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
self.onmessage = async (event) => {
  try {
    const { bytes, parameters } = event.data;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > 32 * 1024 * 1024
    )
      throw new Error("STEP source exceeds the bounded runtime input domain.");
    if (typeof self.crypto?.subtle?.digest !== "function")
      throw new StepRuntimeRefusal(
        "secure-context-required",
        "STEP requires a secure context with Web Crypto SHA-256 support.",
      );
    const response = await fetch(
      new URL("./occt-import-js.wasm", self.location.href),
    );
    if (!response.ok) throw new Error("STEP runtime bytes unavailable.");
    const wasmBinary = new Uint8Array(await response.arrayBuffer());
    const digest = await self.crypto.subtle.digest("SHA-256", wasmBinary);
    const receivedSha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (receivedSha256 !== expectedWasmSha256)
      throw new StepRuntimeRefusal(
        "integrity-mismatch",
        "STEP runtime SHA-256 does not match its qualified binary.",
      );
    const runtime = await occtimportjs({
      wasmBinary,
      print: () => {},
      printErr: () => {},
    });
    const result = runtime.ReadStepFile(bytes, parameters);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      ...(error instanceof StepRuntimeRefusal ? { code: error.code } : {}),
      message:
        error instanceof Error
          ? error.message
          : "STEP runtime refused the source.",
    });
  }
};
