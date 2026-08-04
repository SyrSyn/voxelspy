import { describe, expect, it } from "vitest";
import { detectTransportCapabilities } from "../src/capabilities.js";

describe("transport capability detection", () => {
  it("reports the current Node environment without treating isolation as a browser header", () => {
    expect(detectTransportCapabilities()).toMatchObject({
      runtime: "node",
      transferableArrayBuffer: true,
      crossOriginIsolated: null,
    });
  });

  it("falls back to transfer when a browser is not cross-origin isolated", () => {
    const fakeBrowser = {
      window: {},
      Worker: function Worker() {},
      ArrayBuffer,
      SharedArrayBuffer,
      crossOriginIsolated: false,
    } as unknown as typeof globalThis;
    expect(detectTransportCapabilities(fakeBrowser)).toMatchObject({
      runtime: "browser",
      sharedArrayBufferAvailable: true,
      sharedMemoryUsable: false,
      preferredTransport: "transfer",
    });
  });

  it("selects shared memory only for an isolated browser with support", () => {
    const fakeBrowser = {
      window: {},
      Worker: function Worker() {},
      ArrayBuffer,
      SharedArrayBuffer,
      crossOriginIsolated: true,
    } as unknown as typeof globalThis;
    expect(detectTransportCapabilities(fakeBrowser)).toMatchObject({
      sharedMemoryUsable: true,
      preferredTransport: "shared",
    });
  });
});
