import {
  hostedLoadSchema,
  type HostedLoad,
  type HostedTool,
} from "@voxelspy/contracts/hosted";
import { inferFormat } from "./formats";
import { openSession } from "./session";
export function isHostedParentMessage(
  event: Pick<MessageEvent, "source" | "origin">,
  parent: Window,
  origin: string,
) {
  return event.source === parent && event.origin === origin;
}
export async function validateHostedLoad(
  input: unknown,
  tool: HostedTool,
): Promise<HostedLoad> {
  const request = hostedLoadSchema.parse(input);
  const count = tool === "compare" || tool === "clearance-fit" ? 2 : 1;
  if (
    request.sources.length !== count ||
    (request.session && tool !== "compare")
  )
    throw new Error("This tool requires its exact revision source count.");
  for (const source of request.sources) {
    const format = inferFormat(source.name);
    if (!format || format !== source.provenance.formatId)
      throw new Error("Revision format disagrees with recorded provenance.");
    const hash = await crypto.subtle.digest("SHA-256", source.bytes);
    const digest = [...new Uint8Array(hash)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== source.digest)
      throw new Error("Revision bytes do not match their recorded digest.");
    if (
      (format === "stl" || format === "obj") &&
      (source.provenance.sourceResolution.unit === "embedded" ||
        source.provenance.sourceResolution.axis === "embedded")
    )
      throw new Error("This source format does not embed its frame.");
  }
  if (request.session) {
    const opened = await openSession(new Uint8Array(request.session));
    const models = opened.exchange.bundle.report.models;
    for (const [index, role] of ["baseline", "candidate"].entries()) {
      const source = request.sources[index]!,
        model = models.find((model) => model.role === role);
      if (
        !model ||
        model.sourceDigest.value !== source.digest ||
        model.sourceName !== source.name ||
        JSON.stringify(model.normalizationProvenance) !==
          JSON.stringify(source.provenance)
      )
        throw new Error("The session is bound to different revision sources.");
    }
  }
  return request;
}
