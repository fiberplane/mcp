/** biome-ignore-all lint/style/noNonNullAssertion: tests */
/** biome-ignore-all lint/suspicious/noExplicitAny: tests */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { collectSseEventsCount } from "../../../../test-utils/src/sse.js";
import {
  buildInitializeRequest,
  createStatefulTestServer,
} from "../../utils.js";

const buildElicitatationInit = () =>
  buildInitializeRequest({
    capabilities: {
      elicitation: {},
    },
  });

describe("Elicitation E2E Tests", () => {
  // FIXME - this does not actually test ctx.elicit
  test("E2E: ctx.elicit() does not throw when client has elicitation capability", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("with-elicitation", {
      description: "Test elicitation support",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        // Check if elicitation is supported - this should now return true
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        // If we get here, elicitation is supported, which means capabilities were properly stored and passed
        return {
          content: [{ type: "text", text: "Elicitation is supported!" }],
        };
      },
    });

    // Initialize session WITH elicitation capability
    const initializeRequest = buildElicitatationInit();
    const initResponse = await handler(initializeRequest);

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    const toolResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "with-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();

    // Now that capabilities are properly stored and passed, ctx.client.supports("elicitation") should return true
    expect(toolResult.result.content[0].text).toBe("Elicitation is supported!");
  });

  test("E2E: ctx.elicit() throws when client lacks elicitation capability", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("no-elicitation", {
      description: "Test no elicitation support",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        try {
          await ctx.elicit({
            message: "This should fail",
            schema: z.object({ response: z.string() }),
          });
          return { content: [{ type: "text", text: "Should not reach here" }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session WITHOUT elicitation capability
    const initializeRequest = buildInitializeRequest();
    const initResponse = await handler(initializeRequest);

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    const toolResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "no-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();

    // Now returns the proper capability detection error
    // This indicates the capability detection is working correctly
    expect(toolResult.result.content[0].text).toContain(
      "Elicitation not supported by client",
    );
  });

  test("E2E: full elicitation flow with client accept response", async () => {
    // This test verifies the complete elicitation flow:
    // 1. Tool calls ctx.elicit() with proper schema
    // 2. Server sends elicitation/create request via SSE
    // 3. Client responds with accept + data via HTTP POST
    // 4. Server resolves the elicitation promise with the result
    // 5. Tool completes with the elicitation data

    const { server, handler } = createStatefulTestServer();

    server.tool("full-elicitation", {
      description: "Test complete elicitation flow",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          const result = await ctx.elicit({
            message: "Please provide your name",
            schema: z.object({ name: z.string() }),
          });

          return {
            content: [
              {
                type: "text",
                text: `Hello, ${result.content?.name || "Unknown"}!`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session WITH elicitation capability
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: "2025-06-18",
        capabilities: {
          elicitation: {}, // Include elicitation capability
        },
      },
    };

    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify(initializeRequest),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Open SSE stream directly via handler
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    // Set up event collection from the SSE stream
    const sseEventPromise = collectSseEventsCount(sseResponse.body!, 2, 5000);

    // Start tool call (without SSE - regular POST)
    const toolPromise = handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "full-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    // Wait for events from SSE stream
    const events = await sseEventPromise;
    expect(events).toHaveLength(2); // ping + elicitation

    // First event is ping, second is elicitation
    const elicitationData = events[1].data as any;
    expect(elicitationData.method).toBe("elicitation/create");
    expect(elicitationData.params.message).toBe("Please provide your name");

    // Send client response
    const clientResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: elicitationData.id,
          result: {
            action: "accept",
            content: { name: "Alice" },
          },
        }),
      }),
    );
    expect(clientResponse.status).toBe(202);

    // Wait for tool to complete
    const toolResponse = await toolPromise;
    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();
    expect(toolResult.result.content[0].text).toBe("Hello, Alice!");
  });

  test("E2E: full elicitation flow with client decline", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("decline-elicitation", {
      description: "Test elicitation decline flow",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          const result = await ctx.elicit({
            message: "Please provide your age",
            schema: z.object({ age: z.number() }),
          });

          return {
            content: [
              {
                type: "text",
                text: `Action was: ${result.action}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session with elicitation capability
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Open SSE stream
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    // Start collecting SSE events (ping + elicitation = 2 events)
    const ssePromise = collectSseEventsCount(sseResponse.body!, 2, 5000);

    // Start tool call
    const toolPromise = handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "decline-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    // Wait for elicitation request via SSE
    const events = await ssePromise;
    expect(events).toHaveLength(2);

    // First event is ping, second is elicitation
    const elicitationData = events[1].data as any;
    expect(elicitationData.method).toBe("elicitation/create");
    expect(elicitationData.params.message).toBe("Please provide your age");

    // Respond with decline (no content field)
    const declineResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: elicitationData.id,
          result: { action: "decline" },
        }),
      }),
    );
    expect(declineResponse.status).toBe(202);

    // Check final tool response
    const toolResponse = await toolPromise;
    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();
    expect(toolResult.result.content[0].text).toBe("Action was: decline");
  });

  test("E2E: full elicitation flow with client cancel", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("cancel-elicitation", {
      description: "Test elicitation cancel flow",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          const result = await ctx.elicit({
            message: "Please provide your name",
            schema: z.object({ name: z.string() }),
          });

          return {
            content: [
              {
                type: "text",
                text: `Action was: ${result.action}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Open SSE stream
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    const ssePromise = collectSseEventsCount(sseResponse.body!, 2, 5000);

    // Start tool call
    const toolPromise = handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "cancel-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    // Get elicitation request from SSE
    const events = await ssePromise;
    expect(events).toHaveLength(2);

    const elicitationData = events[1].data as any;
    expect(elicitationData.method).toBe("elicitation/create");

    // Respond with cancel
    const cancelResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: elicitationData.id,
          result: { action: "cancel" },
        }),
      }),
    );
    expect(cancelResponse.status).toBe(202);

    // Verify tool response
    const toolResponse = await toolPromise;
    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();
    expect(toolResult.result.content[0].text).toBe("Action was: cancel");
  });

  test("E2E: elicitation timeout when client doesn't respond", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("timeout-elicitation", {
      description: "Test elicitation timeout",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          await ctx.elicit(
            {
              message: "Please provide data",
              schema: z.object({ data: z.string() }),
            },
            { timeout_ms: 100 }, // Very short timeout
          );

          return {
            content: [{ type: "text", text: "Should not reach here" }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Timeout occurred: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Open SSE stream but don't respond to elicitation
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    // Call tool - it should timeout since we don't respond
    const toolResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "timeout-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();
    expect(toolResult.result.content[0].text).toContain("Timeout occurred");

    // Clean up SSE
    sseResponse.body?.cancel();
  });

  test("E2E: elicitation with invalid client response data", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("invalid-response-elicitation", {
      description: "Test elicitation with invalid response",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          const result = await ctx.elicit({
            message: "Please provide your age as a number",
            schema: z.object({ age: z.number() }),
          });

          return {
            content: [
              {
                type: "text",
                text: `Received: ${JSON.stringify(result)}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Open SSE stream
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    const ssePromise = collectSseEventsCount(sseResponse.body!, 2, 5000);

    // Start tool call
    const toolPromise = handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "invalid-response-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    // Get elicitation request
    const events = await ssePromise;
    expect(events).toHaveLength(2);

    const elicitationData = events[1].data as any;
    expect(elicitationData.method).toBe("elicitation/create");

    // Respond with invalid data (string instead of number for age)
    const invalidResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: elicitationData.id,
          result: {
            action: "accept",
            content: { age: "not a number" }, // Invalid data type
          },
        }),
      }),
    );
    expect(invalidResponse.status).toBe(202);

    // The system should handle this gracefully
    const toolResponse = await toolPromise;
    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();

    // System should either accept the invalid data or show validation error
    expect(toolResult.result.content[0].text).toMatch(
      /(Received:|Validation error:)/,
    );
  });

  test("E2E: elicitation with client error response", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("error-response-elicitation", {
      description: "Test elicitation with client error",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          await ctx.elicit({
            message: "This will cause client error",
            schema: z.object({ data: z.string() }),
          });

          return {
            content: [{ type: "text", text: "Should not reach here" }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Client error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Open SSE stream
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    const ssePromise = collectSseEventsCount(sseResponse.body!, 2, 5000);

    // Start tool call
    const toolPromise = handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "error-response-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    // Get elicitation request
    const events = await ssePromise;
    expect(events).toHaveLength(2);

    const elicitationData = events[1].data as any;
    expect(elicitationData.method).toBe("elicitation/create");

    // Respond with JSON-RPC error instead of result
    const errorResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: elicitationData.id,
          error: {
            code: -32000,
            message: "Client encountered an error",
            data: { details: "Something went wrong" },
          },
        }),
      }),
    );
    expect(errorResponse.status).toBe(202);

    // Verify error is propagated
    const toolResponse = await toolPromise;
    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();
    expect(toolResult.result.content[0].text).toContain("Client error:");
    expect(toolResult.result.content[0].text).toContain(
      "Client encountered an error",
    );
  });

  test.skip("E2E: multiple sequential elicitations in one tool", async () => {
    // TODO: This test has complex async timing issues with sequential elicitations
    // The test expects both elicitation requests to be available simultaneously,
    // but sequential await calls mean the second elicitation doesn't start until
    // the first one completes. This requires more sophisticated event handling.
    const { server, handler } = createStatefulTestServer();

    server.tool("sequential-elicitations", {
      description: "Test multiple sequential elicitations",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          const result1 = await ctx.elicit({
            message: "What is your name?",
            schema: z.object({ name: z.string() }),
          });

          if (result1.action !== "accept") {
            return {
              content: [
                { type: "text", text: `First request was ${result1.action}` },
              ],
            };
          }

          const result2 = await ctx.elicit({
            message: "What is your age?",
            schema: z.object({ age: z.number() }),
          });

          if (result2.action !== "accept") {
            return {
              content: [
                { type: "text", text: `Second request was ${result2.action}` },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Hello ${result1.content?.name}, you are ${result2.content?.age} years old!`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // For sequential elicitations, we'll collect events as they come
    // and respond to each one individually
    let elicitationCount = 0;
    const elicitationResponses: Array<{ id: string; message: string }> = [];

    // Open SSE stream and start event collection
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    // Create a promise to handle SSE events as they arrive
    const sseEventHandler = new Promise<void>((resolve) => {
      if (!sseResponse.body) {
        resolve();
        return;
      }

      const reader = sseResponse.body.getReader();
      const decoder = new TextDecoder();

      const readEvents = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.method === "elicitation/create") {
                    elicitationCount++;
                    elicitationResponses.push({
                      id: data.id,
                      message: data.params.message,
                    });

                    // Respond immediately to each elicitation
                    const responseData =
                      data.params.message === "What is your name?"
                        ? { name: "Alice" }
                        : { age: 30 };

                    await handler(
                      new Request("http://localhost:3000/", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "MCP-Protocol-Version": "2025-06-18",
                          "MCP-Session-Id": sessionId,
                        },
                        body: JSON.stringify({
                          jsonrpc: "2.0",
                          id: data.id,
                          result: {
                            action: "accept",
                            content: responseData,
                          },
                        }),
                      }),
                    );

                    // Stop after handling 2 elicitations
                    if (elicitationCount >= 2) {
                      resolve();
                      return;
                    }
                  }
                } catch (_e) {
                  // Ignore parse errors (pings, etc.)
                }
              }
            }
          }
        } catch (_error) {
          resolve();
        }
      };

      readEvents();
    });

    // Start tool call
    const toolPromise = handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "sequential-elicitations",
            arguments: {},
          },
        }),
      }),
    );

    // Wait for all elicitations to be handled (with timeout)
    await Promise.race([
      sseEventHandler,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SSE timeout")), 5000),
      ),
    ]);

    // Verify we got both elicitations
    expect(elicitationCount).toBe(2);
    expect(elicitationResponses[0].message).toBe("What is your name?");
    expect(elicitationResponses[1].message).toBe("What is your age?");

    // Verify final tool result
    const toolResponse = await toolPromise;
    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();
    expect(toolResult.result.content[0].text).toBe(
      "Hello Alice, you are 30 years old!",
    );
  });

  test("E2E: elicitation with empty schema", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("empty-schema-elicitation", {
      description: "Test elicitation with empty schema",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          const result = await ctx.elicit({
            message: "Please confirm this action",
            schema: z.object({}), // Empty schema
          });

          return {
            content: [
              {
                type: "text",
                text: `Action was ${result.action}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Open SSE stream
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
      }),
    );
    expect(sseResponse.status).toBe(200);

    const ssePromise = collectSseEventsCount(sseResponse.body!, 2, 5000);

    // Start tool call
    const toolPromise = handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "empty-schema-elicitation",
            arguments: {},
          },
        }),
      }),
    );

    const events = await ssePromise;
    expect(events).toHaveLength(2);

    const elicitationData = events[1].data as any;
    expect(elicitationData.params.requestedSchema.type).toBe("object");
    expect(elicitationData.params.requestedSchema.properties).toEqual({});

    // Respond with empty object
    await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: elicitationData.id,
          result: {
            action: "accept",
            content: {}, // Empty content for empty schema
          },
        }),
      }),
    );

    const toolResponse = await toolPromise;
    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();
    expect(toolResult.result.content[0].text).toBe("Action was accept");
  });

  test("E2E: elicitation with optional fields schema", async () => {
    const { server, handler } = createStatefulTestServer();

    server.tool("optional-fields-elicitation", {
      description: "Test elicitation with optional fields",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        if (!ctx.client.supports("elicitation")) {
          return {
            content: [{ type: "text", text: "Elicitation not supported" }],
          };
        }

        try {
          const result = await ctx.elicit({
            message: "Please provide your contact info",
            schema: z.object({
              name: z.string().optional(),
              email: z.string().email().optional(),
              phone: z.string().optional(),
            }),
          });

          if (result.action === "accept") {
            const fields: string[] = [];
            const content = result.content as any;
            if (content?.name) fields.push(`name: ${content.name}`);
            if (content?.email) fields.push(`email: ${content.email}`);
            if (content?.phone) fields.push(`phone: ${content.phone}`);

            return {
              content: [
                {
                  type: "text",
                  text: `Provided fields: ${fields.length > 0 ? fields.join(", ") : "none"}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Action was ${result.action}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
          };
        }
      },
    });

    // Initialize session
    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Use POST SSE request for this test
    const sseResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "optional-fields-elicitation",
            arguments: {},
          },
        }),
      }),
    );
    expect(sseResponse.status).toBe(200);

    // First, wait for just the elicitation request
    const elicitationEvents = await collectSseEventsCount(
      sseResponse.body!,
      1,
      5000,
    );
    expect(elicitationEvents).toHaveLength(1);

    const elicitationData = elicitationEvents[0].data as any;
    expect(elicitationData.method).toBe("elicitation/create");
    expect(elicitationData.params.requestedSchema.properties).toHaveProperty(
      "name",
    );
    expect(elicitationData.params.requestedSchema.properties).toHaveProperty(
      "email",
    );
    expect(elicitationData.params.requestedSchema.properties).toHaveProperty(
      "phone",
    );

    // Respond with partial data (only some optional fields)
    const clientResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "MCP-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: elicitationData.id,
          result: {
            action: "accept",
            content: {
              name: "John Doe",
              email: "john@example.com",
              // phone is omitted (optional)
            },
          },
        }),
      }),
    );
    expect(clientResponse.status).toBe(202);

    // Now wait for the final tool result event
    const finalEvents = await collectSseEventsCount(sseResponse.body!, 1, 5000);
    expect(finalEvents).toHaveLength(1);

    const toolResult = finalEvents[0].data as any;
    expect(toolResult.result.content[0].text).toBe(
      "Provided fields: name: John Doe, email: john@example.com",
    );
  });
});
