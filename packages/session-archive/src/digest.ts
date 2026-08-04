import type { Sha256Digest } from "@voxelspy/contracts/primitives";

export async function digestSessionResource(
  bytes: Uint8Array,
): Promise<Sha256Digest> {
  const input = bytes.slice().buffer;
  const result = await globalThis.crypto.subtle.digest("SHA-256", input);
  const value = [...new Uint8Array(result)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
  return { algorithm: "sha256", value } as Sha256Digest;
}
