export interface TransportCapabilities {
  runtime: "browser" | "node" | "unknown";
  moduleWorkerSyntax: boolean;
  transferableArrayBuffer: boolean;
  sharedArrayBufferAvailable: boolean;
  crossOriginIsolated: boolean | null;
  sharedMemoryUsable: boolean;
  preferredTransport: "shared" | "transfer";
}

export function detectTransportCapabilities(
  scope: typeof globalThis = globalThis,
): TransportCapabilities {
  const isBrowser = "window" in scope || "WorkerGlobalScope" in scope;
  const isNode =
    "process" in scope &&
    typeof (
      scope as typeof globalThis & {
        process?: { versions?: { node?: string } };
      }
    ).process?.versions?.node === "string";
  const isolation = isBrowser
    ? Boolean(
        (scope as typeof globalThis & { crossOriginIsolated?: boolean })
          .crossOriginIsolated,
      )
    : null;
  const sharedAvailable = typeof scope.SharedArrayBuffer === "function";
  const sharedUsable =
    sharedAvailable && (isBrowser ? isolation === true : isNode);

  return {
    runtime: isBrowser ? "browser" : isNode ? "node" : "unknown",
    moduleWorkerSyntax: typeof scope.Worker === "function" || isNode,
    transferableArrayBuffer: typeof scope.ArrayBuffer === "function",
    sharedArrayBufferAvailable: sharedAvailable,
    crossOriginIsolated: isolation,
    sharedMemoryUsable: sharedUsable,
    preferredTransport: sharedUsable ? "shared" : "transfer",
  };
}
