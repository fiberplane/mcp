export interface ClientRequestAdapter {
  /**
   * Create and track a pending client request. Returns a promise that
   * resolves when a matching JSON-RPC response is received (or rejects on timeout).
   */
  createPending(
    sessionId: string | undefined,
    requestId: string | number,
    options?: { timeout_ms?: number },
  ): { promise: Promise<unknown> };

  /**
   * Resolve a pending request by providing the JSON-RPC response payload.
   * Returns true when a pending entry was found and resolved.
   */
  resolvePending(
    sessionId: string | undefined,
    requestId: string | number,
    response: unknown,
  ): boolean;

  /**
   * Reject a pending request (e.g., timeout/cancel). Returns true when a
   * pending entry was found and rejected.
   */
  rejectPending(
    sessionId: string | undefined,
    requestId: string | number,
    reason: unknown,
  ): boolean;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function makeKey(
  sessionId: string | undefined,
  requestId: string | number,
): string {
  return `${sessionId ?? ""}:${String(requestId)}`;
}

export class InMemoryClientRequestAdapter implements ClientRequestAdapter {
  private pending = new Map<string, PendingEntry>();

  createPending(
    sessionId: string | undefined,
    requestId: string | number,
    options?: { timeout_ms?: number },
  ): { promise: Promise<unknown> } {
    const key = makeKey(sessionId, requestId);

    // Check if key already exists and clean up existing entry
    const existingEntry = this.pending.get(key);
    if (existingEntry) {
      if (existingEntry.timer) {
        clearTimeout(existingEntry.timer);
      }
      existingEntry.reject(
        new Error("Request replaced by new request with same key"),
      );
      this.pending.delete(key);
    }

    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: PendingEntry = { resolve, reject };

    if (options?.timeout_ms && options.timeout_ms > 0) {
      entry.timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("Timeout"));
      }, options.timeout_ms);
    }

    this.pending.set(key, entry);
    return { promise };
  }

  resolvePending(
    sessionId: string | undefined,
    requestId: string | number,
    response: unknown,
  ): boolean {
    const key = makeKey(sessionId, requestId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.resolve(response);
    return true;
  }

  rejectPending(
    sessionId: string | undefined,
    requestId: string | number,
    reason: unknown,
  ): boolean {
    const key = makeKey(sessionId, requestId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.reject(reason);
    return true;
  }
}
