/**
 * SSE stream parsing utilities for tests
 */

export interface SseEvent {
  id?: string;
  data: unknown;
}

/**
 * Parse SSE streams with event IDs and data
 */
export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  signal?: {
    aborted: boolean;
    addEventListener: (type: "abort", listener: () => void) => void;
    removeEventListener: (type: "abort", listener: () => void) => void;
  },
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => {
    try {
      reader.cancel();
    } catch {}
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort);
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = chunk.split("\n");
        const idLine = lines.find((l) => l.startsWith("id:"));
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (dataLine) {
          const json = JSON.parse(dataLine.slice(5).trim());
          if (idLine) {
            yield { id: idLine.slice(3).trim(), data: json };
          } else {
            yield { data: json };
          }
        }
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    reader.releaseLock();
  }
}

/**
 * Collect all SSE events from a stream into an array
 */
export async function collectSseEvents(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number = 5000,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: tests
  const controller: any = new (globalThis as any).AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for await (const event of readSse(stream, controller.signal)) {
      events.push(event);
    }
  } catch (error) {
    if (controller.signal?.aborted) {
      // Timeout occurred - return events collected so far
      return events;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return events;
}

/**
 * Collect a specific number of SSE events from a stream
 */
export async function collectSseEventsCount(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs: number = 5000,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: tests
  const controller: any = new (globalThis as any).AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for await (const event of readSse(stream, controller.signal)) {
      events.push(event);
      if (events.length >= count) {
        break;
      }
    }
  } catch (error) {
    if (controller.signal?.aborted) {
      // Timeout occurred - return events collected so far
      return events;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return events;
}

/**
 * Read SSE events until a condition is met
 */
export async function readSseUntil(
  stream: ReadableStream<Uint8Array>,
  condition: (event: SseEvent) => boolean,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSse(stream)) {
    events.push(event);
    if (condition(event)) {
      break;
    }
  }
  return events;
}
