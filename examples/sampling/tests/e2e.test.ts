import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createExampleServer,
  createJsonRpcClient,
  type TestServer,
} from "@internal/test-utils";

describe("Sampling Example", () => {
  let server: TestServer;
  let request: ReturnType<typeof createJsonRpcClient>;

  beforeAll(async () => {
    // Start the example server
    server = await createExampleServer(() => import("../src/index.ts"));
    request = createJsonRpcClient(server.url);

    // Initialize the server
    await request("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  describe("ArkType schema adapter integration", () => {
    it("should convert ArkType schema to JSON Schema in tools/list", async () => {
      const response = await request("tools/list");

      expect(response.error).toBeUndefined();
      // biome-ignore lint/suspicious/noExplicitAny: tests
      expect((response.result as any).tools).toHaveLength(1);

      // biome-ignore lint/suspicious/noExplicitAny: tests
      const echoTool = (response.result as any).tools[0];
      expect(echoTool.name).toBe("echo");
      expect(echoTool.description).toBe("Echoes the input message");

      // Verify that the ArkType schema was converted to JSON Schema
      expect(echoTool.inputSchema).toMatchObject({
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      });
    });
  });

  describe("ArkType schema validation", () => {
    it("should accept valid input that matches ArkType schema", async () => {
      const response = await request("tools/call", {
        name: "echo",
        arguments: {
          message: "Hello, ArkType!",
        },
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({
        content: [
          {
            type: "text",
            text: "Hello, ArkType!",
          },
        ],
      });
    });

    it("should reject input missing required field", async () => {
      await expect(
        request("tools/call", {
          name: "echo",
          arguments: {}, // Missing required 'message' field
        }),
      ).rejects.toThrow("JSON-RPC Error");
    });

    it("should reject input with wrong type", async () => {
      await expect(
        request("tools/call", {
          name: "echo",
          arguments: {
            message: 123, // Should be string, not number
          },
        }),
      ).rejects.toThrow("JSON-RPC Error");
    });

    it("should reject input with wrong field name", async () => {
      // ArkType should reject this because 'message' is required but 'kewlMessagee' was provided
      expect(
        request("tools/call", {
          name: "echo",
          arguments: {
            kewlMessagee: "Hello", // Should be 'message', not 'kewlMessagee'
          },
        }),
      ).rejects.toThrow("JSON-RPC Error");
    });
  });
});
