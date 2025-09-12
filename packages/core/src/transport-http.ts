import {
  JSON_RPC_VERSION,
  MCP_LAST_EVENT_ID_HEADER,
  MCP_PROTOCOL_HEADER,
  MCP_SESSION_ID_HEADER,
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

  bind(server: McpServer): (request: Request) => Promise<Response> {
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
          if (sessionId) {
            const requestKey = keyForRequest(sessionId, relatedRequestId);
            const writer = this.writers.get(requestKey);
            if (writer) {
              writer.write(jsonRpcNotification);
              return;
            }
          }
          // Also support request-only streams (created without session header)
          const requestOnlyKey = `request:${String(relatedRequestId)}`;
          const requestOnlyWriter = this.writers.get(requestOnlyKey);
          if (requestOnlyWriter) {
            requestOnlyWriter.write(jsonRpcNotification);
            return;
          }
        }

        // Fallback to session stream when available
        if (sessionId) {
          const sessionKey = keyForSession(sessionId);
          const writer = this.writers.get(sessionKey);
          if (writer) {
            if (this.eventStore) {
              const eventId = await this.eventStore.append(
                sessionId,
                jsonRpcNotification,
              );
              writer.write(jsonRpcNotification, eventId);
            } else {
              writer.write(jsonRpcNotification);
            }
          }
        }
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

  private async handleRequest(request: Request): Promise<Response> {
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
        return this.handlePost(request);
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

  private async handlePost(request: Request): Promise<Response> {
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

      if (!isInitializeRequest && acceptHeader?.endsWith(SSE_ACCEPT_HEADER)) {
        return this.handlePostSse({
          request,
          jsonRpcRequest: jsonRpcMessage,
          sessionId,
          isNotification,
        });
      }

      const response = await this.server?._dispatch(jsonRpcMessage, {
        sessionId: sessionId || undefined,
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
    if (lastEventId && this.eventStore) {
      try {
        await this.eventStore.replay(
          sessionId,
          lastEventId,
          (eventId: string, message: unknown) => {
            writer.write(message, eventId);
          },
        );
      } catch (_error) {
        writer.end();
        this.writers.delete(sessionKey);
        return new Response("Internal Server Error: Replay failed", {
          status: 500,
        });
      }
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
    const { stream, writer } = createSSEStream();
    this.writers.set(streamKey, writer);

    const [responseStream, monitorStream] = stream.tee();
    monitorStream
      .pipeTo(
        new WritableStream({
          close: () => {
            this.writers.delete(streamKey);
            writer.end();
          },
          abort: () => {
            this.writers.delete(streamKey);
            writer.end();
          },
        }),
      )
      .catch(() => {
        this.writers.delete(streamKey);
        writer.end();
      });

    return { responseStream, writer };
  }

  private async handlePostSse(args: {
    request: Request;
    jsonRpcRequest: unknown;
    sessionId: string | null;
    isNotification: boolean;
  }): Promise<Response> {
    const { request, jsonRpcRequest, sessionId, isNotification } = args;

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
      }),
    )
      .then(async (rpcResponse) => {
        if (rpcResponse !== null) {
          // Request streams not persisted; omit id
          writer.write(rpcResponse);
        }
      })
      .catch((err) => {
        // On unexpected error, send an INTERNAL_ERROR response if possible
        try {
          const responseId = isNotification
            ? null
            : (jsonRpcRequest as JsonRpcReq).id;
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
        this.writers.delete(streamKey);
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
