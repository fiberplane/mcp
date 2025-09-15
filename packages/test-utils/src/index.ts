// Type for JSON-RPC response
export interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Interface for server creation
export interface TestServer {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Creates a test server from an example's entry point
 * @param entryResolver Function that resolves to the example's server creation function or Hono app
 * @param port Optional port (defaults to 0 for random available port)
 * @returns Promise resolving to server URL and stop function
 */
export async function createExampleServer(
  entryResolver: () => Promise<unknown>,
  port = 0,
): Promise<TestServer> {
  const entry = await entryResolver();

  // Handle both Hono app exports and server creation functions
  const app =
    typeof entry === "function"
      ? entry()
      : entry && typeof entry === "object" && "default" in entry
        ? entry.default
        : entry;

  if (!app || typeof app.fetch !== "function") {
    throw new Error(
      "Entry point must export a Hono app or function that returns one",
    );
  }

  // Start the server
  const server = Bun.serve({
    port,
    fetch: app.fetch.bind(app),
  });

  const url = `http://localhost:${server.port}/mcp`;

  return {
    url,
    stop: async () => {
      server.stop();
    },
  };
}

/**
 * Creates a simple JSON-RPC client for testing MCP servers
 * @param baseUrl The base URL of the MCP server endpoint
 * @returns Function to make JSON-RPC requests
 */
export function createJsonRpcClient(baseUrl: string) {
  return async function request(
    method: string,
    params?: unknown,
    id: string | number = Math.random().toString(36).substring(7),
  ): Promise<JsonRpcResponse> {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as JsonRpcResponse;

    if (result.error) {
      const error = new Error(
        `JSON-RPC Error ${result.error.code}: ${result.error.message}`,
      ) as Error & {
        code: number;
        data?: unknown;
      };
      error.code = result.error.code;
      error.data = result.error.data;
      throw error;
    }

    return result;
  };
}

/**
 * Waits for a URL to be ready by polling it
 * @param url URL to check
 * @param maxAttempts Maximum number of attempts
 * @param delayMs Delay between attempts in milliseconds
 */
export async function waitForReady(
  url: string,
  maxAttempts = 10,
  delayMs = 100,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore errors and try again
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `URL ${url} did not become ready after ${maxAttempts} attempts`,
  );
}

// Export test harness utilities
export {
  createTestHarness,
  type TestHarnessOptions,
} from "./harness.js";

// Export MCP client utilities
export {
  closeSession,
  createMcpClient,
  initializeSession,
  type McpClientOptions,
  type McpSession,
  openRequestStream,
  openSessionStream,
} from "./mcp-client.js";
// Export SSE utilities
export {
  collectSseEvents,
  collectSseEventsCount,
  readSse,
  readSseUntil,
  type SseEvent,
} from "./sse.js";
