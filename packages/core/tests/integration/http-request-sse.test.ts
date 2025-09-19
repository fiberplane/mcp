import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeSession,
  collectSseEvents,
  createTestHarness,
  initializeSession,
  openRequestStream,
  type TestServer,
} from "@internal/test-utils";
import { InMemorySessionStore, McpServer } from "../../src/index.js";

describe("Per-request SSE", () => {
  let testServer: TestServer;
  let mcpServer: McpServer;
  let sessionStore: InMemorySessionStore;
  const fixedSessionId = "test-session-456";

  beforeEach(async () => {
    sessionStore = new InMemorySessionStore({ maxEventBufferSize: 1024 });
    mcpServer = new McpServer({ name: "test-server", version: "1.0.0" });

    // Add tool that emits progress updates when progressToken is present
    mcpServer.tool("longTask", {
      description: "emits progress updates",
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

  it("POST with Accept: text/event-stream receives progress + result on same stream", async () => {
    // Initialize session
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    // Open request-scoped SSE stream
    const requestId = "request-123";
    const sseStream = await openRequestStream(
      testServer.url,
      "tools/call",
      {
        _meta: { progressToken: "req-token" },
        name: "longTask",
        arguments: { count: 2 },
      },
      requestId,
      sessionId,
    );

    // Collect all events
    const events = await collectSseEvents(sseStream);

    // Should receive 2 progress events + 1 result event = 3 total
    expect(events).toHaveLength(3);

    // First two events should be progress notifications with id: "0"
    expect(events[0].id).toBeUndefined(); // Per-request streams don't persist, so no event IDs
    expect(events[0].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "req-token",
        progress: 1,
        total: 2,
        message: "step 1",
      },
    });

    expect(events[1].id).toBeUndefined();
    expect(events[1].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "req-token",
        progress: 2,
        total: 2,
        message: "step 2",
      },
    });

    // Last event should be the JSON-RPC result
    expect(events[2].id).toBeUndefined();
    expect(events[2].data).toEqual({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        content: [{ type: "text", text: "done 2" }],
      },
    });

    await closeSession(testServer.url, sessionId);
  });

  it("concurrent request streams are isolated from each other", async () => {
    // Initialize session
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    // Start two concurrent request streams
    const stream1Promise = openRequestStream(
      testServer.url,
      "tools/call",
      {
        _meta: { progressToken: "token1" },
        name: "longTask",
        arguments: { count: 2 },
      },
      "req1",
      sessionId,
    ).then(collectSseEvents);

    const stream2Promise = openRequestStream(
      testServer.url,
      "tools/call",
      {
        _meta: { progressToken: "token2" },
        name: "longTask",
        arguments: { count: 3 },
      },
      "req2",
      sessionId,
    ).then(collectSseEvents);

    // Wait for both streams to complete
    const [events1, events2] = await Promise.all([
      stream1Promise,
      stream2Promise,
    ]);

    // Stream 1 should have 2 progress + 1 result = 3 events
    expect(events1).toHaveLength(3);
    expect(events1[0].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "token1",
        progress: 1,
        total: 2,
        message: "step 1",
      },
    });
    expect(events1[2].data).toEqual({
      jsonrpc: "2.0",
      id: "req1",
      result: {
        content: [{ type: "text", text: "done 2" }],
      },
    });

    // Stream 2 should have 3 progress + 1 result = 4 events
    expect(events2).toHaveLength(4);
    expect(events2[0].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "token2",
        progress: 1,
        total: 3,
        message: "step 1",
      },
    });
    expect(events2[3].data).toEqual({
      jsonrpc: "2.0",
      id: "req2",
      result: {
        content: [{ type: "text", text: "done 3" }],
      },
    });

    await closeSession(testServer.url, sessionId);
  });

  it("request stream without session works in stateless mode", async () => {
    // Create a stateless transport (no session generator)
    const statelessMcpServer = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });

    statelessMcpServer.tool("quickTask", {
      description: "quick task with progress",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      handler: async (args: { message: string }, ctx) => {
        await ctx.progress?.({
          progress: 1,
          total: 1,
          message: "processing",
        });
        return {
          content: [{ type: "text", text: `processed: ${args.message}` }],
        };
      },
    });

    const statelessServer = await createTestHarness(statelessMcpServer, {
      // No sessionId - creates stateless transport
    });

    try {
      // Open request stream without session
      const sseStream = await openRequestStream(
        statelessServer.url,
        "tools/call",
        {
          _meta: { progressToken: "stateless-token" },
          name: "quickTask",
          arguments: { message: "test" },
        },
        "stateless-req",
        // No sessionId
      );

      const events = await collectSseEvents(sseStream);

      // In stateless mode, we might only get the final result
      // (progress notifications may not be delivered without session routing)
      expect(events.length).toBeGreaterThanOrEqual(1);

      // The last event should always be the result
      const resultEvent = events[events.length - 1];
      expect(resultEvent.data).toEqual({
        jsonrpc: "2.0",
        id: "stateless-req",
        result: {
          content: [{ type: "text", text: "processed: test" }],
        },
      });

      // If we got progress events, validate the first one
      if (events.length > 1) {
        expect(events[0].data).toEqual({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: "stateless-token",
            progress: 1,
            total: 1,
            message: "processing",
          },
        });
      }
    } finally {
      await statelessServer.stop();
    }
  });

  it("ensures no replay on session stream for per-request events", async () => {
    // Initialize session
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    // Make a request via request stream (should not persist to session)
    const requestSseStream = await openRequestStream(
      testServer.url,
      "tools/call",
      {
        _meta: { progressToken: "ephemeral-token" },
        name: "longTask",
        arguments: { count: 1 },
      },
      "ephemeral-req",
      sessionId,
    );

    // Consume request stream
    const requestEvents = await collectSseEvents(requestSseStream);
    expect(requestEvents).toHaveLength(2); // 1 progress + 1 result

    // Now open a session stream - should not replay the request events
    const response = await fetch(testServer.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId,
      },
    });

    expect(response.ok).toBe(true);
    if (!response.body) {
      throw new Error("No session stream body");
    }

    // Read from session stream with a short timeout (should be empty of replayed data events)
    const sessionEvents = await collectSseEvents(response.body, 1000);
    // Ignore optional connection event
    const dataEvents = sessionEvents.filter(
      // biome-ignore lint/suspicious/noExplicitAny: tests
      (e) => !(e.data && (e as any)?.data?.type === "connection"),
    );

    // Close session after reading
    await closeSession(testServer.url, sessionId);

    // Should be empty - request stream events are ephemeral
    expect(dataEvents).toHaveLength(0);
  });
});
