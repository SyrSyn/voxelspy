import {
  SPIKE_PROTOCOL_VERSION,
  isWorkerRequest,
  type InitializationRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";

export interface InitializationHooks {
  initializeGeometry(
    config: InitializationRequest["geometry"],
  ): Promise<{ provider: string }>;
  initializeCad?(
    config: NonNullable<InitializationRequest["cad"]>,
  ): Promise<{ provider: string }>;
}

export interface RuntimePort {
  post(message: WorkerResponse, transfer?: Transferable[]): void;
  close(): void;
  yieldToHost(): Promise<void>;
}

interface ActiveJob {
  cancelled: boolean;
}

export function createWorkerRuntime(
  port: RuntimePort,
  hooks: InitializationHooks,
) {
  const jobs = new Map<string, ActiveJob>();
  let initialized = false;
  let disposed = false;

  port.post({ type: "ready", protocolVersion: SPIKE_PROTOCOL_VERSION });

  async function receive(value: unknown): Promise<void> {
    if (disposed) return;
    if (!isWorkerRequest(value)) {
      port.post({
        type: "error",
        code: "INVALID_REQUEST",
        message: "Invalid worker request",
      });
      return;
    }

    switch (value.type) {
      case "initialize":
        await initialize(value);
        break;
      case "run":
        if (!initialized) {
          port.post({
            type: "error",
            requestId: value.requestId,
            code: "NOT_INITIALIZED",
            message: "Initialize the worker before starting work",
          });
          return;
        }
        if (jobs.has(value.requestId)) {
          port.post({
            type: "error",
            requestId: value.requestId,
            code: "INVALID_REQUEST",
            message: "The request identifier is already active",
          });
          return;
        }
        void run(value);
        break;
      case "cancel": {
        const job = jobs.get(value.targetRequestId);
        if (job) job.cancelled = true;
        break;
      }
      case "dispose":
        disposed = true;
        for (const job of jobs.values()) job.cancelled = true;
        port.close();
        break;
    }
  }

  async function initialize(request: InitializationRequest): Promise<void> {
    const warnings: string[] = [];
    try {
      const geometry = await hooks.initializeGeometry(request.geometry);
      let cadProvider: string | undefined;
      if (request.cad) {
        if (hooks.initializeCad) {
          try {
            cadProvider = (await hooks.initializeCad(request.cad)).provider;
          } catch (error) {
            if (request.cad.required) throw error;
            warnings.push(
              `Optional CAD initialization failed: ${errorMessage(error)}`,
            );
          }
        } else if (request.cad.required) {
          throw new Error("No CAD initializer was registered");
        } else {
          warnings.push("Optional CAD initializer is unavailable");
        }
      }
      initialized = true;
      port.post({
        type: "initialized",
        requestId: request.requestId,
        geometryProvider: geometry.provider,
        ...(cadProvider === undefined ? {} : { cadProvider }),
        warnings,
      });
    } catch (error) {
      port.post({
        type: "error",
        requestId: request.requestId,
        code: "INITIALIZATION_FAILED",
        message: errorMessage(error),
      });
    }
  }

  async function run(
    request: Extract<WorkerRequest, { type: "run" }>,
  ): Promise<void> {
    const job: ActiveJob = { cancelled: false };
    jobs.set(request.requestId, job);
    try {
      const output = new Float64Array(request.values.length);
      let checksum = 0;
      for (
        let start = 0;
        start < request.values.length;
        start += request.chunkSize
      ) {
        const end = Math.min(start + request.chunkSize, request.values.length);
        for (let index = start; index < end; index += 1) {
          const result = (request.values[index] ?? 0) * request.multiplier;
          output[index] = result;
          checksum += result;
        }
        port.post({
          type: "progress",
          requestId: request.requestId,
          completed: end,
          total: request.values.length,
        });
        await port.yieldToHost();
        if (job.cancelled) {
          port.post({ type: "cancelled", requestId: request.requestId });
          return;
        }
      }
      port.post(
        {
          type: "result",
          requestId: request.requestId,
          values: output,
          checksum,
        },
        [output.buffer],
      );
    } catch (error) {
      port.post({
        type: "error",
        requestId: request.requestId,
        code: "RUN_FAILED",
        message: errorMessage(error),
      });
    } finally {
      jobs.delete(request.requestId);
    }
  }

  return { receive };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker failure";
}
