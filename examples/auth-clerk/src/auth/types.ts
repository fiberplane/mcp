/**
 * Minimal AuthInfo shape that resembles the @modelcontextprotocol/sdk AuthInfo type:
 *
 * ```typescript
 * import { AuthInfo } from "@modelcontextprotocol/sdk/types.js";
 * ```
 */
export type AuthInfo = {
  token: string;
  /** Seconds since epoch */
  expiresAt?: number;
  scopes: string[];
  /** Additional provider-specific data */
  extra?: Record<string, unknown>;
};
