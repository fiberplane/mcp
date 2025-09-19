export const JSON_RPC_VERSION = "2.0";

export const SUPPORTED_MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_PROTOCOL_HEADER = "MCP-Protocol-Version";

export const MCP_SESSION_ID_HEADER = "MCP-Session-Id";

export const MCP_LAST_EVENT_ID_HEADER = "Last-Event-ID";

export const SSE_ACCEPT_HEADER = "text/event-stream";

export const METHODS = {
  INITIALIZE: "initialize",
  PING: "ping",
  TOOLS: {
    LIST: "tools/list",
    CALL: "tools/call",
  },
  PROMPTS: {
    LIST: "prompts/list",
    GET: "prompts/get",
  },
  RESOURCES: {
    LIST: "resources/list",
    TEMPLATES_LIST: "resources/templates/list",
    READ: "resources/read",
    SUBSCRIBE: "resources/subscribe",
    UNSUBSCRIBE: "resources/unsubscribe",
  },
  COMPLETION: {
    COMPLETE: "completion/complete",
  },
  ELICITATION: {
    CREATE: "elicitation/create",
  },
  NOTIFICATIONS: {
    CANCELLED: "notifications/cancelled",
    INITIALIZED: "notifications/initialized",
    PROGRESS: "notifications/progress",
    ROOTS: {
      LIST_CHANGED: "notifications/roots/list_changed",
    },
    TOOLS: {
      LIST_CHANGED: "notifications/tools/list_changed",
    },
    PROMPTS: {
      LIST_CHANGED: "notifications/prompts/list_changed",
    },
    RESOURCES: {
      LIST_CHANGED: "notifications/resources/list_changed",
    },
  },
  LOGGING: {
    SET_LEVEL: "logging/setLevel",
  },
} as const;

export const GLOBAL_NOTIFICATIONS = [
  METHODS.NOTIFICATIONS.TOOLS.LIST_CHANGED,
  METHODS.NOTIFICATIONS.PROMPTS.LIST_CHANGED,
  METHODS.NOTIFICATIONS.RESOURCES.LIST_CHANGED,
];

export const SSE_STREAM_ID = "_GET_stream";
