import type { AuthInfo } from "./auth.js";
import {
  JSON_RPC_VERSION,
  MCP_LAST_EVENT_ID_HEADER,
  MCP_PROTOCOL_HEADER,
  MCP_SESSION_ID_HEADER,
  METHODS,
  SSE_ACCEPT_HEADER,
  SUPPORTED_MCP_PROTOCOL_VERSION,
} from "./constants.js";
import type { McpServer } from "./core.js";
import { RpcError } from "./errors.js";
import { createSSEStream, type StreamWriter } from "./sse-writer.js";
import type { EventStore, SessionId, SessionMeta } from "./store.js";
import {
  createJsonRpcError,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JSON_RPC_ERROR_CODES,
  type JsonRpcMessage,
  type JsonRpcReq,
} from "./types.js";

function parseJsonRpc(body: string): unknown {
  try {
    const parsed = JSON.parse(body);
    return parsed;
  } catch (_error) {
    throw new RpcError(JSON_RPC_ERROR_CODES.PARSE_ERROR, "Invalid JSON");
  }
}

function keyForSession(sessionId: string): string {
  return `session:${sessionId}`;
}

function keyForRequest(sessionId: string, requestId: string | number): string {
  return `session:${sessionId}:request:${requestId}`;
}

interface SessionData {
  meta: SessionMeta;
}

export interface StreamableHttpTransportOptions {
  eventStore?: EventStore;
  generateSessionId?: () => string;
  /** Allowed Origin headers for CORS validation  */
  allowedOrigins?: string[];
  /** Allowed Host headers for preventing Host header attacks */
  allowedHosts?: string[];
}

export class StreamableHttpTransport {
  private server?: McpServer;
  private generateSessionId?: () => string;
  private eventStore?: EventStore;
  private allowedOrigins?: string[];
  private allowedHosts?: string[];
  private sessions = new Map<SessionId, SessionData>();
  private writers = new Map<string, StreamWriter>();

  constructor(options: StreamableHttpTransportOptions = {}) {
    this.generateSessionId = options.generateSessionId;
    this.eventStore = options.eventStore;
    this.allowedOrigins = options.allowedOrigins;
    this.allowedHosts = options.allowedHosts;
  }

