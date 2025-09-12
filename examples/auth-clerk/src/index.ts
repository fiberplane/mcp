import { Hono } from "hono";
import { logger } from "hono/logger";
import { mcpAuthMiddleware } from "./auth/middleware";
import { authRoutes } from "./auth/routes";
import { httpHandler as mcpHttpHandler } from "./mcp";
import type { AppType } from "./types";

// Create a Hono app to serve our api routes
const app = new Hono<AppType>();

// Set up a logger to log requests
app.use(logger());

// Mount the `.well-known` routes for OAuth discovery to work
app.route("/", authRoutes);

// Add MCP endpoint
app.all("/mcp", mcpAuthMiddleware, async (c) => {
  const response = await mcpHttpHandler(c.req.raw);
  return response;
});

// Root route describing where to find the MCP endpoint
app.get("/", (c) => {
  return c.text(
    "This is Authenticated MCP Server\n\nConnect to /mcp with your MCP client to start the auth flow",
  );
});

export default app;
