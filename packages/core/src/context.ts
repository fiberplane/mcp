import type { AuthInfo } from "./auth.js";
import { SUPPORTED_MCP_PROTOCOL_VERSION } from "./constants.js";
import type {
  ElicitationResult,
  JsonRpcId,
  JsonRpcMessage,
  MCPServerContext,
  ProgressToken,
  ProgressUpdate,
} from "./types.js";
import { isObject, objectWithKey } from "./utils.js";
import { createValidationFunction } from "./validation.js";

export interface CreateContextOptions {
  sessionId?: string;
  progressToken?: ProgressToken;
  progressSender?: (update: ProgressUpdate) => Promise<void> | void;
  authInfo?: AuthInfo;
  clientCapabilities?: {
    elicitation?: Record<string, never>;
    roots?: Record<string, never>;
    sampling?: Record<string, never>;
    [key: string]: unknown;
  };
}

/**
 * Extract progress token from a JSON-RPC message.
 */
export function getProgressToken(
  message: JsonRpcMessage,
): ProgressToken | undefined {
  if (isObject(message.params)) {
    const params = message.params as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown> | undefined;
    if (objectWithKey(meta, "progressToken")) {
      return meta.progressToken as ProgressToken;
    }
  }
  return undefined;
}

export function createContext(
  message: JsonRpcMessage,
  requestId: JsonRpcId | undefined,
  options: CreateContextOptions = {},
): MCPServerContext {
  // Prefer explicit option, otherwise derive from the request message
  const progressToken =
    options.progressToken !== undefined
      ? options.progressToken
      : getProgressToken(message);

  const context: MCPServerContext = {
    request: message,
    authInfo: options.authInfo,
    requestId,
    response: null,
    env: {},
    state: {},
    progressToken,
    validate: <T>(validator: unknown, input: unknown): T =>
      createValidationFunction<T>(validator, input),
    client: {
      supports: (
        feature: "elicitation" | "roots" | "sampling" | string,
      ): boolean => {
        // Real implementation will be injected in _dispatch if capabilities are available
        if (options.clientCapabilities) {
          return feature in options.clientCapabilities;
        }
        return false;
      },
    },
    elicit: async (
      _params: { message: string; schema: unknown },
      _options?: { timeout_ms?: number; strict?: boolean },
    ): Promise<ElicitationResult> => {
      throw new Error("elicit() method not implemented in Phase 1");
    },
  };

  if (progressToken && options.progressSender) {
    context.progress = async (update: ProgressUpdate): Promise<void> => {
      await options.progressSender?.(update);
    };
  }

  if (options.sessionId) {
    context.session = {
      id: options.sessionId,
      protocolVersion: SUPPORTED_MCP_PROTOCOL_VERSION,
    };
  }

  return context;
}
