import type { AuthInfo } from "../auth.js";
import type { ClientRequestAdapter } from "../client-request-adapter.js";
import {
  JSON_RPC_VERSION,
  MCP_LAST_EVENT_ID_HEADER,
  MCP_PROTOCOL_HEADER,
  MCP_SESSION_ID_HEADER,
  SSE_ACCEPT_HEADER,
  SSE_STREAM_ID,
  SUPPORTED_MCP_PROTOCOL_VERSION,
} from "../constants.js";
import type { McpServer } from "../core.js";
import { RpcError } from "../errors.js";
import type { SessionAdapter, SessionMeta } from "../session-store.js";
import { createSSEStream, type StreamWriter } from "../sse-writer.js";
import {
  createJsonRpcError,
  isGlobalNotification,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JSON_RPC_ERROR_CODES,
  type JsonRpcReq,
  type JsonRpcRes,
} from "../types.js";
import {
  respondToInvalidJsonRpc,
  respondToMissingSessionId,
  respondToProtocolMismatch,
} from "./http-responses.js";

function parseJsonRpc(body: string): unknown {
  try {
    const parsed = JSON.parse(body);
    return parsed;
  } catch (_error) {
    throw new RpcError(JSON_RPC_ERROR_CODES.PARSE_ERROR, "Invalid JSON");
  }
}

export interface StreamableHttpTransportOptions {
  sessionAdapter?: SessionAdapter;
  clientRequestAdapter?: ClientRequestAdapter;
  /** Allowed Origin headers for CORS validation  */
  allowedOrigins?: string[];
  /** Allowed Host headers for preventing Host header attacks */
  allowedHosts?: string[];
}

export class StreamableHttpTransport {
  private server?: McpServer;
  private sessionAdapter?: SessionAdapter;
  private clientRequestAdapter?: ClientRequestAdapter;
  private allowedOrigins?: string[];
  private allowedHosts?: string[];
  private sessionStreams = new Map<string, StreamWriter>(); // sessionId → GET stream writer
  private requestStreams = new Map<string, StreamWriter>(); // "sessionId:requestId" → POST stream writer

  constructor(options: StreamableHttpTransportOptions = {}) {
    this.sessionAdapter = options.sessionAdapter;
    this.clientRequestAdapter = options.clientRequestAdapter;
    this.allowedOrigins = options.allowedOrigins;
    this.allowedHosts = options.allowedHosts;
  }

  private getRequestWriter(
    sessionId: string,
    requestId: string | number,
  ): StreamWriter | undefined {
    return this.requestStreams.get(`${sessionId}:${requestId}`);
  }

  private getSessionWriter(sessionId: string): StreamWriter | undefined {
    return this.sessionStreams.get(sessionId);
  }

  private cleanupSession(sessionId: string): void {
    // End and remove session stream
    const sessionWriter = this.sessionStreams.get(sessionId);
    if (sessionWriter) {
      sessionWriter.end();
    }
    this.sessionStreams.delete(sessionId);

    // End and remove all request streams for this session
    for (const [key, writer] of this.requestStreams) {
      if (key.startsWith(`${sessionId}:`)) {
        writer.end();
        this.requestStreams.delete(key);
      }
    }
  }

  private async getClientCapabilities(sessionId: string | null): Promise<
    | {
        elicitation?: Record<string, never>;
        roots?: Record<string, never>;
        sampling?: Record<string, never>;
        [key: string]: unknown;
      }
    | undefined
  > {
    if (!sessionId) {
      return undefined;
    }

    // In stateless mode (no sessionAdapter), don't advertise elicitation capability
    // since synthetic sessionId is never returned to client, causing elicitations to hang
    if (!this.sessionAdapter) {
      return {};
    }

    try {
      const sessionData = await this.sessionAdapter.get(sessionId);
      return sessionData?.meta?.clientCapabilities;
    } catch {
      return undefined;
    }
  }

