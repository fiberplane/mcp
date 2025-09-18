import type { EventId } from "./session-store.js";

export interface StreamWriter {
  write(message: unknown, eventId?: EventId): void;
  end(): void;
}

export function createSSEStream(options?: { onClose?: () => void }): {
  stream: ReadableStream<Uint8Array>;
  writer: StreamWriter;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const end = (): void => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch (_error) {}
    try {
      options?.onClose?.();
    } catch (_e) {}
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      end();
    },
  });

  const writer: StreamWriter = {
    write(message: unknown, eventId?: EventId): void {
      if (closed) return;
      try {
        let sse = "";
        if (eventId) sse += `id: ${eventId}\n`;
        sse += `data: ${JSON.stringify(message)}\n\n`;
        controller.enqueue(encoder.encode(sse));
      } catch (_error) {
        end();
      }
    },
    end,
  };

  return { stream, writer };
}
