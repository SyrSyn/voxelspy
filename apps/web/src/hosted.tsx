import { createContext, useContext, useState, type ReactNode } from "react";
import {
  hostedArtifactSchema,
  type HostedArtifact,
  type HostedLoad,
  type HostedTool,
} from "@voxelspy/contracts/hosted";
import type { GeometryProvenance } from "@voxelspy/contracts";
import { recordHostedSource } from "./hosted-source";
export interface HostedWorkspace {
  request: HostedLoad;
  files: File[];
  tool: HostedTool;
  current: () => boolean;
  notify?: (message: string) => void;
}
const HostContext = createContext<HostedWorkspace | undefined>(undefined);
export function HostedProvider({
  workspace,
  children,
}: {
  workspace: HostedWorkspace;
  children: ReactNode;
}) {
  const [notice, setNotice] = useState<string>();
  return (
    <HostContext.Provider value={{ ...workspace, notify: setNotice }}>
      {notice && <p role="status">{notice}</p>}
      {children}
    </HostContext.Provider>
  );
}
export function createHostedWorkspace(
  request: HostedLoad,
  tool: HostedTool,
  current: () => boolean,
): HostedWorkspace {
  const files = request.sources.map((source) => {
    const file = new File([source.bytes], source.name);
    recordHostedSource(file, source.provenance);
    return file;
  });
  return { request, files, tool, current };
}
export function useHostedSource(index = 0) {
  const host = useContext(HostContext),
    file = host?.files[index],
    provenance = host?.request.sources[index]?.provenance;
  return file && provenance
    ? {
        file,
        unit: provenance.sourceUnit,
        axis: provenance.sourceAxis,
        frameSource: "recorded" as const,
      }
    : undefined;
}
export function useHostedSession() {
  return useContext(HostContext)?.request.session;
}
export function useHostedArtifact() {
  const host = useContext(HostContext);
  return (input: {
    kind: HostedArtifact["kind"];
    name: string;
    mime: string;
    bytes: Uint8Array;
    provenances: readonly GeometryProvenance[];
    metadata?: HostedArtifact["metadata"];
  }) => {
    if (!host || !host.current()) return;
    const sources = host.request.sources;
    if (
      input.provenances.length !== sources.length ||
      input.provenances.some(
        (p, index) =>
          p.sourceDigest?.value !== sources[index]?.digest ||
          JSON.stringify(p) !== JSON.stringify(sources[index]?.provenance),
      )
    ) {
      host.notify?.(
        "Downloaded locally only: this result does not match the host revision sources and recorded frame.",
      );
      return;
    }
    try {
      const payload =
        input.kind === "evidence-json"
          ? new TextEncoder().encode(
              JSON.stringify({
                schemaVersion: 1,
                kind: "tool-evidence",
                tool: host.tool,
                sources: sources.map((source) => ({
                  name: source.name,
                  digest: source.digest,
                  provenance: source.provenance,
                })),
                evidence: JSON.parse(new TextDecoder().decode(input.bytes)),
              }),
            )
          : input.bytes;
      const bytes = Uint8Array.from(payload).buffer;
      const message = hostedArtifactSchema.parse({
        type: "voxelspy:artifact",
        version: 1,
        requestId: host.request.requestId,
        artifactId: crypto.randomUUID(),
        tool: host.tool,
        kind: input.kind,
        name: input.name,
        mime: input.mime,
        bytes,
        revisionIds: sources.map((source) => source.revisionId),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      window.parent.postMessage(message, window.location.origin, [bytes]);
      host.notify?.(
        "Artifact staged in the host. Choose Save there to retain it.",
      );
    } catch {
      host.notify?.(
        "Downloaded locally only: the artifact could not be staged within the hosted safety limits.",
      );
    }
  };
}