  private async sendClientRequest(
    sessionId: string | undefined,
    request: JsonRpcReq,
    options?: { relatedRequestId?: string | number; timeout_ms?: number },
  ): Promise<JsonRpcRes> {
    if (!this.clientRequestAdapter) {
      throw new Error("Client request adapter not configured");
    }

    if (request.id === null || request.id === undefined) {
      throw new Error("Client request must have a valid id");
    }

    // Create pending promise for the response
    const { promise } = this.clientRequestAdapter.createPending(
      sessionId,
      request.id,
      { timeout_ms: options?.timeout_ms },
    );

    // Create JSON-RPC request message
    const jsonRpcRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id: request.id,
      method: request.method,
      params: request.params,
    };

    // Try to deliver via request stream first if relatedRequestId is provided
    let delivered = false;
    if (sessionId && options?.relatedRequestId !== undefined) {
      const requestWriter = this.getRequestWriter(
        sessionId,
        options.relatedRequestId,
      );
      if (requestWriter) {
        requestWriter.write(jsonRpcRequest);
        delivered = true;
      }
    }

    // Fallback to session stream if not delivered via request stream
    if (!delivered && sessionId) {
      const sessionWriter = this.getSessionWriter(sessionId);
      if (sessionWriter) {
        sessionWriter.write(jsonRpcRequest);
        delivered = true;
      }
    }

    if (!delivered) {
      // Reject the pending request since we couldn't deliver it
      this.clientRequestAdapter.rejectPending(
        sessionId,
        request.id, // We already checked this is not null/undefined above
        new Error("No active streams to deliver client request"),
      );
      throw new Error("No active streams to deliver client request");
    }

