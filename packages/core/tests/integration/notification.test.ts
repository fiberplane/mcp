import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeSession,
  collectSseEventsCount,
  createTestHarness,
  initializeSession,
  openSessionStream,
  type TestServer,
} from "@internal/test-utils";
import { McpServer } from "../../src/index.js";
import { StreamableHttpTransport } from "../../src/transport-http.js";

describe("JSON-RPC Notification Handling", () => {
  let server: McpServer;
  let transport: StreamableHttpTransport;
  let httpHandler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    transport = new StreamableHttpTransport();
    httpHandler = transport.bind(server);
  });

  it("should handle notifications/initialized with HTTP 204 response", async () => {
    const notificationRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    const response = await httpHandler(notificationRequest);

    expect(response.status).toBe(202);
    expect(response.body).toBeNull();

    const text = await response.text();
    expect(text).toBe("");
  });

  it("should handle regular requests with HTTP 200 and JSON response", async () => {
    const requestRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "ping",
      }),
    });

    const response = await httpHandler(requestRequest);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(json).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: {},
    });
  });

  it("should handle notifications/cancelled without response", async () => {
    const notificationRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {
          requestId: "test-request",
          reason: "User cancelled",
        },
      }),
    });

    const response = await httpHandler(notificationRequest);

    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });

  it("should handle unknown notification method gracefully", async () => {
    const notificationRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/unknown",
        params: {
          someData: "test",
        },
      }),
    });

    const response = await httpHandler(notificationRequest);

    // Should still return 204 even for unknown notification methods
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });

  it("should handle mixed request and notification in sequence", async () => {
    // First send a request
    const requestRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "ping",
      }),
    });

    const requestResponse = await httpHandler(requestRequest);
    expect(requestResponse.status).toBe(200);

    const requestJson = await requestResponse.json();
    expect(requestJson.id).toBe("1");
    expect(requestJson.result).toEqual({});

    // Then send a notification
    const notificationRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    const notificationResponse = await httpHandler(notificationRequest);
    expect(notificationResponse.status).toBe(202);
    expect(notificationResponse.body).toBeNull();
  });
});

describe("List changed notifications over SSE", () => {
  let testServer: TestServer;
  let mcpServer: McpServer;

  beforeEach(async () => {
    mcpServer = new McpServer({ name: "test-server", version: "1.0.0" });
    testServer = await createTestHarness(mcpServer, {
      // enable sessions
      sessionId: "sess-listchanged",
    });
  });

  afterEach(async () => {
    await testServer.stop();
  });

  it("emits notifications/tools/list_changed when a tool is registered after initialize", async () => {
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    const sse = await openSessionStream(testServer.url, sessionId);

    // Register a tool post-initialize; should emit a list_changed notification
    mcpServer.tool("dynTool", {
      description: "dynamic tool",
      handler: () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const events = await collectSseEventsCount(sse, 2, 2000);
    await closeSession(testServer.url, sessionId);

    expect(events).toHaveLength(2);
    // First event is connection
    expect(events[0].data).toEqual({
      type: "connection",
      status: "established",
    });
    // Second is the notification
    expect(events[1].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: undefined,
    });
  });

  it("emits notifications/prompts/list_changed when a prompt is registered after initialize", async () => {
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    const sse = await openSessionStream(testServer.url, sessionId);

    // Register a prompt post-initialize
    mcpServer.prompt("dynPrompt", {
      description: "dynamic prompt",
      handler: () => ({ messages: [] }),
    });

    const events = await collectSseEventsCount(sse, 2, 2000);
    await closeSession(testServer.url, sessionId);

    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({
      type: "connection",
      status: "established",
    });
    expect(events[1].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/prompts/list_changed",
      params: undefined,
    });
  });

  it("emits notifications/resources/list_changed when a resource is registered after initialize", async () => {
    const sessionId = await initializeSession(testServer.url, {
      name: "test-client",
      version: "1.0.0",
    });

    const sse = await openSessionStream(testServer.url, sessionId);

    // Register a resource post-initialize
    mcpServer.resource(
      "mem://foo",
      { description: "dynamic resource" },
      async () => ({
        contents: [{ uri: "mem://foo", text: "bar", type: "text" }],
      }),
    );

    const events = await collectSseEventsCount(sse, 2, 2000);
    await closeSession(testServer.url, sessionId);

    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({
      type: "connection",
      status: "established",
    });
    expect(events[1].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/resources/list_changed",
      params: undefined,
    });
  });
});

describe("POST SSE notifications in stateless mode (bug reproduction)", () => {
  let server: McpServer;
  let transport: StreamableHttpTransport;
  let httpHandler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    server = new McpServer({ name: "test-server", version: "1.0.0" });
    // Create transport in stateless mode (no generateSessionId)
    transport = new StreamableHttpTransport();
    httpHandler = transport.bind(server);

    // Add a tool that triggers notifications
    server.tool("test-tool", {
      description: "A test tool",
      handler: () => ({ content: [{ type: "text", text: "test result" }] }),
    });
  });

  it("should receive notifications in POST SSE requests in stateless mode (currently fails due to bug)", async () => {
    // Make a POST request with SSE Accept header (but no session ID because we're in stateless mode)
    const postSseRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        // Note: No MCP-Session-Id header because we're in stateless mode
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test-request",
        method: "tools/call",
        params: {
          name: "test-tool",
          arguments: {},
        },
      }),
    });

    const response = await httpHandler(postSseRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    // Start reading the SSE stream
    const stream = response.body as ReadableStream<Uint8Array>;

    // Register a new tool after the request starts - this should trigger a notification
    // but in stateless mode with POST SSE, it will be lost
    server.tool("dynamic-tool", {
      description: "A dynamic tool added after request",
      handler: () => ({ content: [{ type: "text", text: "dynamic result" }] }),
    });

    // Try to collect events from the stream
    const events = await collectSseEventsCount(stream, 2, 1000);

    // We expect:
    // 1. The response to the original tools/call request
    // 2. A notification about the new tool being added (notifications/tools/list_changed)
    //
    // This test should FAIL due to the bug - we expect 2 events but only get 1
    expect(events).toHaveLength(2); // This will FAIL - demonstrating the bug

    // The first event should be the response to our tools/call
    expect(events[0].data).toMatchObject({
      jsonrpc: "2.0",
      id: "test-request",
      result: {
        content: [{ type: "text", text: "test result" }],
      },
    });

    // The second event should be the list_changed notification
    expect(events[1].data).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: undefined,
    });
  });

  it("should show that regular POST requests with JSON responses work fine", async () => {
    // Make a regular POST request (no SSE)
    const postRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test-request",
        method: "tools/call",
        params: {
          name: "test-tool",
          arguments: {},
        },
      }),
    });

    const response = await httpHandler(postRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(json).toEqual({
      jsonrpc: "2.0",
      id: "test-request",
      result: {
        content: [{ type: "text", text: "test result" }],
      },
    });

    // Regular POST requests don't receive notifications anyway, so this works as expected
  });
});
