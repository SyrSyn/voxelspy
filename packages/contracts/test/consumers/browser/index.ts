import { entityIdSchema, type EntityId } from "@voxelspy/contracts";
import {
  importerRegistrySchema,
  type AdapterReference,
} from "@voxelspy/contracts/adapter-evidence";
import { toleranceSchema, type Tolerance } from "@voxelspy/contracts/analysis";
import {
  warningSchema,
  type ContractWarning,
} from "@voxelspy/contracts/geometry";
import {
  importLimitsSchema,
  type ImportLimits,
} from "@voxelspy/contracts/import";
import { vec3Schema, type Vec3 } from "@voxelspy/contracts/primitives";
import {
  canonicalInstantSchema,
  type Report,
} from "@voxelspy/contracts/report";
import {
  sessionResourceVerificationSchema,
  type SessionManifest,
} from "@voxelspy/contracts/session";
import {
  getWorkerMessageTransferList,
  workerWireMessageSchema,
  type WorkerWireMessage,
} from "@voxelspy/contracts/worker";

const browserSchemas = [
  entityIdSchema,
  vec3Schema,
  warningSchema,
  importLimitsSchema,
  toleranceSchema,
  importerRegistrySchema,
  canonicalInstantSchema,
  sessionResourceVerificationSchema,
  workerWireMessageSchema,
] as const;

export type BrowserContractValue =
  | AdapterReference
  | ContractWarning
  | EntityId
  | ImportLimits
  | Report
  | SessionManifest
  | Tolerance
  | Vec3
  | WorkerWireMessage;

export function validateBrowserInput(value: unknown): boolean {
  return browserSchemas.some((schema) => schema.safeParse(value).success);
}

export function browserWorkerTransfers(
  value: unknown,
): readonly ArrayBuffer[] | undefined {
  const parsed = workerWireMessageSchema.safeParse(value);
  return parsed.success
    ? getWorkerMessageTransferList(parsed.data as WorkerWireMessage)
    : undefined;
}
