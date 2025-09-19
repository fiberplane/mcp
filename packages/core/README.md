# `mcp-lite`

A small, simple, web-first framework for building MCP servers.

> [!TIP]
>
> The Model Context Protocol (MCP) is an open standard that enables secure connections between host applications and external data sources and tools, allowing AI assistants to reason over information and execute functions with user permission.

## Features
- Lightweight and zero dependencies
- Supports Streamable HTTP transport
- Composable middleware system
- Standard Schema validation (Zod, Valibot, etc.)
- Type-safe tool, resource, and prompt registration

## Installation

```bash
npm install mcp-lite
# or
bun add mcp-lite
# or
pnpm add mcp-lite
```

## Quick Start

```typescript
import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";

// Create MCP server with Zod schema adapter
const mcp = new McpServer({
  name: "example-server",
  version: "1.0.0",
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
});

// Define schema
const EchoSchema = z.object({
  message: z.string(),
});

// Add a tool
mcp.tool("echo", {
  description: "Echoes the input message",
  inputSchema: EchoSchema,
  handler: (args) => ({
    // args is automatically typed as { message: string }
    content: [{ type: "text", text: args.message }],
  }),
});

// Create HTTP transport
const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

// Integrate with HTTP framework
const app = new Hono();
app.all("/mcp", async (c) => {
  const response = await httpHandler(c.req.raw);
  return response;
});
```

## Creating an MCP Server

Basic constructor usage:

```typescript
import { McpServer } from "mcp-lite";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});
```

### Using a Schema Adapter

Schema adapters are needed when using Standard Schema validators (like Zod or Valibot) to convert them to JSON Schema format that MCP clients can understand.

#### With Zod schema adapter:
```typescript
import { z } from "zod";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
});
```

#### Without schema adapter (JSON Schema only):
```typescript
const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});
```

## Connecting with Hono

```typescript
import { Hono } from "hono";
import { StreamableHttpTransport } from "mcp-lite";

// Create transport and bind server
const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

// Setup Hono app with MCP endpoint
const app = new Hono();
app.all("/mcp", async (c) => {
  const response = await httpHandler(c.req.raw);
  return response;
});
```

## Sessions, SSE, and SessionStore

Streamable HTTP transport supports server-sent events (SSE) for streaming progress and responses. The transport manages per-session state via a SessionStore.

- Default store: `InMemorySessionStore({ maxEventBufferSize: 1024 })`
- Configure a custom store by passing `sessionStore` to `StreamableHttpTransport`
- You can also provide `generateSessionId` to control session identifiers

```typescript
import { StreamableHttpTransport, InMemorySessionStore } from "mcp-lite";

const transport = new StreamableHttpTransport({
  generateSessionId: () => crypto.randomUUID(),
  // InMemorySessionStore is the default; configure only if you need to override
  sessionStore: new InMemorySessionStore({ maxEventBufferSize: 1024 })
});

const httpHandler = transport.bind(mcp);
```
## Tools

### Basic Tool with JSON Schema

```typescript
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
```

### Tool with Standard Schema (Zod)

```typescript
import { z } from "zod";

const AddSchema = z.object({
  a: z.number(),
  b: z.number(),
});

mcp.tool("add", {
  description: "Adds two numbers",
  inputSchema: AddSchema,
  handler: (args: z.infer<typeof AddSchema>) => ({
    content: [{ type: "text", text: String(args.a + args.b) }],
  }),
});
```

### Tool without Schema

```typescript
mcp.tool("status", {
  description: "Returns server status",
  handler: () => ({
    content: [{ type: "text", text: "Server is running" }],
  }),
});
```

## Resources

### Static Resource

```typescript
mcp.resource(
  "file://config.json",
  {
    name: "App Configuration",
    description: "Application configuration file",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      type: "text",
      text: JSON.stringify({ name: "my-app" }),
      mimeType: "application/json",
    }],
  })
);
```

### Templated Resource with URI Patterns

```typescript
mcp.resource(
  "github://repos/{owner}/{repo}",
  { description: "GitHub repository" },
  async (uri, { owner, repo }) => ({
    contents: [{
      uri: uri.href,
      type: "text", 
      text: `Repository: ${owner}/${repo}`,
    }],
  })
);
```

## Prompts

### Basic Prompt

```typescript
mcp.prompt("greet", {
  description: "Generate a greeting message",
  handler: () => ({
    messages: [{
      role: "user",
      content: { type: "text", text: "Hello, how are you?" }
    }]
  }),
});
```

### Prompt with Arguments and Schema

```typescript
import { z } from "zod";

const SummarySchema = z.object({
  text: z.string(),
  length: z.enum(["short", "medium", "long"]).optional(),
});

mcp.prompt("summarize", {
  description: "Create a summary prompt",
  arguments: SummarySchema,
  handler: (args: z.infer<typeof SummarySchema>) => ({
    description: "Summarization prompt",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Please summarize: ${args.text}`
      }
    }]
  }),
});
```

## Middleware

Basic middleware pattern for logging, authentication, or request processing:

```typescript
// Logging middleware
mcp.use(async (ctx, next) => {
  console.log(`Request: ${ctx.request.method}`);
  await next();
});

// Authentication middleware
mcp.use(async (ctx, next) => {
  // Access request context
  ctx.state.user = "authenticated-user";
  await next();
});
```

## Error Handling

```typescript
import { RpcError, JSON_RPC_ERROR_CODES } from "mcp-lite";

mcp.tool("divide", {
  description: "Divides two numbers",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
  },
  handler: (args: { a: number; b: number }) => {
    if (args.b === 0) {
      throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, "Division by zero");
    }
    return {
      content: [{ type: "text", text: String(args.a / args.b) }],
    };
  },
});
```

## Protocol Information

This framework supports MCP protocol version `2025-06-18` with full JSON-RPC 2.0 compliance.

## Examples

See the `playground/` directory for complete working examples demonstrating all features.