import { createClerkClient } from "@clerk/backend";
import { TokenType } from "@clerk/backend/internal";
import { verifyClerkToken } from "@clerk/mcp-tools/server";
import { createMiddleware } from "hono/factory";
import type { AppType } from "../types";
import type { AuthInfo } from "./types";
import { getPRMUrl } from "./utils";

/**
 * Create auth middleware for the MCP server.
 * This should be run on all "/mcp" requests.
 *
 * Sets the "auth" variable on the request context
 */
export const mcpAuthMiddleware = createMiddleware<
  AppType & { Variables: { auth: AuthInfo } }
>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const [type, token] = authHeader?.split(" ") || [];
  const bearerToken = type?.toLowerCase() === "bearer" ? token : undefined;

  // Return 401 with proper www-authenticate header if no authorization is provided
  if (!bearerToken) {
    // Get the resource metadata url for the protected resource
    // We return this in the `WWW-Authenticate` header so the MCP client knows where to find the protected resource metadata
    const resourceMetadataUrl = getPRMUrl(c.req.raw);
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl}"`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const secretKey = c.env.CLERK_SECRET_KEY || "";
    const publishableKey = c.env.CLERK_PUBLISHABLE_KEY || "";

    const clerkClient = createClerkClient({
      secretKey,
      publishableKey,
    });

    const requestState = await clerkClient.authenticateRequest(c.req.raw, {
      secretKey,
      publishableKey,
      acceptsToken: TokenType.OAuthToken,
    });

    // This is the result of the authenticateRequest call, with the `TokenType.OAuthToken` type
    const auth = requestState.toAuth();

    // TODO - We could probably implement `verifyClerkToken` ourselves, to have clearer control over error paths and error logging
    //        (the library implementation uses console.error for logging)
    //
    // Source code for verifyClerkToken:
    // https://github.com/clerk/mcp-tools/blob/b0c946c97c41f248289c31174d0d5c84e977c55c/server.ts#L103
    const authInfo = verifyClerkToken(auth, token);

    // Require valid auth for this endpoint
    if (!authInfo) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Attach auth to Request and Hono context for downstream handlers
    c.set("auth", authInfo);

    await next();
  } catch (error) {
    console.error("Unexpected mcp auth middleware error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
