/**
 * Optional in-process server harness for testing
 */

import type { McpServer, SessionAdapter } from "mcp-lite";
import { InMemorySessionAdapter, StreamableHttpTransport } from "mcp-lite";
import type { TestServer } from "./types.js";

export interface TestHarnessOptions {
  /** Fixed session ID generator for deterministic testing */
  sessionId?: string;
  /** Session adapter instance */
  sessionAdapter?: SessionAdapter;
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
  const { sessionId, sessionAdapter, port = 0 } = options;

  const transportOptions: ConstructorParameters<
    typeof StreamableHttpTransport
  >[0] = {};

  if (sessionId !== undefined) {
    // Session-based transport with fixed session ID
    const adapter =
      sessionAdapter ||
      new InMemorySessionAdapter({ maxEventBufferSize: 1024 });

    // Override the generateSessionId method to return the fixed sessionId
    adapter.generateSessionId = () => sessionId;
    transportOptions.sessionAdapter = adapter;
  } else if (sessionAdapter !== undefined) {
    // Session-based with random IDs
    transportOptions.sessionAdapter = sessionAdapter;
  }

  // If neither sessionId nor sessionAdapter are provided, create stateless transport
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
