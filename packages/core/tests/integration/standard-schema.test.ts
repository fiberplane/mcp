import { beforeEach, describe, expect, it } from "bun:test";
import { type Type, type } from "arktype";
// import type { StandardSchemaV1 } from "@standard-schema/spec";
import { McpServer, StreamableHttpTransport } from "../../src/index.js";
import type { JsonRpcRes } from "../../src/types.js";

describe("Standard Schema Support", () => {
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    const mcp = new McpServer({
      name: "schema-test-server",
      version: "1.0.0",
      schemaAdapter: (schema) => (schema as Type).toJsonSchema(),
    });

    // Tool with Standard Schema validation (ArkType)
    const numberValidator = type({ value: "number" });

    mcp.tool("doubleNumber", {
      description: "Doubles a number with validation",
      inputSchema: numberValidator,
      handler: (args: { value: number }) => ({
        content: [{ type: "text", text: String(args.value * 2) }],
      }),
    });

    // Tool with JSON schema
    mcp.tool("concat", {
      description: "Concatenates two strings",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
        },
        required: ["a", "b"],
      },
      handler: (args: { a: string; b: string }) => ({
        content: [{ type: "text", text: args.a + args.b }],
      }),
    });

    // Tool without schema
    mcp.tool("echo", {
      description: "Echoes input",
      handler: (args: { message: string }) => ({
        content: [{ type: "text", text: args.message }],
      }),
    });

    const transport = new StreamableHttpTransport();
    handler = transport.bind(mcp);
  });

  it("should validate with Standard Schema validator", async () => {
    // Valid input
    const validRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "doubleNumber",
          arguments: { value: 5 },
        },
      }),
    });

    const validResponse = await handler(validRequest);
    const validResult = (await validResponse.json()) as JsonRpcRes;
    expect(validResult.error).toBeUndefined();
    expect(validResult.result).toEqual({
      content: [{ type: "text", text: "10" }],
    });

    // Invalid input
    const invalidRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/call",
        params: {
          name: "doubleNumber",
          arguments: { value: "not a number" },
        },
      }),
    });

    const invalidResponse = await handler(invalidRequest);
    const invalidResult = (await invalidResponse.json()) as JsonRpcRes;
    expect(invalidResult.error).toBeDefined();
    expect(invalidResult.error?.code).toBe(-32602);
    // The validation error message should appear in the data field or message
    const errorMessage =
      invalidResult.error?.data || invalidResult.error?.message || "";
    // ArkType wording: "Validation failed: value must be a number (was a string)"
    expect(errorMessage.toString()).toContain("Validation failed");
  });

  it("should list tools with proper schemas", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/list",
      }),
    });

    const response = await handler(request);
    const result = (await response.json()) as JsonRpcRes;

    expect(result.result).toMatchObject({
      tools: [
        {
          name: "doubleNumber",
          description: "Doubles a number with validation",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: "number" },
            },
            required: ["value"],
          }, // Converted by ArkType schema adapter
        },
        {
          name: "concat",
          description: "Concatenates two strings",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "string" },
              b: { type: "string" },
            },
            required: ["a", "b"],
          }, // Regular JSON schema preserved
        },
        {
          name: "echo",
          description: "Echoes input",
          inputSchema: { type: "object" }, // Default schema
        },
      ],
    });
  });

  it("should enforce ToolCallResult return type", async () => {
    // This test verifies that handlers must return ToolCallResult format
    // The compilation would fail if handlers returned raw values instead of ToolCallResult
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { message: "test" },
        },
      }),
    });

    const response = await handler(request);
    const result = (await response.json()) as JsonRpcRes;

    // Verify the result has the proper ToolCallResult structure
    expect(result.result).toHaveProperty("content");
    const toolResult = result.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content[0]).toEqual({
      type: "text",
      text: "test",
    });
  });

  it("should support callable Standard Schema validators (like ArkType)", async () => {
    // ArkType types are callable and Standard Schema compatible
    const callableValidator = type({ name: "string" });

    const mcp = new McpServer({
      name: "callable-schema-server",
      version: "1.0.0",
      schemaAdapter: (schema) => (schema as Type).toJsonSchema(),
    });

    mcp.tool("greet", {
      description: "Greets a person",
      inputSchema: callableValidator,
      handler: (args: { name: string }) => ({
        content: [{ type: "text", text: `Hello, ${args.name}!` }],
      }),
    });

    const transport = new StreamableHttpTransport();
    const testHandler = transport.bind(mcp);

    // Test that tools/list properly exposes the JSON Schema
    const listResponse = await testHandler(
      new Request("http://test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "list-1",
          method: "tools/list",
        }),
      }),
    );

    const listData = await listResponse.json();
    expect(listData.result.tools).toHaveLength(1);
    expect(listData.result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    });

    // Test that validation works for valid input
    const validResponse = await testHandler(
      new Request("http://test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "valid-1",
          method: "tools/call",
          params: {
            name: "greet",
            arguments: { name: "Alice" },
          },
        }),
      }),
    );

    const validData = await validResponse.json();
    expect(validData.error).toBeUndefined();
    expect(validData.result.content[0].text).toBe("Hello, Alice!");

    // Test that validation rejects invalid input
    const invalidResponse = await testHandler(
      new Request("http://test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "invalid-1",
          method: "tools/call",
          params: {
            name: "greet",
            arguments: { name: 123 }, // Wrong type
          },
        }),
      }),
    );

    const invalidData = await invalidResponse.json();
    expect(invalidData.error).toBeDefined();
    expect(invalidData.error.message).toContain("Validation failed");
  });
});
