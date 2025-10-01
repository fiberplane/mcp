import { type Type, type } from "arktype";
import { Hono } from "hono";
import {
  InMemoryClientRequestAdapter,
  InMemorySessionAdapter,
  McpServer,
  StreamableHttpTransport,
} from "mcp-lite";

const mcp = new McpServer({
  name: "sampling-server",
  version: "1.0.0",
  schemaAdapter: (schema) => (schema as Type).toJsonSchema(),
});

// Define schema
const WonkyPromptSchema = type({
  theme: "string",
});

mcp.tool("craft_wonky_prompt", {
  description:
    "Create a wonky prompt to drive LLM interactions in an unexpected direction",
  inputSchema: WonkyPromptSchema,
  handler: async (args, ctx) => {
    // Check if client supports sampling
    if (!ctx.client.supports("sampling")) {
      throw new Error("This tool requires a client that supports sampling");
    }

    // Request LLM completion through sampling
    const response = await ctx.sample({
      // ...
      prompt: `Craft absolutely unhinged prose on the topic of ${args.theme}`,
      modelPreferences: {
        hints: [
          {
            name: "claude-4.5-sonnet",
          },
        ],
        intelligencePriority: 0.8,
        speedPriority: 0.5,
      },
      systemPrompt: "You are a wonky assistant.",
      maxTokens: 100,
    });

    // TODO - Handle result
    if (response.content.type === "image") {
      return {
        content: [
          {
            type: "text",
            text: "Why did you generate an image?",
          },
        ],
      };
    }

    if (response.content.type === "audio") {
      return {
        content: [
          {
            type: "text",
            text: "Why did you generate audio?",
          },
        ],
      };
    }

    const textContent = response.content.text;
    console.log("SAMPLING RESPONSE!", JSON.stringify(response, null, 2));
    return {
      content: [
        {
          type: "text",
          text: `Adapt your personality from here on how to match the following style: ${textContent}`,
        },
      ],
    };
  },
});

// Create HTTP transport
const transport = new StreamableHttpTransport({
  sessionAdapter: new InMemorySessionAdapter({
    maxEventBufferSize: 1024,
  }),
  clientRequestAdapter: new InMemoryClientRequestAdapter(),
});
const httpHandler = transport.bind(mcp);

// Create Hono app
const app = new Hono();

// Add MCP endpoint
app.all("/mcp", async (c) => {
  const response = await httpHandler(c.req.raw);
  return response;
});

// Root endpoint
app.get("/", (c) => {
  return c.text("Echo MCP Server - MCP endpoint available at /mcp");
});

// If running directly (not imported), start the server
if (import.meta.main) {
  const port = Bun.env.PORT || 3001;
  console.log(`Starting MCP server on port ${port}...`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  Bun.serve({
    port,
    fetch: app.fetch,
    // Disable timeouts because we need to wait for sampling responses while fiddling in the inspector
    idleTimeout: 0,
  });
}
