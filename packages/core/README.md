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

## Sessions, SSE, and Session Adapters

Streamable HTTP transport supports two operational modes:

### Stateless Mode (Default)
No session support, no GET endpoint for SSE streaming.

```typescript
import { StreamableHttpTransport } from "mcp-lite";

// Stateless mode - no session management
const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);
```

### Stateful Mode with Sessions
Enable sessions and SSE streaming by providing a `SessionAdapter`:

```typescript
import { StreamableHttpTransport, InMemorySessionAdapter } from "mcp-lite";

// Stateful mode with sessions and SSE support
const transport = new StreamableHttpTransport({
  sessionAdapter: new InMemorySessionAdapter({
    maxEventBufferSize: 1024  
  })
});

const httpHandler = transport.bind(mcp);
```

### Custom Session Adapters
Implement the `SessionAdapter` interface for custom session storage:

```typescript
import type { SessionAdapter, SessionMeta, SessionData, EventId } from "mcp-lite";

class CustomSessionAdapter implements SessionAdapter {
  generateSessionId(): string {
    return crypto.randomUUID();
  }

  // Implement session storage methods...
  async create(id: string, meta: SessionMeta): Promise<SessionData> { /* ... */ }
  async has(id: string): Promise<boolean> { /* ... */ }
  async get(id: string): Promise<SessionData | undefined> { /* ... */ }
  async appendEvent(id: string, streamId: string, message: unknown): Promise<EventId | undefined> { /* ... */ }
  async replay(id: string, lastEventId: EventId, write: (eventId: EventId, message: unknown) => Promise<void> | void): Promise<void> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
}
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

## Elicitation

Elicitation enables MCP servers to request input from the client on behalf of the user during tool execution. This allows tools to gather additional information, confirm sensitive operations, or present choices to users through the connected AI application.

### Usage Example

```typescript
import { z } from "zod";

const DeleteRecordSchema = z.object({
  recordId: z.string(),
  tableName: z.string(),
});

mcp.tool("delete_database_record", {
  description: "Delete a database record with user confirmation",
  inputSchema: DeleteRecordSchema,
  handler: async (args, ctx) => {
    // Check if client supports elicitation
    if (!ctx.client.supports("elicitation")) {
      throw new Error("This tool requires a client that supports elicitation");
    }

    // Request user confirmation through elicitation
    const response = await ctx.elicit({
      type: "confirmation",
      title: "Confirm Record Deletion",
      description: `Are you sure you want to delete record "${args.recordId}" from table "${args.tableName}"? This action cannot be undone.`,
      confirmationText: "Delete Record",
      cancelText: "Cancel"
    });

    // Handle different response types
    switch (response.type) {
      case "accept":
        // User confirmed - proceed with deletion
        await deleteFromDatabase(args.tableName, args.recordId);
        return {
          content: [{ 
            type: "text", 
            text: `Record "${args.recordId}" has been deleted from "${args.tableName}".` 
          }],
        };
      
      case "decline":
        return {
          content: [{ 
            type: "text", 
            text: "Record deletion cancelled by user." 
          }],
        };
      
      case "cancel":
        throw new Error("Operation was cancelled");
      
      default:
        throw new Error("Unexpected elicitation response");
    }
  },
});
```

### Setup Instructions

To use elicitation, configure your transport with a `ClientRequestAdapter` alongside your `SessionAdapter`:

```typescript
import { 
  StreamableHttpTransport, 
  InMemorySessionAdapter, 
  InMemoryClientRequestAdapter 
} from "mcp-lite";

const transport = new StreamableHttpTransport({
  sessionAdapter: new InMemorySessionAdapter({
    maxEventBufferSize: 1024
  }),
  clientRequestAdapter: new InMemoryClientRequestAdapter({
    defaultTimeoutMs: 30000  // 30 second timeout for server-to-client requests
  })
});

const httpHandler = transport.bind(mcp);
```

The `ClientRequestAdapter` manages pending server-to-client requests (such as elicitation), storing them temporarily while waiting for client responses. This enables the server to pause execution, send a request to the client, and resume once the client provides a response.

### Advanced Example: Cloudflare KV Adapter

For distributed deployments where multiple worker instances might handle different parts of the same session, implement a custom `ClientRequestAdapter` using persistent storage and polling:

```typescript
import type { ClientRequestAdapter } from "mcp-lite";

interface PendingRequest {
  timestamp: number;
  timeoutMs: number;
  status: 'pending' | 'resolved' | 'rejected';
  response?: unknown;
  error?: string;
}

export class CloudflareKVClientRequestAdapter implements ClientRequestAdapter {
  private localPending = new Map<string, { 
    resolve: (value: unknown) => void; 
    reject: (reason?: unknown) => void;
    pollInterval?: ReturnType<typeof setInterval>;
  }>();

  constructor(
    private kv: KVNamespace,
    private defaultTimeoutMs: number = 30000,
    private pollIntervalMs: number = 1000
  ) {}

