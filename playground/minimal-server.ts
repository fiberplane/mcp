import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";

const mcp = new McpServer({
  name: "example-server",
  version: "1.0.0",
});

mcp.use(async (c, n) => {
  console.log("MCP request received:", c);
  await n();
});

// Add a simple echo tool
mcp.tool("echo", {
  description: "Echoes the input message",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
  },
  handler: (args: { message: string }) => ({
    content: [{ type: "text", text: args.message }],
  }),
});

mcp.tool("test", {
  description: "Test tool",
  handler: () => ({
    content: [{ type: "text", text: "test" }],
  }),
});

// Add a math tool
mcp.tool("add", {
  description: "Adds two numbers",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
  },
  handler: (args: { a: number; b: number }) => ({
    content: [{ type: "text", text: String(args.a + args.b) }],
  }),
});

// Create HTTP transport in stateless mode (no session adapter)
const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

// Create Hono app
const app = new Hono();

// Add MCP endpoint
app.all("/mcp", async (c) => {
  const response = await httpHandler(c.req.raw);
  return response;
});

// Add a simple health check
app.get("/health", (c) => {
  return c.json({ status: "ok", server: "example-mcp-server" });
});

const port = 3001;

export default app;

// If running directly (not imported), start the server
if (import.meta.main) {
  console.log(`Starting MCP server on port ${port}...`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  Bun.serve({
    port: 3001,
    fetch: app.fetch,
  });
}
