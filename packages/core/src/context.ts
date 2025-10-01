import type { AuthInfo } from "./auth.js";
import { METHODS, SUPPORTED_MCP_PROTOCOL_VERSION } from "./constants.js";
import { RpcError } from "./errors.js";
import type {
  ElicitationResult,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcReq,
  JsonRpcRes,
  MCPServerContext,
  ProgressToken,
  ProgressUpdate,
  SamplingParams,
  SamplingResult,
  SchemaAdapter,
} from "./types.js";
import { isSamplingResult, JSON_RPC_ERROR_CODES } from "./types.js";
import { isObject, objectWithKey } from "./utils.js";
import {
  createValidationFunction,
  resolveToolSchema,
  toElicitationRequestedSchema,
} from "./validation.js";

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

  // Add these for elicit implementation
  schemaAdapter?: SchemaAdapter;
  clientRequestSender?: (
    sessionId: string | undefined,
    request: JsonRpcReq,
    options?: { relatedRequestId?: string | number; timeout_ms?: number },
  ) => Promise<JsonRpcRes>;
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
      params: { message: string; schema: unknown },
      elicitOptions?: { timeout_ms?: number; strict?: boolean },
    ): Promise<ElicitationResult> => {
      // 1. Guard: check elicitation support
      if (!context.client.supports("elicitation")) {
        throw new RpcError(
          JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          "Elicitation not supported by client",
        );
      }

      // 2. Convert schema to JSON Schema if needed
      const { mcpInputSchema } = resolveToolSchema(
        params.schema,
        options.schemaAdapter,
      );

      // 3. Project to elicitation-compatible schema
      const requestedSchema = toElicitationRequestedSchema(
        mcpInputSchema,
        elicitOptions?.strict,
      );

      // 4. Build JSON-RPC request
      const elicitRequest: JsonRpcReq = {
        jsonrpc: "2.0",
        id: Math.random().toString(36).substring(7),
        method: METHODS.ELICITATION.CREATE,
        params: {
          message: params.message,
          requestedSchema,
        },
      };

      // 5. Send request to client
      if (!options.clientRequestSender) {
        throw new RpcError(
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          "Client request sender not configured",
        );
      }

      const response = await options.clientRequestSender(
        context.session?.id,
        elicitRequest,
        {
          relatedRequestId: requestId as string | number,
          timeout_ms: elicitOptions?.timeout_ms,
        },
      );

      // 6. Validate and return response
      if (response.error) {
        throw new RpcError(
          response.error.code,
          response.error.message,
          response.error.data,
        );
      }

      return response.result as ElicitationResult;
    },
    sample: async (
      params: SamplingParams,
      sampleOptions?: { timeout_ms: number },
    ): Promise<SamplingResult> => {
      // 1. Guard: check elicitation support
      if (!context.client.supports("sampling")) {
        throw new RpcError(
          JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          "Sampling not supported by client",
        );
      }

      // 4. Build JSON-RPC request
      const elicitRequest: JsonRpcReq = {
        jsonrpc: "2.0",
        id: Math.random().toString(36).substring(7),
        method: METHODS.SAMPLING.CREATE,
        params: {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: params.prompt,
              },
            },
          ],
          modelPreferences: params.modelPreferences,
          systemPrompt: params.systemPrompt,
          maxTokens: params.maxTokens,
        },
      };

      // 5. Send request to client
      if (!options.clientRequestSender) {
        throw new RpcError(
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          "Client request sender not configured",
        );
      }

      const response = await options.clientRequestSender(
        context.session?.id,
        elicitRequest,
        {
          relatedRequestId: requestId as string | number,
          timeout_ms: sampleOptions?.timeout_ms,
        },
      );

      // 6. Validate and return response
      if (response.error) {
        throw new RpcError(
          response.error.code,
          response.error.message,
          response.error.data,
        );
      }

      if (!isSamplingResult(response.result)) {
        // TODO - use logger once we put it on context
        // TODO - Tighten up this RPC Error
        throw new RpcError(
          -32602, // Invalid params (investigate another error code)
          "Unexpected sampling response format from client",
        );
      }

      return response.result;
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
