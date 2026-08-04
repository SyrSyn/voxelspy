import { detectTransportCapabilities } from "@voxelspy/worker-performance-spike";

const capabilities = detectTransportCapabilities();
if (capabilities.runtime !== "node" || !capabilities.transferableArrayBuffer) {
  throw new Error("Unexpected server-runtime capability result");
}

console.log(
  JSON.stringify({
    consumer: "bounded-server-bundle",
    importedBrowserPackageWithoutStartingWorker: true,
    capabilities,
  }),
);
