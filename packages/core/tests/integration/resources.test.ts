import { beforeEach, describe, expect, it } from "bun:test";
import { McpServer } from "../../src/core.js";
import { JSON_RPC_ERROR_CODES } from "../../src/types.js";

describe("Resource API", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });
  });

  describe("Static resources", () => {
    it("should register and read static resources", async () => {
      const configData = { appName: "test", version: "1.0" };

      server.resource(
        "file://config.json",
        { description: "App configuration", mimeType: "application/json" },
        async (uri) => ({
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(configData),
              mimeType: "application/json",
              type: "text",
            },
          ],
        }),
      );

      // Test resources/list
      const listResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/list",
        params: {},
      });

      expect(listResult?.result).toEqual({
        resources: [
          {
            uri: "file://config.json",
            description: "App configuration",
            mimeType: "application/json",
          },
        ],
      });

      // Test resources/read
      const readResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "file://config.json" },
      });

      expect(readResult?.result).toEqual({
        contents: [
          {
            uri: "file://config.json",
            text: JSON.stringify(configData),
            mimeType: "application/json",
            type: "text",
          },
        ],
      });
    });

    it("should return empty list when no resources registered", async () => {
      const result = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/list",
        params: {},
      });

      expect(result?.result).toEqual({ resources: [] });
    });
  });

  describe("Template resources", () => {
    it("should separate static resources and templates in list endpoints", async () => {
      // Register a static resource
      server.resource(
        "issues://all",
        {
          name: "All Issues",
          description: "Get all issues in the system",
          mimeType: "application/json",
        },
        async (uri) => ({
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify([{ id: 1, title: "Issue 1" }]),
              mimeType: "application/json",
              type: "text",
            },
          ],
        }),
      );

      // Register a templated resource
      server.resource(
        "issue://{id}",
        {
          name: "Issue by ID",
          description: "Get a specific issue by its ID",
          mimeType: "application/json",
        },
        async (uri, { id }) => ({
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ id, title: `Issue ${id}` }),
              mimeType: "application/json",
              type: "text",
            },
          ],
        }),
      );

      // Test resources/list - should only return static resources
      const listResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/list",
        params: {},
      });

      expect(listResult?.result).toEqual({
        resources: [
          {
            uri: "issues://all",
            name: "All Issues",
            description: "Get all issues in the system",
            mimeType: "application/json",
          },
        ],
      });

      // Test resources/templates/list - should only return templated resources
      const templatesResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/templates/list",
        params: {},
      });

      expect(templatesResult?.result).toEqual({
        resourceTemplates: [
          {
            uriTemplate: "issue://{id}",
            name: "Issue by ID",
            description: "Get a specific issue by its ID",
            mimeType: "application/json",
          },
        ],
      });
    });

    it("should register and read template resources without validation", async () => {
      server.resource(
        "github://repos/{owner}/{repo}",
        { description: "GitHub repository" },
        async (uri, { owner, repo }) => ({
          contents: [
            {
              uri: uri.href,
              text: `Repository: ${owner}/${repo}`,
              mimeType: "text/plain",
              type: "text",
            },
          ],
        }),
      );

      // Test resources/templates/list
      const templatesResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/templates/list",
        params: {},
      });

      expect(templatesResult?.result).toEqual({
        resourceTemplates: [
          {
            uriTemplate: "github://repos/{owner}/{repo}",
            description: "GitHub repository",
          },
        ],
      });

      // Test resources/read with template matching
      const readResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "github://repos/octocat/Hello-World" },
      });

      expect(readResult?.result).toEqual({
        contents: [
          {
            uri: "github://repos/octocat/Hello-World",
            text: "Repository: octocat/Hello-World",
            mimeType: "text/plain",
            type: "text",
          },
        ],
      });
    });

    it("should handle template resources with parameter validation", async () => {
      // Mock a simple validator that checks userId is numeric
      const userIdValidator = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (input: unknown) => {
            if (typeof input === "string" && /^\d+$/.test(input)) {
              return { value: input };
            }
            return {
              issues: [{ message: "Must be numeric" }],
            };
          },
        },
      };

      server.resource(
        "api://users/{userId}",
        { description: "User by ID" },
        { userId: userIdValidator },
        async (uri, { userId }) => ({
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ id: userId, name: `User ${userId}` }),
              mimeType: "application/json",
              type: "text",
            },
          ],
        }),
      );

      // Valid request
      const validResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "api://users/123" },
      });

      expect(validResult?.result).toEqual({
        contents: [
          {
            uri: "api://users/123",
            text: JSON.stringify({ id: "123", name: "User 123" }),
            mimeType: "application/json",
            type: "text",
          },
        ],
      });

      // Invalid request (non-numeric userId)
      const invalidResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "api://users/abc" },
      });

      expect(invalidResult?.error?.code).toBe(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      );
      expect(invalidResult?.error?.message).toContain("Validation failed");
    });

    it("should handle query parameters", async () => {
      server.resource(
        "database://tables/{schema}/{table}/rows{?limit,offset}",
        { description: "Database table rows" },
        async (uri, vars) => ({
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                schema: vars.schema,
                table: vars.table,
                limit: vars.limit || "10",
                offset: vars.offset || "0",
              }),
              mimeType: "application/json",
              type: "text",
            },
          ],
        }),
      );

      // With query parameters
      const withQueryResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: {
          uri: "database://tables/public/users/rows?limit=5&offset=10",
        },
      });

      expect(withQueryResult?.result).toEqual({
        contents: [
          {
            uri: "database://tables/public/users/rows?limit=5&offset=10",
            text: JSON.stringify({
              schema: "public",
              table: "users",
              limit: "5",
              offset: "10",
            }),
            mimeType: "application/json",
            type: "text",
          },
        ],
      });

      // Without query parameters
      const withoutQueryResult = await server._dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "database://tables/public/users/rows" },
      });

      expect(withoutQueryResult?.result).toEqual({
        contents: [
          {
            uri: "database://tables/public/users/rows",
            text: JSON.stringify({
              schema: "public",
              table: "users",
              limit: "10",
              offset: "0",
            }),
            mimeType: "application/json",
            type: "text",
          },
        ],
      });
    });
  });

  describe("Error handling", () => {
    it("should return METHOD_NOT_FOUND for unknown resources", async () => {
      const result = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "unknown://resource" },
      });

      expect(result?.error?.code).toBe(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND);
      expect(result?.error?.message).toBe("Method not found");
    });

    it("should return INVALID_PARAMS for malformed requests", async () => {
      const result = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { notUri: "invalid" },
      });

      expect(result?.error?.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    });

    it("should handle handler errors properly", async () => {
      server.resource(
        "error://test",
        { description: "Error test" },
        async () => {
          throw new Error("Handler error");
        },
      );

      const result = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "error://test" },
      });

      expect(result?.error?.code).toBe(JSON_RPC_ERROR_CODES.INTERNAL_ERROR);
    });
  });

  describe("Route precedence", () => {
    it("should match first registered route", async () => {
      // Register specific route first
      server.resource(
        "test://specific",
        { description: "Specific route" },
        async () => ({
          contents: [
            { uri: "test://specific", text: "specific", type: "text" },
          ],
        }),
      );

      // Register general pattern second
      server.resource(
        "test://{path}",
        { description: "General pattern" },
        async () => ({
          contents: [{ uri: "test://general", text: "general", type: "text" }],
        }),
      );

      const result = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "test://specific" },
      });

      expect(
        (result?.result as { contents?: Array<{ text?: string }> })
          ?.contents?.[0]?.text,
      ).toBe("specific");
    });
  });

  describe("resources/subscribe (not implemented)", () => {
    it("should return not implemented for subscribe", async () => {
      const result = await server._dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: "test://resource" },
      });

      expect(result?.error?.code).toBe(JSON_RPC_ERROR_CODES.INTERNAL_ERROR);
      expect(result?.error?.message).toBe("Not implemented");
    });
  });
});