  bind(
    server: McpServer,
  ): (
    request: Request,
    options?: { authInfo?: AuthInfo },
  ) => Promise<Response> {
    this.server = server;

    server._setNotificationSender(async (sessionId, notification, options) => {
      const jsonRpcNotification = {
        jsonrpc: JSON_RPC_VERSION,
        method: notification.method,
        params: notification.params,
      };

      if (this.generateSessionId) {
        const relatedRequestId = options?.relatedRequestId;
        // Prefer routing to request streams when a related request is specified
        if (relatedRequestId !== undefined) {
          // 1) Try session-scoped request stream
          if (sessionId) {
            const requestKey = keyForRequest(sessionId, relatedRequestId);
            const writer = this.writers.get(requestKey);
            if (writer) {
              // Per-request streams are ephemeral; do not persist
              writer.write(jsonRpcNotification);
              return;
            }
          }
          // 2) Try request-only stream (stateless per-request)
          const requestOnlyKey = `request:${String(relatedRequestId)}`;
          const requestOnlyWriter = this.writers.get(requestOnlyKey);
          if (requestOnlyWriter) {
            // Ephemeral; do not persist
            requestOnlyWriter.write(jsonRpcNotification);
            return;
          }
          // 3) No per-request stream present. If we have a session, persist for replay
          if (sessionId && this.eventStore) {
            const eventId = await this.eventStore.append(
              sessionId,
              jsonRpcNotification,
            );
            const sessionKey = keyForSession(sessionId);
            const sessionWriter = this.writers.get(sessionKey);
            if (sessionWriter) {
              sessionWriter.write(jsonRpcNotification, eventId);
            }
            return;
          }
          // If no session or no store, attempt best-effort delivery to session stream if present
          if (sessionId) {
            const sessionKey = keyForSession(sessionId);
            const sessionWriter = this.writers.get(sessionKey);
            if (sessionWriter) {
              sessionWriter.write(jsonRpcNotification);
            }
            return;
          }
        }

        // No relatedRequestId: deliver to session stream and persist if possible
        if (sessionId) {
          const sessionKey = keyForSession(sessionId);
          const sessionWriter = this.writers.get(sessionKey);
          if (this.eventStore) {
            const eventId = await this.eventStore.append(
              sessionId,
              jsonRpcNotification,
            );
            if (sessionWriter) {
              sessionWriter.write(jsonRpcNotification, eventId);
            }
          } else if (sessionWriter) {
            sessionWriter.write(jsonRpcNotification);
          }
          return;
        }
        const allowedCrossSessionNotifications = [
          METHODS.NOTIFICATIONS.TOOLS.LIST_CHANGED,
          METHODS.NOTIFICATIONS.PROMPTS.LIST_CHANGED,
          METHODS.NOTIFICATIONS.RESOURCES.LIST_CHANGED,
        ];

        // No session: allow safe broadcast for list_changed notifications to all session streams
        const method = notification.method;
        if (
          allowedCrossSessionNotifications.includes(
            method as (typeof allowedCrossSessionNotifications)[number],
          )
        ) {
          for (const [key, w] of this.writers) {
            if (key.startsWith("session:")) {
              w.write(jsonRpcNotification);
            }
          }
          return;
        }
        // Otherwise discard to avoid cross-session leakage
        return;
      } else {
        // Stateless mode: only deliver when relatedRequestId is present
        const relatedRequestId = options?.relatedRequestId;
        if (relatedRequestId !== undefined) {
          const requestKey = `request:${String(relatedRequestId)}`;
          const writer = this.writers.get(requestKey);
          if (writer) {
            writer.write(jsonRpcNotification);
          }
        }
        // Otherwise discard
        return;
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
      const body = await request.text();
      const jsonRpcMessage = parseJsonRpc(body);

      // Check if it's a JSON-RPC response first
      if (isJsonRpcResponse(jsonRpcMessage)) {
        // Accept responses but don't process them, just return 202
        return new Response(null, { status: 202 });
      }

      if (
        !isJsonRpcNotification(jsonRpcMessage) &&
        !isJsonRpcRequest(jsonRpcMessage)
      ) {
        const errorResponse = createJsonRpcError(
          null,
          new RpcError(
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            "Invalid JSON-RPC 2.0 message format",
          ).toJson(),
        );
        return new Response(JSON.stringify(errorResponse), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      const isNotification = isJsonRpcNotification(jsonRpcMessage);
      const isInitializeRequest =
        (jsonRpcMessage as JsonRpcMessage).method === "initialize";
      const acceptHeader = request.headers.get("Accept");
      const protocolHeader = request.headers.get(MCP_PROTOCOL_HEADER);

      if (!isInitializeRequest) {
        if (
          protocolHeader &&
          protocolHeader !== SUPPORTED_MCP_PROTOCOL_VERSION
        ) {
          const responseId = isNotification
            ? null
            : (jsonRpcMessage as JsonRpcReq).id;
          const errorResponse = createJsonRpcError(
            responseId,
            new RpcError(
              JSON_RPC_ERROR_CODES.INVALID_PARAMS,
              "Protocol version mismatch",
              {
                expectedVersion: SUPPORTED_MCP_PROTOCOL_VERSION,
                receivedVersion: protocolHeader,
              },
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
      const sessionId = request.headers.get(MCP_SESSION_ID_HEADER);

      if (
        !isInitializeRequest &&
        !isNotification &&
        acceptHeader?.endsWith(SSE_ACCEPT_HEADER)
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
      });

      if (isInitializeRequest && response) {
        if (this.generateSessionId) {
          const sessionId = this.generateSessionId();
          const sessionMeta: SessionMeta = {
            protocolVersion: protocolHeader || SUPPORTED_MCP_PROTOCOL_VERSION,
            clientInfo: (jsonRpcMessage as JsonRpcReq).params,
          };
          this.sessions.set(sessionId, { meta: sessionMeta });
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

        if (this.generateSessionId && !isInitializeRequest) {
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

  private async handleGet(request: Request): Promise<Response> {
    const accept = request.headers.get("Accept");
    if (!accept || !accept.endsWith(SSE_ACCEPT_HEADER)) {
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

    if (!this.generateSessionId) {
      // Stateless mode does not provide a standalone GET stream
      return new Response("Method Not Allowed", { status: 405 });
    }

    const sessionId = request.headers.get(MCP_SESSION_ID_HEADER);
    if (!sessionId || !this.sessions.has(sessionId)) {
      return new Response("Bad Request: Invalid or missing session ID", {
        status: 400,
      });
    }

    const sessionKey = keyForSession(sessionId);

    if (this.writers.has(sessionKey)) {
      return new Response("Conflict: Stream already exists for session", {
        status: 409,
      });
    }

    const { responseStream, writer } =
      this.createAndRegisterSseStream(sessionKey);

    const lastEventId = request.headers.get(MCP_LAST_EVENT_ID_HEADER);
    let hadReplay = false;
    if (lastEventId && this.eventStore) {
      try {
        await this.eventStore.replay(
          sessionId,
          lastEventId,
          (eventId: string, message: unknown) => {
            writer.write(message, eventId);
            hadReplay = true;
          },
        );
      } catch (_error) {
        writer.end();
        return new Response("Internal Server Error: Replay failed", {
          status: 500,
        });
      }
    }

    // Emit a JSON connection event only when not replaying existing events
    if (!hadReplay) {
      writer.write({ type: "connection", status: "established" });
    }

    return new Response(responseStream, {
      status: 200,
      headers: {
        "Content-Type": SSE_ACCEPT_HEADER,
        Connection: "keep-alive",
        [MCP_SESSION_ID_HEADER]: sessionId,
      },
    });
  }

  private createAndRegisterSseStream(streamKey: string): {
    responseStream: ReadableStream;
    writer: StreamWriter;
  } {
    const { stream, writer } = createSSEStream({
      onClose: () => {
        this.writers.delete(streamKey);
      },
    });
    this.writers.set(streamKey, writer);
    return { responseStream: stream as ReadableStream, writer };
  }

  private async handlePostSse(args: {
    request: Request;
    jsonRpcRequest: unknown;
    sessionId: string | null;
    isNotification: boolean;
    authInfo?: AuthInfo;
  }): Promise<Response> {
    const { request, jsonRpcRequest, sessionId, isNotification, authInfo } =
      args;

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

    const streamKey = sessionId
      ? keyForRequest(sessionId, String(requestId))
      : `request:${String(requestId)}`;

    if (this.writers.has(streamKey)) {
      return new Response("Conflict: Stream already exists for request", {
        status: 409,
      });
    }

    const { responseStream, writer } =
      this.createAndRegisterSseStream(streamKey);

    // No replay support for request streams - only for session streams
    Promise.resolve(
      this.server?._dispatch(jsonRpcRequest as JsonRpcReq, {
        sessionId: sessionId || undefined,
        authInfo,
      }),
    )
      .then(async (rpcResponse) => {
        if (rpcResponse !== null) {
          // Request streams not persisted; omit id
          writer.write(rpcResponse);
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
            // Request streams not persisted; omit id
            writer.write(errorResponse);
          }
        } catch (_) {}
      })
      .finally(() => {
        writer.end();
      });

    const headers: Record<string, string> = {
      "Content-Type": SSE_ACCEPT_HEADER,
      Connection: "keep-alive",
    };
    if (this.generateSessionId) {
      const sid = request.headers.get(MCP_SESSION_ID_HEADER);
      if (sid) headers[MCP_SESSION_ID_HEADER] = sid;
    }

    return new Response(responseStream, {
      status: 200,
      headers,
    });
  }

  private async handleDelete(request: Request): Promise<Response> {
    const sessionId = request.headers.get(MCP_SESSION_ID_HEADER);
    if (!this.generateSessionId) {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!sessionId) {
      return new Response("Bad Request: Missing session ID", {
        status: 400,
      });
    }

    // Close session stream
    const sessionKey = keyForSession(sessionId);
    const sessionWriter = this.writers.get(sessionKey);
    if (sessionWriter) {
      sessionWriter.end();
      this.writers.delete(sessionKey);
    }

    // Close all request streams for this session
    const requestKeysToDelete: string[] = [];
    for (const [key] of this.writers) {
      if (key.startsWith(`session:${sessionId}:request:`)) {
        requestKeysToDelete.push(key);
      }
    }

    for (const key of requestKeysToDelete) {
      const writer = this.writers.get(key);
      if (writer) {
        writer.end();
        this.writers.delete(key);
      }
    }

    this.sessions.delete(sessionId);

    return new Response(null, { status: 200 });
  }
}
