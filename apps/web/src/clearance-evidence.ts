import type { ClearanceOutcome } from "./clearance-worker-client";
import type { Mat4 } from "@voxelspy/contracts";
import type { useHostedArtifact } from "./hosted";
export function downloadClearanceEvidence(
  outcome: ClearanceOutcome,
  first: { name: string; size: number; modelToComparison: Mat4 },
  second: { name: string; size: number; modelToComparison: Mat4 },
  desiredClearanceMillimetres: number,
  stage: ReturnType<typeof useHostedArtifact>,
) {
  const provenances = [
    outcome.first.model.provenance,
    outcome.second.model.provenance,
  ];
  const report = {
    schemaVersion: 1,
    kind: "clearance-fit",
    sources: [
      {
        name: first.name,
        sizeBytes: first.size,
        provenance: provenances[0],
        modelToComparison: first.modelToComparison,
      },
      {
        name: second.name,
        sizeBytes: second.size,
        provenance: provenances[1],
        modelToComparison: second.modelToComparison,
      },
    ],
    evidence: { desiredClearanceMillimetres, result: outcome.result },
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify(report, null, 2) + "\n",
  );
  const name = "voxelspy.clearance-fit.json";
  stage({
    kind: "evidence-json",
    name,
    mime: "application/json",
    bytes,
    provenances,
  });
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