  createPending(
    sessionId: string | undefined,
    requestId: string | number,
    options?: { timeout_ms?: number }
  ): { promise: Promise<unknown> } {
    const key = `${sessionId ?? ""}:${String(requestId)}`;
    const timeoutMs = options?.timeout_ms ?? this.defaultTimeoutMs;

    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // Store pending request metadata in KV
    const pendingRequest: PendingRequest = {
      timestamp: Date.now(),
      timeoutMs,
      status: 'pending'
    };

    this.kv.put(`pending:${key}`, JSON.stringify(pendingRequest), {
      expirationTtl: Math.ceil(timeoutMs / 1000) + 60 // Extra buffer for cleanup
    });

    // Store local handlers for this instance
    const localEntry = { resolve, reject };
    this.localPending.set(key, localEntry);

    // Start polling for response from other instances
    const pollInterval = setInterval(async () => {
      try {
        const stored = await this.kv.get(`pending:${key}`, 'json') as PendingRequest | null;
        
        if (!stored) {
          // Request was cleaned up, likely timed out
          this.cleanupLocal(key, new Error('Request not found'));
          return;
        }

        if (stored.status === 'resolved') {
          this.cleanupLocal(key, null, stored.response);
          await this.kv.delete(`pending:${key}`);
        } else if (stored.status === 'rejected') {
          this.cleanupLocal(key, new Error(stored.error || 'Request rejected'));
          await this.kv.delete(`pending:${key}`);
        } else if (Date.now() - stored.timestamp > stored.timeoutMs) {
          // Timeout
          stored.status = 'rejected';
          stored.error = 'Timeout';
          await this.kv.put(`pending:${key}`, JSON.stringify(stored));
          this.cleanupLocal(key, new Error('Timeout'));
        }
      } catch (error) {
        this.cleanupLocal(key, error instanceof Error ? error : new Error('Polling error'));
      }
    }, this.pollIntervalMs);

    localEntry.pollInterval = pollInterval;

    return { promise };
  }

  resolvePending(
    sessionId: string | undefined,
    requestId: string | number,
    response: unknown
  ): boolean {
    const key = `${sessionId ?? ""}:${String(requestId)}`;
    
    // Check if we have a local handler
    const localEntry = this.localPending.get(key);
    if (localEntry) {
      this.cleanupLocal(key, null, response);
      return true;
    }

    // Update KV for other instances to pick up
    this.updateKVResponse(key, 'resolved', response);
    return false; // We didn't have a local handler, but updated KV
  }

  rejectPending(
    sessionId: string | undefined,
    requestId: string | number,
    reason: unknown
  ): boolean {
    const key = `${sessionId ?? ""}:${String(requestId)}`;
    
    // Check if we have a local handler
    const localEntry = this.localPending.get(key);
    if (localEntry) {
      this.cleanupLocal(key, reason instanceof Error ? reason : new Error(String(reason)));
      return true;
    }

    // Update KV for other instances to pick up
    this.updateKVResponse(key, 'rejected', undefined, String(reason));
    return false; // We didn't have a local handler, but updated KV
  }

  private cleanupLocal(
    key: string, 
    error: unknown, 
    response?: unknown
  ): void {
    const entry = this.localPending.get(key);
    if (!entry) return;

    if (entry.pollInterval) {
      clearInterval(entry.pollInterval);
    }
    
    this.localPending.delete(key);

    if (error) {
      entry.reject(error);
    } else {
      entry.resolve(response);
    }
  }

  private async updateKVResponse(
    key: string,
    status: 'resolved' | 'rejected',
    response?: unknown,
    error?: string
  ): Promise<void> {
    try {
      const stored = await this.kv.get(`pending:${key}`, 'json') as PendingRequest | null;
      if (stored && stored.status === 'pending') {
        stored.status = status;
        if (response !== undefined) {
          stored.response = response;
        }
        if (error) {
          stored.error = error;
        }
        await this.kv.put(`pending:${key}`, JSON.stringify(stored));
      }
    } catch (err) {
      console.error('Failed to update KV response:', err);
    }
  }
}

// Usage in Cloudflare Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const transport = new StreamableHttpTransport({
      sessionAdapter: new InMemorySessionAdapter({
        maxEventBufferSize: 1024
      }),
      clientRequestAdapter: new CloudflareKVClientRequestAdapter(
        env.PENDING_REQUESTS_KV,
        30000,  // 30s timeout
        1000    // 1s poll interval
      )
    });

    const httpHandler = transport.bind(mcp);
    return await httpHandler(request);
  }
};
```

This distributed adapter works by:
1. **Storing request metadata in KV** - Only serializable data
2. **Keeping local promise handlers** - In the instance that created the request
3. **Polling for responses** - Each instance polls KV to see if responses arrived
4. **Cross-instance coordination** - Any instance can resolve/reject requests by updating KV
5. **Automatic cleanup** - Handles timeouts and cleans up both local state and KV entries

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