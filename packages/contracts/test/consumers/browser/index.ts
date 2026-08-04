import {
  analysisRequestSchema,
  getWorkerMessageTransferList,
  normalizedModelSchema,
  reportSchema,
  workerWireMessageSchema,
  type WorkerWireMessage,
} from "@voxelspy/contracts";

export function validateBrowserInput(value: unknown): boolean {
  return (
    analysisRequestSchema.safeParse(value).success ||
    normalizedModelSchema.safeParse(value).success ||
    reportSchema.safeParse(value).success
  );
}

export function browserWorkerTransfers(
  value: unknown,
): readonly ArrayBuffer[] | undefined {
  const parsed = workerWireMessageSchema.safeParse(value);
  return parsed.success
    ? getWorkerMessageTransferList(parsed.data as WorkerWireMessage)
    : undefined;
}
