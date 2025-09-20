import { beforeEach, describe, expect, it } from "bun:test";
import { type Type, type } from "arktype";
// import type { StandardSchemaV1 } from "@standard-schema/spec";
import { McpServer, StreamableHttpTransport } from "../../src/index.js";

// Type for JSON-RPC response
interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Real Standard Schema validator using ArkType
const messageValidator = type({ message: "string" });

// Create a test handler function with prompts
function createTestHandler() {
  const mcp = new McpServer({
    name: "test-server",
    version: "1.0.0",
    schemaAdapter: (schema) => (schema as Type).toJsonSchema(),
  });

  // Add a simple prompt without arguments
  mcp.prompt("greeting", {
    description: "Generate a greeting message",
    handler: () => ({
      description: "A friendly greeting",
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: "Hello, how are you today?" },
        },
      ],
    }),
  });

  // Add a prompt with arguments but no schema
  mcp.prompt("summarize", {
    description: "Create a summary prompt",
    arguments: [
      { name: "text", description: "Text to summarize", required: true },
      { name: "length", description: "Summary length", required: false },
    ],
    handler: (args: { text: string; length?: string }) => ({
      description: "Summarization prompt",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please summarize this text in ${args?.length || "medium"} length:\n\n${args?.text || ""}`,
          },
        },
      ],
    }),
  });

  // Add a prompt with JSON Schema validation
  mcp.prompt("analyze", {
    description: "Analyze text with specific parameters",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to analyze" },
        focus: {
          type: "string",
          enum: ["sentiment", "topics", "summary"],
          description: "Analysis focus",
        },
      },
      required: ["content"],
    },
    handler: (args: { content: string; focus?: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Analyze this content for ${args.focus || "general insights"}:\n\n${args.content}`,
          },
        },
      ],
    }),
  });

  // Add a prompt with Standard Schema validation to test runtime validation
  mcp.prompt("validated", {
    description: "Prompt with runtime validation",
    inputSchema: messageValidator,
    handler: (args: { message: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Validated message: ${args.message}`,
          },
        },
      ],
    }),
  });

  const transport = new StreamableHttpTransport();
  return transport.bind(mcp);
}

describe("Prompt Registration and Handling", () => {
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    handler = createTestHandler();
  });

  describe("Server initialization with prompts", () => {
    it("should include prompts capability in initialize response", async () => {
      const request = new Request("http://localhost/mcp", {
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

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        protocolVersion: "2025-06-18",
        serverInfo: {
          name: "test-server",
          version: "1.0.0",
        },
        capabilities: {
          prompts: {
            listChanged: true,
          },
        },
      });
    });
  });

  describe("prompts/list endpoint", () => {
    it("should list all registered prompts", async () => {
      // Initialize first
      await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: "2025-06-18" },
          }),
        }),
      );

      // List prompts
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "prompts/list",
        }),
      });

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        prompts: [
          {
            name: "greeting",
            description: "Generate a greeting message",
          },
          {
            name: "summarize",
            description: "Create a summary prompt",
            arguments: [
              {
                name: "text",
                description: "Text to summarize",
                required: true,
              },
              {
                name: "length",
                description: "Summary length",
                required: false,
              },
            ],
          },
          {
            name: "analyze",
            description: "Analyze text with specific parameters",
            arguments: [
              {
                name: "content",
                description: "Content to analyze",
                required: true,
              },
              { name: "focus", description: "Analysis focus", required: false },
            ],
          },
          {
            name: "validated",
            description: "Prompt with runtime validation",
            arguments: [
              {
                name: "message",
                required: true,
              },
            ],
          },
        ],
      });
    });
  });

  describe("prompts/get endpoint", () => {
    beforeEach(async () => {
      // Initialize server before each test
      await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: "2025-06-18" },
          }),
        }),
      );
    });

    it("should execute prompt without arguments", async () => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "prompts/get",
          params: {
            name: "greeting",
          },
        }),
      });

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        description: "A friendly greeting",
        messages: [
          {
            role: "user",
            content: { type: "text", text: "Hello, how are you today?" },
          },
        ],
      });
    });

    it("should execute prompt with arguments", async () => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "prompts/get",
          params: {
            name: "summarize",
            arguments: {
              text: "This is a long text that needs to be summarized",
              length: "short",
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        description: "Summarization prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Please summarize this text in short length:\n\nThis is a long text that needs to be summarized",
            },
          },
        ],
      });
    });

    it("should validate arguments with Standard Schema and succeed", async () => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "prompts/get",
          params: {
            name: "validated",
            arguments: {
              message: "This is a valid message",
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Validated message: This is a valid message",
            },
          },
        ],
      });
    });

    it("should reject Standard Schema validation failure", async () => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "prompts/get",
          params: {
            name: "validated",
            arguments: {
              // Missing required 'message' field
              invalid: "field",
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe(-32602);
      expect(result.error?.message).toContain("Validation failed");
    });

    it("should reject invalid prompt name", async () => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "prompts/get",
          params: {
            name: "nonexistent",
          },
        }),
      });

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe(-32602);
      expect(result.error?.message).toBe("Invalid prompt name");
      expect(result.error?.data).toEqual({ name: "nonexistent" });
    });

    it("should reject invalid arguments format", async () => {
      const request = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "prompts/get",
          params: "invalid",
        }),
      });

      const response = await handler(request);
      expect(response.ok).toBe(true);

      const result = (await response.json()) as JsonRpcResponse;
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe(-32602);
      expect(result.error?.message).toBe(
        "prompts/get requires an object with name and arguments",
      );
    });
  });
});
