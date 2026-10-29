import { createEngineWorkerHandler } from "../src/worker.js";
import type {
  EngineWorkerRequest,
  EngineWorkerResponse,
} from "../src/protocol.js";

/**
 * A minimal in-process stand-in for the browser `Worker` this package's
 * `worker-client.ts` talks to, wired directly to the real, public
 * `createEngineWorkerHandler` -- so these tests exercise the actual wire
 * protocol end to end (main-thread client -> handler -> engine ->
 * response), without a real browser Worker thread. Structurally compatible
 * with the small slice of the `Worker` interface `worker-client.ts` uses
 * (`postMessage`, `addEventListener`/`removeEventListener` for `"message"`/
 * `"error"`, `terminate`), so it can be cast to `Worker` at each call site.
 *
 * Every delivery is deferred with `queueMicrotask` to mirror a real
 * worker's asynchronous message dispatch: a synchronous fake would let
 * `runOneShot`'s abort race behave differently than it does against a real
 * worker.
 */
export class FakeEngineWorker {
  private readonly messageListeners = new Set<
    (event: MessageEvent<EngineWorkerResponse>) => void
  >();
  private readonly errorListeners = new Set<() => void>();
  private readonly handler = createEngineWorkerHandler({
    postMessage: (message, transfer) => {
      this.responseTransfers.push(transfer ?? []);
      this.deliver(
        this.cloneMessages
          ? structuredClone(message, { transfer: transfer ?? [] })
          : message,
      );
    },
  });
  private readonly delayMs: number;
  private readonly cloneMessages: boolean;
  readonly responseTransfers: ArrayBuffer[][] = [];
  terminated = false;
  readonly posted: EngineWorkerRequest[] = [];
  readonly transfersPosted: Transferable[][] = [];

  constructor(options: { delayMs?: number; cloneMessages?: boolean } = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.cloneMessages = options.cloneMessages ?? false;
  }

  postMessage(
    message: EngineWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    this.posted.push(message);
    this.transfersPosted.push(transfer);
    if (this.terminated) return;
    const payload = this.cloneMessages
      ? structuredClone(message, { transfer })
      : message;
    const dispatch = () => {
      if (this.terminated) return;
      this.handler({ data: payload } as MessageEvent<EngineWorkerRequest>);
    };
    if (this.delayMs > 0) {
      setTimeout(dispatch, this.delayMs);
    } else {
      queueMicrotask(dispatch);
    }
  }

  private deliver(message: EngineWorkerResponse): void {
    if (this.terminated) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const listener of this.messageListeners) {
        listener({ data: message } as MessageEvent<EngineWorkerResponse>);
      }
    });
  }

  simulateMessage(message: unknown): void {
    this.deliver(message as EngineWorkerResponse);
  }
  get listenerCount(): number {
    return this.messageListeners.size + this.errorListeners.size;
  }

  /** Simulates the worker thread itself crashing, firing every registered `"error"` listener. */
  simulateError(): void {
    queueMicrotask(() => {
      for (const listener of this.errorListeners) listener();
    });
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: never) => void,
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: MessageEvent<EngineWorkerResponse>) => void,
      );
    } else {
      this.errorListeners.add(listener as () => void);
    }
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: never) => void,
  ): void {
    if (type === "message") {
      this.messageListeners.delete(
        listener as (event: MessageEvent<EngineWorkerResponse>) => void,
      );
    } else {
      this.errorListeners.delete(listener as () => void);
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}
