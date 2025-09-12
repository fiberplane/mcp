// https://github.com/clerk/mcp-tools
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
} from "@clerk/mcp-tools/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppType } from "../types";
import { getResourceUrl } from "./utils";

/**
 * Create middleware to handle CORS for the OAuth endpoints,
 * this is useful for testing auth from a browser-based MCP client,
 * or the MCP inspector (`bunx @modelcontextprotocol/inspector`)
 *
 * @note We convert the CORS headers that we get from the @clerk/mcp-tools library
 *       into a format that Hono middleware can understand
 *
 * @see https://github.com/clerk/mcp-tools/blob/main/server.ts
 */
const oauthCorsMiddleware = cors({
  origin: corsHeaders["Access-Control-Allow-Origin"],
  // HACK - split the comma-separated list of methods into an array
  allowMethods: corsHeaders["Access-Control-Allow-Methods"].split(","),
  allowHeaders: [corsHeaders["Access-Control-Allow-Headers"]],
  maxAge: parseInt(corsHeaders["Access-Control-Max-Age"], 10),
});

export const authRoutes = new Hono<AppType>();

/**
 * Implement the OAuth Protected Resource endpoint
 *
 * We define the "OPTIONS" method to handle preflight requests with the CORS middleware
 *
 * @note - This expects that the resource URL we are protecting is the `/mcp` endpoint
 */
authRoutes.on(
  ["GET", "OPTIONS"],
  ".well-known/oauth-protected-resource",
  oauthCorsMiddleware,
  (c) => {
    if (!c.env.CLERK_PUBLISHABLE_KEY) {
      console.error(
        "CLERK_PUBLISHABLE_KEY is not set for OAuth Authorization Server endpoint",
      );
      return c.json({ error: "Internal Server Error" }, 500);
    }

    // NOTE - The resource URL we are protecting is the `/mcp` endpoint
    // const req = c.req.raw;
    // const url = new URL(req.url);
    // const resourceUrl = `${url.origin}/mcp`;

    const resourceUrl = getResourceUrl(c.req.raw);

    const result = generateClerkProtectedResourceMetadata({
      publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
      resourceUrl,
    });

    return c.json(result);
  },
);

authRoutes.on(
  ["GET", "OPTIONS"],
  "/.well-known/oauth-protected-resource/mcp",
  oauthCorsMiddleware,
  (c) => {
    const resourceUrl = getResourceUrl(c.req.raw);

    const result = generateClerkProtectedResourceMetadata({
      publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
      resourceUrl,
      properties: {
        scopes_supported: ["profile", "email"],
      },
    });

    return c.json(result);
  },
);

/**
 * Implement the OAuth Authorization Server endpoint
 *
 * We define the "OPTIONS" method to handle preflight requests with the CORS middleware
 *
 * @note - In our case, Clerk is the authorization server, so we shouldn't *need* to implement this;
 *         however, in earlier versions of the MCP spec (prior to 2025-06-18), this route was expected/required,
 *         so we implement it for backwards compatibility with clients.
 */
authRoutes.on(
  ["GET", "OPTIONS"],
  ".well-known/oauth-authorization-server",
  oauthCorsMiddleware,
  async (c) => {
    if (!c.env.CLERK_PUBLISHABLE_KEY) {
      console.error(
        "CLERK_PUBLISHABLE_KEY is not set for OAuth Authorization Server endpoint",
      );
      return c.json({ error: "Internal Server Error" }, 500);
    }

    // NOTE - If your CLERK_PUBLISHABLE_KEY is misconfigured, this *will* result in a 500
    const result = await fetchClerkAuthorizationServerMetadata({
      publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
    });

    return c.json(result);
  },
);
