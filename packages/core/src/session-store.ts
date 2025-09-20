export type EventId = string;
export type SessionId = string;

export interface SessionMeta {
  protocolVersion: string;
  clientInfo?: unknown;
}

export interface StreamData {
  nextEventId: number;
  eventBuffer: EventData[];
}

export interface SessionData {
  meta: SessionMeta;
  streams: Map<string, StreamData>;
}

export interface EventData {
  id: EventId;
  message: unknown;
}

function formatEventId(sequenceNumber: number, streamId: string): string {
  return `${sequenceNumber}#${streamId}`;
}

function parseEventId(eventId: string): {
  sequenceNumber: number;
  streamId: string;
} {
  const hashIndex = eventId.lastIndexOf("#");
  if (hashIndex === -1) {
    throw new Error(`Invalid event ID format: ${eventId}`);
  }
  const seqStr = eventId.slice(0, hashIndex);
  const streamId = eventId.slice(hashIndex + 1);
  const n = parseInt(seqStr, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid sequence number in event ID: ${eventId}`);
  }
  return {
    sequenceNumber: n,
    streamId,
  };
}

export interface SessionAdapter {
  generateSessionId(): string;
  create(id: SessionId, meta: SessionMeta): Promise<SessionData> | SessionData;
  has(id: SessionId): Promise<boolean> | boolean;
  get(
    id: SessionId,
  ): Promise<SessionData | undefined> | SessionData | undefined;
  appendEvent(
    id: SessionId,
    streamId: string,
    message: unknown,
  ): Promise<EventId | undefined> | EventId | undefined;
  replay(
    id: SessionId,
    lastEventId: EventId,
    write: (eventId: EventId, message: unknown) => Promise<void> | void,
  ): Promise<void> | void;
  delete(id: SessionId): Promise<void> | void;
}

export class InMemorySessionAdapter implements SessionAdapter {
  #sessions = new Map<SessionId, SessionData>();
  maxEventBufferSize: number;
  constructor({ maxEventBufferSize }: { maxEventBufferSize: number }) {
    this.maxEventBufferSize = maxEventBufferSize;
  }

  // TODO - make this configurable
  generateSessionId(): string {
    return crypto.randomUUID();
  }

  create(id: SessionId, meta: SessionMeta) {
    const session: SessionData = {
      meta,
      streams: new Map(),
    };
    this.#sessions.set(id, session);
    return session;
  }

  has(id: SessionId): boolean {
    return this.#sessions.has(id);
  }

  get(id: SessionId) {
    return this.#sessions.get(id);
  }

  delete(id: SessionId): void {
    this.#sessions.delete(id);
  }

  appendEvent(
    id: SessionId,
    streamId: string,
    message: unknown,
  ): Promise<EventId | undefined> | EventId | undefined {
    const session = this.get(id);

    if (!session) {
      return;
    }

    // Get or create stream data
    let streamData = session.streams.get(streamId);
    if (!streamData) {
      streamData = {
        nextEventId: 1,
        eventBuffer: [],
      };
      session.streams.set(streamId, streamData);
    }

    const eventId = formatEventId(streamData.nextEventId++, streamId);

    // Add to buffer with ring buffer behavior
    streamData.eventBuffer.push({ id: eventId, message });

    // Trim buffer if it exceeds max size
    if (streamData.eventBuffer.length > this.maxEventBufferSize) {
      streamData.eventBuffer = streamData.eventBuffer.slice(
        -this.maxEventBufferSize,
      );
    }

    return eventId;
  }

  async replay(
    id: SessionId,
    lastEventId: EventId,
    write: (eventId: EventId, message: unknown) => Promise<void> | void,
  ) {
    const session = this.#sessions.get(id);
    if (!session) {
      return;
    }

    const { sequenceNumber: lastSeq, streamId: targetStreamId } =
      parseEventId(lastEventId);

    // Get the target stream data
    const streamData = session.streams.get(targetStreamId);
    if (!streamData) {
      return;
    }

    // Replay events after lastEventId from the target stream only
    for (const event of streamData.eventBuffer) {
      const { sequenceNumber: eventSeq } = parseEventId(event.id);
      if (eventSeq > lastSeq) {
        await write(event.id, event.message);
      }
    }
  }
}
