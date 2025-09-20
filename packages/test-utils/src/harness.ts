/**
 * Optional in-process server harness for testing
 */

import type { McpServer, SessionStore } from "mcp-lite";
import { InMemorySessionAdapter, StreamableHttpTransport } from "mcp-lite";
import type { TestServer } from "./index.js";

export interface TestHarnessOptions {
  /** Fixed session ID generator for deterministic testing */
  sessionId?: string;
  /** Session store instance */
  sessionStore?: SessionStore;
  /** Port for server (defaults to 0 for random) */
  port?: number;
}

/**
 * Create an in-process test harness with a real HTTP server and transport
 */
export async function createTestHarness(
  server: McpServer,
  options: TestHarnessOptions = {},
): Promise<TestServer> {
  const { sessionId, sessionStore, port = 0 } = options;

  const transportOptions: ConstructorParameters<
    typeof StreamableHttpTransport
  >[0] = {};

  if (sessionId !== undefined) {
    // Session-based transport with fixed session ID
    const adapter =
      sessionStore instanceof InMemorySessionAdapter
        ? sessionStore
        : new InMemorySessionAdapter({ maxEventBufferSize: 1024 });

    // Override the generateSessionId method to return the fixed sessionId
    adapter.generateSessionId = () => sessionId;
    transportOptions.sessionAdapter = adapter;
  } else if (sessionStore !== undefined) {
    // Session-based with random IDs
    if (sessionStore instanceof InMemorySessionAdapter) {
      transportOptions.sessionAdapter = sessionStore;
    } else {
      // Convert SessionStore to SessionAdapter
      const adapter = new InMemorySessionAdapter({ maxEventBufferSize: 1024 });
      transportOptions.sessionAdapter = adapter;
    }
  }
  // If neither sessionId nor sessionStore are provided, create stateless transport

  const transport = new StreamableHttpTransport(transportOptions);

  const handler = transport.bind(server);

  // Create Bun server
  const bunServer = Bun.serve({
    port,
    fetch: handler,
  });

  const url = `http://localhost:${bunServer.port}`;

  return {
    url,
    stop: async () => {
      bunServer.stop();
    },
  };
}
