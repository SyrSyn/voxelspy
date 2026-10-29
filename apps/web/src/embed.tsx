import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { hostedToolSchema, type HostedTool } from "@voxelspy/contracts/hosted";
import {
  createHostedWorkspace,
  HostedProvider,
  type HostedWorkspace,
} from "./hosted";
import { isHostedParentMessage, validateHostedLoad } from "./hosted-bridge";
import { ComparisonFlow } from "./ComparisonFlow";
import { InspectFlow } from "./InspectFlow";
import { ForensicsFlow } from "./ForensicsFlow";
import { MeasureSectionFlow } from "./MeasureSectionFlow";
import { ClearanceFlow } from "./ClearanceFlow";
import { PrintabilityFlow } from "./PrintabilityFlow";
import { ConvertFlow } from "./ConvertFlow";
import "./styles.css";
function Tool({ tool }: { tool: HostedTool }) {
  switch (tool) {
    case "compare":
      return <ComparisonFlow />;
    case "inspect":
      return <InspectFlow />;
    case "mesh-health":
      return <InspectFlow meshHealth />;
    case "file-forensics":
      return <ForensicsFlow />;
    case "measure-section":
      return <MeasureSectionFlow />;
    case "clearance-fit":
      return <ClearanceFlow />;
    case "printability":
      return <PrintabilityFlow />;
    case "convert":
      return <ConvertFlow />;
  }
}
function Embed() {
  const tool = hostedToolSchema.safeParse(
    new URLSearchParams(location.search).get("tool"),
  );
  const active = useRef<HostedWorkspace | undefined>(undefined),
    generation = useRef(0),
    seen = useRef(new Set<string>());
  const [epoch, setEpoch] = useState(0),
    [error, setError] = useState<string>();
  useEffect(() => {
    if (!tool.success || window.parent === window) {
      setError("Open this optional workbench from its same-origin host.");
      return;
    }
    const receive = (event: MessageEvent) => {
      if (
        !isHostedParentMessage(event, window.parent, window.location.origin) ||
        event.data?.type !== "voxelspy:load"
      )
        return;
      const run = ++generation.current;
      active.current = undefined;
      setEpoch(run * 2);
      setError(undefined);
      void validateHostedLoad(event.data, tool.data)
        .then((request) => {
          if (run !== generation.current) return;
          if (seen.current.has(request.requestId) || seen.current.size >= 100)
            throw new Error(
              "Load request identity was already used or this frame has reached its load limit.",
            );
          seen.current.add(request.requestId);
          active.current = createHostedWorkspace(
            request,
            tool.data,
            () => generation.current === run,
          );
          setEpoch(run * 2 + 1);
        })
        .catch(() => {
          if (run === generation.current)
            setError(
              "The host revision request could not be accepted safely. Reload the host selection and try again.",
            );
        });
    };
    window.addEventListener("message", receive);
    window.parent.postMessage(
      { type: "voxelspy:ready", version: 1 },
      window.location.origin,
    );
    return () => {
      ++generation.current;
      window.removeEventListener("message", receive);
    };
  }, []);
  const workspace = active.current;
  return (
    <MemoryRouter>
      <main>
        {error ? (
          <p role="alert">{error}</p>
        ) : workspace ? (
          <HostedProvider key={epoch} workspace={workspace}>
            <p role="status">
              Loaded exact revision{" "}
              {workspace.request.sources
                .map((source) => source.revisionId)
                .join(" / ")}
              . Exports also stage an artifact for deliberate saving in the
              host.
            </p>
            <Tool tool={workspace.tool} />
          </HostedProvider>
        ) : (
          <p role="status">Waiting for an exact revision from the host.</p>
        )}
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById("root")!).render(<Embed />);