    return promise as Promise<JsonRpcRes>;
  }

  bind(
    server: McpServer,
  ): (
    request: Request,
    options?: { authInfo?: AuthInfo },
  ) => Promise<Response> {
    this.server = server;

    // Wire up client request sender if adapter is available
    if (this.clientRequestAdapter) {
      server._setClientRequestSender(this.sendClientRequest.bind(this));
    }

    server._setNotificationSender(async (sessionId, notification, options) => {
      const jsonRpcNotification = {
        jsonrpc: JSON_RPC_VERSION,
        method: notification.method,
        params: notification.params,
      };

      if (this.sessionAdapter) {
        const relatedRequestId = options?.relatedRequestId;

        if (sessionId) {
          // Always persist to session store for resumability (even if delivered via request stream)
          let eventId: string | undefined;
          if (this.sessionAdapter) {
            eventId = await this.sessionAdapter.appendEvent(
              sessionId,
              SSE_STREAM_ID,
              jsonRpcNotification,
            );
          }

          // Try request stream first if we have a relatedRequestId
          if (relatedRequestId !== undefined) {
            const requestWriter = this.getRequestWriter(
              sessionId,
              relatedRequestId,
            );
            if (requestWriter) {
              requestWriter.write(jsonRpcNotification); // ephemeral delivery
              return;
            }
          }

          // Fallback to session stream
          const sessionWriter = this.getSessionWriter(sessionId);
          if (sessionWriter) {
            sessionWriter.write(jsonRpcNotification, eventId);
          }
        }

        // Handle global notifications (broadcast to all sessions)
        const shouldBroadcastToAllSessions =
          !sessionId || isGlobalNotification(notification.method);
        if (shouldBroadcastToAllSessions) {
          for (const [sid, writer] of this.sessionStreams) {
            // Don't double-send to the originating session
            if (sid !== sessionId) {
              writer.write(jsonRpcNotification);
            }
          }
        }
      } else {
        // Stateless mode: deliver to request streams using synthetic session ID
        if (options?.relatedRequestId && sessionId) {
          const requestWriter = this.getRequestWriter(
            sessionId,
            options.relatedRequestId,
          );
          if (requestWriter) {
            requestWriter.write(jsonRpcNotification);
          }
        }

        // Handle global notifications in stateless mode (broadcast to all request streams)
        const shouldBroadcastToAllRequests =
          !sessionId || isGlobalNotification(notification.method);
        if (shouldBroadcastToAllRequests) {
          for (const [requestKey, writer] of this.requestStreams) {
            // Don't double-send to the originating request
            if (!sessionId || !requestKey.startsWith(`${sessionId}:`)) {
              writer.write(jsonRpcNotification);
            }
          }
        }
      }
    });

    return this.handleRequest.bind(this);
  }

  private async handleRequest(
    request: Request,
    options?: { authInfo?: AuthInfo },
  ): Promise<Response> {
    if (!this.server) {
      throw new Error("Transport not bound to a server");
    }

    if (this.allowedHosts) {
      const host = request.headers.get("Host");
      if (host && !this.allowedHosts.includes(host)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    if (this.allowedOrigins) {
      const origin = request.headers.get("Origin");
      if (origin && !this.allowedOrigins.includes(origin)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    switch (request.method) {
      case "POST":
        return this.handlePost(request, { authInfo: options?.authInfo });
      case "GET":
        return this.handleGet(request);
      case "DELETE":
        return this.handleDelete(request);
      default: {
        const errorResponse = createJsonRpcError(
          null,
          new RpcError(
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            "Method not supported",
          ).toJson(),
        );
        return new Response(JSON.stringify(errorResponse), {
          status: 405,
          headers: {
            Allow: "POST, GET, DELETE",
          },
        });
      }
    }
  }

  private async handlePost(
    request: Request,
    options?: { authInfo?: AuthInfo },
  ): Promise<Response> {
    try {
      const sessionId = request.headers.get(MCP_SESSION_ID_HEADER);
      const body = await request.text();
      const jsonRpcMessage = parseJsonRpc(body);

      // Check if it's a JSON-RPC response first
      if (isJsonRpcResponse(jsonRpcMessage)) {
        if (this.sessionAdapter && !sessionId) {
          return respondToMissingSessionId();
        }

        // Handle client response by resolving pending request
        if (
          this.clientRequestAdapter &&
          jsonRpcMessage.id !== null &&
          jsonRpcMessage.id !== undefined
        ) {
          this.clientRequestAdapter.resolvePending(
            sessionId || undefined,
            jsonRpcMessage.id,
            jsonRpcMessage,
          );
        }

        return new Response(null, { status: 202 });
      }

      if (
        !isJsonRpcNotification(jsonRpcMessage) &&
        !isJsonRpcRequest(jsonRpcMessage)
      ) {
        return respondToInvalidJsonRpc();
      }

      const isNotification = isJsonRpcNotification(jsonRpcMessage);
      const isInitializeRequest = jsonRpcMessage.method === "initialize";
      const acceptHeader = request.headers.get("Accept");
      const protocolHeader = request.headers.get(MCP_PROTOCOL_HEADER);

      // Return a protocol mismatch error if all the below are true:
      // 1. it's not an initialize request
      // 2. the protocol header is present
      // 3. the protocol header is not the supported version
      const shouldReturnProtocolMismatchError =
        !isInitializeRequest &&
        protocolHeader &&
        protocolHeader !== SUPPORTED_MCP_PROTOCOL_VERSION;
      if (shouldReturnProtocolMismatchError) {
        const responseId = isNotification
          ? null
          : (jsonRpcMessage as JsonRpcReq).id;
        return respondToProtocolMismatch(responseId, protocolHeader);
      }

      // Check for missing session ID (except for initialize requests)
      if (this.sessionAdapter && !sessionId && !isInitializeRequest) {
        return respondToMissingSessionId();
      }

      if (
        !isInitializeRequest &&
        !isNotification &&
        acceptHeader?.includes(SSE_ACCEPT_HEADER)
      ) {
        return this.handlePostSse({
          request,
          jsonRpcRequest: jsonRpcMessage,
          sessionId,
          isNotification,
          authInfo: options?.authInfo,
        });
      }

      const response = await this.server?._dispatch(jsonRpcMessage, {
        sessionId: sessionId || undefined,
        authInfo: options?.authInfo,
        clientCapabilities: await this.getClientCapabilities(sessionId),
      });

      if (isInitializeRequest && response) {
        if (this.sessionAdapter) {
          const sessionId = this.sessionAdapter.generateSessionId();

          // Extract capabilities from initialize params
          const initParams = (jsonRpcMessage as JsonRpcReq).params as {
            clientInfo?: unknown;
            capabilities?: {
              elicitation?: Record<string, never>;
              roots?: Record<string, never>;
              sampling?: Record<string, never>;
              [key: string]: unknown;
            };
          };
          const sessionMeta: SessionMeta = {
            protocolVersion: protocolHeader || SUPPORTED_MCP_PROTOCOL_VERSION,
            clientInfo: initParams.clientInfo || initParams, // Keep existing behavior
            clientCapabilities: initParams.capabilities, // Store capabilities
          };
          await this.sessionAdapter.create(sessionId, sessionMeta);
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              [MCP_SESSION_ID_HEADER]: sessionId,
            },
          });
        }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      if (response === null) {
        return new Response(null, { status: 202 });
      } else {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (this.sessionAdapter && !isInitializeRequest) {
          const sessionId = request.headers.get(MCP_SESSION_ID_HEADER);
          if (sessionId) {
            headers[MCP_SESSION_ID_HEADER] = sessionId;
          }
        }

        return new Response(JSON.stringify(response), {
          status: 200,
          headers,
        });
      }
    } catch (error) {
      const errorResponse = createJsonRpcError(
        null,
        new RpcError(
          JSON_RPC_ERROR_CODES.PARSE_ERROR,
          "Parse error",
          error instanceof Error ? error.message : "Unknown parsing error",
        ).toJson(),
      );

      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  private async handlePostSse(args: {
    request: Request;
    jsonRpcRequest: unknown;
    sessionId: string | null;
    isNotification: boolean;
    authInfo?: AuthInfo;
  }): Promise<Response> {
    const { jsonRpcRequest, sessionId, isNotification, authInfo } = args;

    if (isNotification) {
      return new Response(
        "Bad Request: POST SSE requires a request with 'id' (notifications not supported)",
        {
          status: 400,
        },
      );
    }

    const requestId = (jsonRpcRequest as JsonRpcReq).id;
    if (requestId === null || requestId === undefined) {
      return new Response(
        "Bad Request: POST SSE requires a request with 'id'",
        {
          status: 400,
        },
      );
    }

    // Generate synthetic session ID for stateless mode to enable notification routing
    const effectiveSessionId = sessionId || crypto.randomUUID();

    const { stream, writer } = createSSEStream({
      onClose: () => {
        this.requestStreams.delete(`${effectiveSessionId}:${requestId}`);
      },
    });

    // Register this request stream using effective session ID
    this.requestStreams.set(`${effectiveSessionId}:${requestId}`, writer);

    // Dispatch; route progress/responses to this writer (ephemeral; do not persist)
    Promise.resolve(
      this.server?._dispatch(jsonRpcRequest as JsonRpcReq, {
        sessionId: effectiveSessionId,
        authInfo,
        clientCapabilities:
          await this.getClientCapabilities(effectiveSessionId),
      }),
    )
      .then(async (rpcResponse) => {
        if (rpcResponse !== null) {
          writer.write(rpcResponse); // omit id for per-request streams
        }
      })
      .catch((err) => {
        try {
          const responseId = (jsonRpcRequest as JsonRpcReq).id;
          if (responseId !== null && responseId !== undefined) {
            const errorResponse = createJsonRpcError(
              responseId,
              new RpcError(
                JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
                "Internal error",
                err instanceof Error ? { message: err.message } : err,
              ).toJson(),
            );
            writer.write(errorResponse);
          }
        } catch (_) {}
      })
      .finally(() => {
        writer.end();
        // Ensure cleanup in case onClose wasn't triggered
        this.requestStreams.delete(`${effectiveSessionId}:${requestId}`);
      });

    const headers: Record<string, string> = {
      "Content-Type": SSE_ACCEPT_HEADER,
      Connection: "keep-alive",
    };

    // Add session id to header if sessions are supported
    if (this.sessionAdapter && sessionId) {
      headers[MCP_SESSION_ID_HEADER] = sessionId;
    }

    return new Response(stream as ReadableStream, {
      status: 200,
      headers,
    });
  }

  private async handleGet(request: Request): Promise<Response> {
    const accept = request.headers.get("Accept");
    if (!accept || !accept.includes(SSE_ACCEPT_HEADER)) {
      return new Response(
        "Bad Request: Accept header must be text/event-stream",
        {
          status: 400,
        },
      );
    }

    const protocolHeader = request.headers.get(MCP_PROTOCOL_HEADER);
    if (protocolHeader && protocolHeader !== SUPPORTED_MCP_PROTOCOL_VERSION) {
      return new Response("Bad Request: Protocol version mismatch", {
        status: 400,
      });
    }

    if (!this.sessionAdapter) {
      // Stateless mode does not provide a standalone GET stream
      return new Response("Method Not Allowed", { status: 405 });
    }

    const sessionId = request.headers.get(MCP_SESSION_ID_HEADER);
    if (!sessionId || !(await this.sessionAdapter?.has(sessionId))) {
      return new Response("Bad Request: Invalid or missing session ID", {
        status: 400,
      });
    }

    if (this.sessionStreams.has(sessionId)) {
      return new Response("Conflict: Stream already exists for session", {
        status: 409,
      });
    }

    const { stream, writer } = createSSEStream({
      onClose: () => this.sessionStreams.delete(sessionId),
    });

    // Register the session stream
    this.sessionStreams.set(sessionId, writer);

    // Optional resume (store expects suffixed Last-Event-ID: "<n>#<streamId>")
    const lastEventId = request.headers.get(MCP_LAST_EVENT_ID_HEADER);
    let attemptedReplay = false;
    if (lastEventId) {
      attemptedReplay = true;
      try {
        await this.sessionAdapter.replay(sessionId, lastEventId, (eid, msg) => {
          writer.write(msg, eid);
        });
      } catch (_error) {
        writer.end();
        return new Response("Internal Server Error: Replay failed", {
          status: 500,
        });
      }
    }

    // Send a JSON-RPC ping to establish the SSE connection if we didn't attempt replay
    // This is needed because SSE clients expect initial data to confirm the stream is working.
    // If we attempted replay (even if it returned 0 events), we don't send ping because the
    // client explicitly requested to resume from a specific point. If no replay was requested,
    // we send a ping (not awaiting pong) just to establish the connection - this is not
    // fully spec-compliant but ensures compatibility with MCP inspector (which expects
    // valid JSON-RPC format) while maintaining SSE stream functionality.
    if (!attemptedReplay) {
      const pingNotification = {
        jsonrpc: JSON_RPC_VERSION,
        method: "ping",
        params: {},
      };
      writer.write(pingNotification);
    }

    return new Response(stream as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": SSE_ACCEPT_HEADER,
        Connection: "keep-alive",
        [MCP_SESSION_ID_HEADER]: sessionId,
      },
    });
  }

  private async handleDelete(request: Request): Promise<Response> {
    const sessionId = request.headers.get(MCP_SESSION_ID_HEADER);
    if (!this.sessionAdapter) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (!sessionId) {
      return new Response("Bad Request: Missing session ID", {
        status: 400,
      });
    }

    this.cleanupSession(sessionId);

    await this.sessionAdapter.delete(sessionId);

    return new Response(null, { status: 200 });
  }
}
