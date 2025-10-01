/** biome-ignore-all lint/style/noNonNullAssertion: tests */
/** biome-ignore-all lint/suspicious/noExplicitAny: tests */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  InMemoryClientRequestAdapter,
  InMemorySessionAdapter,
  McpServer,
  StreamableHttpTransport,
} from "../../src/index.js";

describe("Capabilities E2E Tests", () => {
  test("client capabilities are properly stored and retrieved", async () => {
    const server = new McpServer({
      name: "everything-test-server",
      version: "1.0.0",
      schemaAdapter: (s) => z.toJSONSchema(s as z.ZodType),
    });

    const clientRequestAdapter = new InMemoryClientRequestAdapter();
    const sessionAdapter = new InMemorySessionAdapter({
      maxEventBufferSize: 1024,
    });

    const transport = new StreamableHttpTransport({
      clientRequestAdapter,
      sessionAdapter,
    });

    const handler = transport.bind(server);

    server.tool("test-capabilities", {
      description: "Test capability detection",
      inputSchema: z.object({}),
      handler: async (_, ctx) => {
        const hasElicitation = ctx.client.supports("elicitation");
        const hasRoots = ctx.client.supports("roots");
        const hasSampling = ctx.client.supports("sampling");
        const hasUnknown = ctx.client.supports("unknown");

        return {
          content: [
            {
              type: "text",
              text: `elicitation:${hasElicitation},roots:${hasRoots},sampling:${hasSampling},unknown:${hasUnknown}`,
            },
          ],
        };
      },
    });

    // Test 1: Initialize with multiple capabilities
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: "2025-06-18",
        capabilities: {
          elicitation: {},
          roots: {},
          // Note: no sampling capability
        },
      },
    };

    const initResponse = await handler(
      new Request("http://localhost:3000/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initializeRequest),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id")!;

    // Test 2: Call tool to check capabilities
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
            name: "test-capabilities",
            arguments: {},
          },
        }),
      }),
    );

    expect(toolResponse.status).toBe(200);
    const toolResult = await toolResponse.json();

    // Verify that capabilities are correctly detected
    expect(toolResult.result.content[0].text).toBe(
      "elicitation:true,roots:true,sampling:false,unknown:false",
    );
  });
});
