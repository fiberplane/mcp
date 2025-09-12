import { toJsonSchema } from "@valibot/to-json-schema";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import * as v from "valibot";

const mcp = new McpServer({
  name: "auth-clerk",
  version: "1.0.0",
  schemaAdapter: (schema) => toJsonSchema(schema as v.AnySchema),
});

// Define schema
const EchoSchema = v.object({
  message: v.string(),
});

// Add a tool
mcp.tool("echo", {
  description: "Echoes the input message",
  inputSchema: EchoSchema,
  handler: (args) => ({
    content: [{ type: "text", text: args.message }],
  }),
});

// Create HTTP transport
const transport = new StreamableHttpTransport();
export const httpHandler = transport.bind(mcp);
