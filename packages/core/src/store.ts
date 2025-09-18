export type EventId = string;
export type SessionId = string;

export interface SessionMeta {
  protocolVersion: string;
  clientInfo?: unknown;
}

export interface SessionData {
  meta: SessionMeta;
  eventBuffer: EventData[];
  nextEventId: number;
}

export interface EventData {
  id: EventId;
  message: unknown;
}

export interface SessionStore {
  create(id: SessionId, meta: SessionMeta): Promise<SessionData> | SessionData;
  has(id: SessionId): Promise<boolean> | boolean;
  get(
    id: SessionId,
  ): Promise<SessionData | undefined> | SessionData | undefined;
  appendEvent(
    id: SessionId,
    message: unknown,
  ): Promise<EventId | undefined> | EventId | undefined;
  replay(
    id: SessionId,
    lastEventId: EventId | undefined,
    write: (eventId: EventId, message: unknown) => Promise<void> | void,
  ): Promise<void> | void;
  delete(id: SessionId): Promise<void> | void;
}

export class InMemorySessionStore implements SessionStore {
  #sessions = new Map<SessionId, SessionData>();
  maxEventBufferSize: number;
  constructor({ maxEventBufferSize }: { maxEventBufferSize: number }) {
    this.maxEventBufferSize = maxEventBufferSize;
  }

  create(id: SessionId, meta: SessionMeta) {
    const session: SessionData = {
      meta,
      eventBuffer: [],
      nextEventId: 1,
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
    message: unknown,
  ): Promise<EventId | undefined> | EventId | undefined {
    const session = this.get(id);

    if (!session) {
      return;
    }

    const eventId = String(session.nextEventId++);

    // Add to buffer with ring buffer behavior
    session.eventBuffer.push({ id: eventId, message });

    // Trim buffer if it exceeds max size
    if (session.eventBuffer.length > this.maxEventBufferSize) {
      session.eventBuffer = session.eventBuffer.slice(-this.maxEventBufferSize);
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

    const lastEventIdNum = lastEventId ? parseInt(lastEventId, 10) : 0;

    // Find events after lastEventId and replay them in order
    for (const event of session.eventBuffer) {
      const eventIdNum = parseInt(event.id, 10);
      if (eventIdNum > lastEventIdNum) {
        await write(event.id, event.message);
      }
    }
  }
}
