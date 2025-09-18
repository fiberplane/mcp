import { beforeEach, describe, expect, test } from "bun:test";
import { McpServer, StreamableHttpTransport } from "../../src/index.js";
import type { JsonRpcRes } from "../../src/types.js";

describe("Elicitation ctx.client.supports() functionality", () => {
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    const mcp = new McpServer({
      name: "elicitation-test-server",
      version: "1.0.0",
    });

    // Tool that checks elicitation support
    mcp.tool("checkElicitationSupport", {
      description: "Checks if client supports elicitation",
      handler: (_args, ctx) => {
        const supportsElicitation = ctx.client.supports("elicitation");
        const supportsRoots = ctx.client.supports("roots");
        const supportsSampling = ctx.client.supports("sampling");
        const supportsUnknown = ctx.client.supports("unknown");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                elicitation: supportsElicitation,
                roots: supportsRoots,
                sampling: supportsSampling,
                unknown: supportsUnknown,
              }),
            },
          ],
        };
      },
    });

    const transport = new StreamableHttpTransport({
      generateSessionId: () => Math.random().toString(36).substring(7),
    });
    handler = transport.bind(mcp);
  });

  test("should return true for supported capabilities", async () => {
    // Step 1: Initialize with elicitation capability
    const initRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {
            elicitation: {},
            roots: {},
          },
          clientInfo: {
            name: "test-client",
            version: "1.0.0",
          },
        },
      }),
    });

    const initResponse = await handler(initRequest);
    expect(initResponse.status).toBe(200);

    const sessionId = initResponse.headers.get("MCP-Session-Id");
    expect(sessionId).toBeTruthy();

    // Step 2: Call tool that checks supports()
    const toolRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/call",
        params: {
          name: "checkElicitationSupport",
          arguments: {},
        },
      }),
    });

    const toolResponse = await handler(toolRequest);
    const result = (await toolResponse.json()) as JsonRpcRes;

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();

    const content = (result.result as any).content[0].text;
    const supports = JSON.parse(content);

    expect(supports.elicitation).toBe(true);
    expect(supports.roots).toBe(true);
    expect(supports.sampling).toBe(false);
    expect(supports.unknown).toBe(false);
  });

  test("should return false for unsupported capabilities", async () => {
    // Step 1: Initialize without capabilities
    const initRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: {
            name: "test-client",
            version: "1.0.0",
          },
        },
      }),
    });

    const initResponse = await handler(initRequest);
    expect(initResponse.status).toBe(200);

    const sessionId = initResponse.headers.get("MCP-Session-Id");
    expect(sessionId).toBeTruthy();

    // Step 2: Call tool that checks supports()
    const toolRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/call",
        params: {
          name: "checkElicitationSupport",
          arguments: {},
        },
      }),
    });

    const toolResponse = await handler(toolRequest);
    const result = (await toolResponse.json()) as JsonRpcRes;

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();

    const content = (result.result as any).content[0].text;
    const supports = JSON.parse(content);

    expect(supports.elicitation).toBe(false);
    expect(supports.roots).toBe(false);
    expect(supports.sampling).toBe(false);
    expect(supports.unknown).toBe(false);
  });

  test("should handle sessions without capabilities gracefully", async () => {
    // Step 1: Initialize with empty capabilities object
    const initRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "test-client",
            version: "1.0.0",
          },
        },
      }),
    });

    const initResponse = await handler(initRequest);
    expect(initResponse.status).toBe(200);

    const sessionId = initResponse.headers.get("MCP-Session-Id");
    expect(sessionId).toBeTruthy();

    // Step 2: Call tool that checks supports()
    const toolRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "MCP-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/call",
        params: {
          name: "checkElicitationSupport",
          arguments: {},
        },
      }),
    });

    const toolResponse = await handler(toolRequest);
    const result = (await toolResponse.json()) as JsonRpcRes;

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();

    const content = (result.result as any).content[0].text;
    const supports = JSON.parse(content);

    expect(supports.elicitation).toBe(false);
    expect(supports.roots).toBe(false);
    expect(supports.sampling).toBe(false);
    expect(supports.unknown).toBe(false);
  });
});
