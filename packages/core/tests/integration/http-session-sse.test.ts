import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeSession,
  collectSseEvents,
  collectSseEventsCount,
  createTestHarness,
  initializeSession,
  openSessionStream,
  type TestServer,
} from "@internal/test-utils";
import { InMemorySessionStore, McpServer } from "../../src/index.js";

describe("Session SSE Happy Path", () => {
  let testServer: TestServer;
  let mcpServer: McpServer;
  let sessionStore: InMemorySessionStore;
  const fixedSessionId = "test-session-123";

  beforeEach(async () => {
    sessionStore = new InMemorySessionStore({ maxEventBufferSize: 1024 });
    mcpServer = new McpServer({ name: "test-server", version: "1.0.0" });

    // Add tool that emits progress updates when progressToken is present
    mcpServer.tool("longTask", {
      description: "emits progress 3 times",
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      },
      handler: async (args: { count: number }, ctx) => {
        for (let i = 1; i <= args.count; i++) {
          await ctx.progress?.({
            progress: i,
            total: args.count,
            message: `step ${i}`,
          });
        }
        return { content: [{ type: "text", text: `done ${args.count}` }] };
      },
    });

    testServer = await createTestHarness(mcpServer, {
      sessionId: fixedSessionId,
      sessionStore,
    });
  });

  afterEach(async () => {
    await testServer.stop();
  });

  it("initialize → open session GET SSE stream → receive progress notifications", async () => {
    // Initialize session
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });
    expect(sessionId).toBe(fixedSessionId);

    // Open session SSE stream
    const sseStream = await openSessionStream(testServer.url, sessionId);

    // Start collecting SSE events (expect 3 progress events + 1 connection event = 4 total)
    const ssePromise = collectSseEventsCount(sseStream, 4);

    // Trigger tool call with progress token
    const toolResponse = await fetch(testServer.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "42",
        method: "tools/call",
        params: {
          _meta: { progressToken: "abc123" },
          name: "longTask",
          arguments: { count: 3 },
        },
      }),
    });

    expect(toolResponse.ok).toBe(true);
    const toolResult = await toolResponse.json();
    expect(toolResult.error).toBeUndefined();
    expect(toolResult.result.content[0].text).toBe("done 3");

    // Wait for all SSE events with a longer timeout since we have background operations
    const events = await ssePromise;

    // Close the session after we've collected events
    await closeSession(testServer.url, sessionId);

    // Verify we received 4 events total (1 connection + 3 progress notifications)
    expect(events).toHaveLength(4);

    // First event should be connection event (no ID)
    expect(events[0].id).toBeUndefined();
    expect(events[0].data).toEqual({
      type: "connection",
      status: "established",
    });

    // Next 3 events should be progress notifications with IDs (1, 2, 3)
    for (let i = 1; i <= 3; i++) {
      const event = events[i];
      expect(event.id).toBe(String(i));
      expect(event.data).toEqual({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: "abc123",
          progress: i,
          total: 3,
          message: `step ${i}`,
        },
      });
    }
  });

  it("verifies SSE event replay with Last-Event-ID header", async () => {
    // Initialize session
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    // Generate some progress events first
    await fetch(testServer.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "setup",
        method: "tools/call",
        params: {
          _meta: { progressToken: "replay-test" },
          name: "longTask",
          arguments: { count: 3 },
        },
      }),
    });

    // Open session stream asking for replay from event 2 onwards
    const sseStream = await openSessionStream(testServer.url, sessionId, "1");

    // For replay, events should be delivered immediately, so collect with a short timeout
    const events = await collectSseEvents(sseStream, 1000);

    // Close session after collecting events
    await closeSession(testServer.url, sessionId);

    // Should receive events 2 and 3 (after event 1), no connection event for replay
    expect(events).toHaveLength(2);

    expect(events[0].id).toBe("2");
    expect(events[0].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "replay-test",
        progress: 2,
        total: 3,
        message: "step 2",
      },
    });

    expect(events[1].id).toBe("3");
    expect(events[1].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "replay-test",
        progress: 3,
        total: 3,
        message: "step 3",
      },
    });
  });

  it("handles multiple progress events from different tool calls", async () => {
    // Initialize session
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    // Open session SSE stream
    const sseStream = await openSessionStream(testServer.url, sessionId);
    const ssePromise = collectSseEvents(sseStream);

    // First tool call with 2 steps
    await fetch(testServer.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call1",
        method: "tools/call",
        params: {
          _meta: { progressToken: "token1" },
          name: "longTask",
          arguments: { count: 2 },
        },
      }),
    });

    // Second tool call with 2 steps
    await fetch(testServer.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call2",
        method: "tools/call",
        params: {
          _meta: { progressToken: "token2" },
          name: "longTask",
          arguments: { count: 2 },
        },
      }),
    });

    // Close session to finish event collection
    await closeSession(testServer.url, sessionId);

    const events = await ssePromise;

    // Should receive 5 events total (1 connection + 4 progress)
    expect(events).toHaveLength(5);

    // First event should be connection event (no ID)
    expect(events[0].id).toBeUndefined();
    expect(events[0].data).toEqual({
      type: "connection",
      status: "established",
    });

    // Verify monotonic event IDs for progress events (1, 2, 3, 4)
    for (let i = 1; i <= 4; i++) {
      expect(events[i].id).toBe(String(i));
    }

    // Verify first two progress events are from token1
    expect(events[1].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "token1",
        progress: 1,
        total: 2,
        message: "step 1",
      },
    });

    expect(events[2].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "token1",
        progress: 2,
        total: 2,
        message: "step 2",
      },
    });

    // Verify next two progress events are from token2
    expect(events[3].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "token2",
        progress: 1,
        total: 2,
        message: "step 1",
      },
    });

    expect(events[4].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "token2",
        progress: 2,
        total: 2,
        message: "step 2",
      },
    });
  });

  it("no progress notifications when progressToken is missing", async () => {
    // Initialize session
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    // Open session SSE stream
    const sseStream = await openSessionStream(testServer.url, sessionId);
    const ssePromise = collectSseEvents(sseStream);

    // Tool call without progress token
    await fetch(testServer.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "no-progress",
        method: "tools/call",
        params: {
          name: "longTask",
          arguments: { count: 2 },
        },
      }),
    });

    // Close session to finish event collection
    await closeSession(testServer.url, sessionId);

    const events = await ssePromise;

    // Should receive only the connection event
    expect(events).toHaveLength(1);

    // First event should be connection event (no ID)
    expect(events[0].id).toBeUndefined();
    expect(events[0].data).toEqual({
      type: "connection",
      status: "established",
    });
  });
});
