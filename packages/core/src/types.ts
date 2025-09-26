import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AuthInfo } from "./auth.js";
import { GLOBAL_NOTIFICATIONS, JSON_RPC_VERSION } from "./constants.js";
import type { UriMatcher } from "./uri-template.js";
import {
  isNumber,
  isObject,
  isString,
  objectWithDefinedKey,
  objectWithKeyOfType,
} from "./utils.js";

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcStandardErrorCode =
  (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

export type JsonRpcId = string | null;

export interface JsonRpcReq {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcReq | JsonRpcNotification;

export interface JsonRpcRes {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type OnError = (
  err: unknown,
  ctx: MCPServerContext,
) => JsonRpcError | undefined | Promise<JsonRpcError | undefined>;

export interface InitializeParams {
  protocolVersion: string;
  capabilities?: {
    elicitation?: Record<string, never>;
    [key: string]: unknown;
  };
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    tools?: { listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    resources?: { listChanged?: boolean; subscribe?: boolean };
  };
}

export type ProgressToken = string | number;

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export interface MCPServerContext {
  request: JsonRpcMessage;
  requestId: JsonRpcId | undefined;
  response: JsonRpcRes | null;
  env: Record<string, unknown>;
  state: Record<string, unknown>;
  /**
   * Info on the authenticated user, if any
   */
  authInfo?: AuthInfo;
  session?: { id: string; protocolVersion: string };
  progressToken?: ProgressToken;
  validate<T>(validator: unknown, input: unknown): T;
  progress?(update: ProgressUpdate): Promise<void> | void;
  client: MCPClientFeatures;
  elicit<S extends StandardSchemaV1<unknown, unknown>>(
    params: { message: string; schema: S },
    options?: { timeout_ms?: number; strict?: boolean },
  ): Promise<ElicitationResult<StandardSchemaV1.InferInput<S>>>;
  elicit<T = Record<string, unknown>>(
    params: { message: string; schema: unknown },
    options?: { timeout_ms?: number; strict?: boolean },
  ): Promise<ElicitationResult<T>>;
}

export interface MCPClientFeatures {
  supports(feature: ClientCapabilities | string): boolean;
}

export type Middleware = (
  ctx: MCPServerContext,
  next: () => Promise<void>,
) => Promise<void> | void;

export type MethodHandler = (
  params: unknown,
  ctx: MCPServerContext,
) => Promise<unknown> | unknown;

export function isJsonRpcNotification(
  obj: unknown,
): obj is JsonRpcNotification {
  if (!isObject(obj)) {
    return false;
  }

  const candidate = obj as Record<string, unknown>;

  if (candidate.jsonrpc !== "2.0") {
    return false;
  }

  if (!isString(candidate.method)) {
    return false;
  }

  if ("id" in candidate) {
    return false;
  }

  return true;
}

export function isJsonRpcRequest(obj: unknown): obj is JsonRpcReq {
  if (!isObject(obj)) {
    return false;
  }

  const candidate = obj as Record<string, unknown>;

  if (candidate.jsonrpc !== "2.0") {
    return false;
  }

  if (!isString(candidate.method)) {
    return false;
  }

  if (!("id" in candidate)) {
    return false;
  }

  const id = candidate.id;
  if (!isString(id) && !isNumber(id) && id !== null) {
    return false;
  }

  return true;
}

export function isJsonRpcResponse(obj: unknown): obj is JsonRpcRes {
  if (!isObject(obj)) {
    return false;
  }

  const candidate = obj as Record<string, unknown>;

  if (candidate.jsonrpc !== "2.0") {
    return false;
  }

  if (!("id" in candidate)) {
    return false;
  }

  const id = candidate.id;
  if (!isString(id) && !isNumber(id) && id !== null) {
    return false;
  }

  // Must have either result or error
  if (!("result" in candidate) && !("error" in candidate)) {
    return false;
  }

  return true;
}

export function createJsonRpcResponse(
  id: JsonRpcId,
  result?: unknown,
): JsonRpcRes {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

export function createJsonRpcError(
  id: JsonRpcId,
  error: JsonRpcError,
): JsonRpcRes {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error,
  };
}

export function isInitializeParams(obj: unknown): obj is InitializeParams {
  if (!isObject(obj)) {
    return false;
  }

  const candidate = obj as Record<string, unknown>;

  if (!objectWithKeyOfType(candidate, "protocolVersion", isString)) {
    return false;
  }

  if (
    objectWithDefinedKey(candidate, "capabilities") &&
    !objectWithKeyOfType(candidate, "capabilities", isObject)
  ) {
    return false;
  }

  if (objectWithDefinedKey(candidate, "clientInfo")) {
    if (!objectWithKeyOfType(candidate, "clientInfo", isObject)) {
      return false;
    }

    const clientInfoObj = candidate.clientInfo as Record<string, unknown>;

    if (!isClientInfo(clientInfoObj)) {
      return false;
    }
  }

  return true;
}

function isClientInfo(obj: unknown) {
  if (!objectWithKeyOfType(obj, "name", isString)) {
    return false;
  }
  if (!objectWithKeyOfType(obj, "version", isString)) {
    return false;
  }
  return true;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface Prompt {
  name: string;
  description?: string;
  arguments?: unknown[];
}

export interface PromptArgumentDef {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMetadata {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgumentDef[];
}

export type PromptHandler<TArgs = unknown> = (
  args: TArgs,
  ctx: MCPServerContext,
) => Promise<PromptGetResult> | PromptGetResult;

export interface PromptEntry {
  metadata: PromptMetadata;
  handler: PromptHandler;
  validator?: unknown;
}

export interface Resource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  _meta?: { [key: string]: unknown };
  annotations?: Annotations;
}

export interface ResourceProvider {
  list?: (ctx: MCPServerContext) => unknown;
  read?: (uri: string, ctx: MCPServerContext) => unknown;
  subscribe?: (
    uri: string,
    ctx: MCPServerContext,
    onChange: (n: { uri: string }) => void,
  ) => unknown;
}

export interface ToolEntry {
  metadata: Tool;
  handler: MethodHandler;
  validator?: unknown;
}

export interface ResourceEntry {
  metadata: Resource | ResourceTemplate;
  handler: ResourceHandler;
  validators?: ResourceVarValidators;
  matcher?: UriMatcher;
  type: "resource" | "resource_template";
}

export type InferInput<T> = T extends StandardSchemaV1<unknown, unknown>
  ? StandardSchemaV1.InferInput<T>
  : unknown;

export type InferOutput<T> = T extends StandardSchemaV1<unknown, unknown>
  ? StandardSchemaV1.InferOutput<T>
  : unknown;

export type SchemaAdapter = (schema: StandardSchemaV1) => JsonSchema;
export type JsonSchema = unknown;

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    value !== null &&
    // ArkType uses functions for schemas, so we need to check whether `value` is an object or a function
    (typeof value === "object" || typeof value === "function") &&
    "~standard" in value &&
    typeof (value as Record<string, unknown>)["~standard"] === "object" &&
    (value as { "~standard": { version: number } })["~standard"].version === 1
  );
}

export type Role = "user" | "assistant" | "system";

export type ClientCapabilities = "elicitation" | "roots" | "sampling";

export interface Annotations {
  audience?: Role[];
  lastModified?: string;
  priority?: number;
}

export type TextResourceContents = {
  _meta?: { [key: string]: unknown };
  uri: string;
  type: "text";
  text: string;
  mimeType?: string;
};

export type BlobResourceContents = {
  _meta?: { [key: string]: unknown };
  uri: string;
  blob: string;
  mimeType?: string;
};

export type ResourceContents = TextResourceContents | BlobResourceContents;

interface MetaAnnotated {
  _meta?: { [key: string]: unknown };
  annotations?: Annotations;
}

interface TextContent extends MetaAnnotated {
  type: "text";
  text: string;
}

interface ImageContent extends MetaAnnotated {
  type: "image";
  data: string;
  mimeType: string;
}

interface AudioContent extends MetaAnnotated {
  type: "audio";
  data: string;
  mimeType: string;
}

interface ResourceLink extends MetaAnnotated {
  type: "resource_link";
  uri: string;
}

interface EmbeddedResource extends MetaAnnotated {
  type: "resource";
  resource: ResourceContents;
}

export type Content =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;

export interface ToolCallParams {
  name: string;
  arguments?: unknown;
}

export interface PromptGetParams {
  name: string;
  arguments?: unknown;
}

export interface ResourceReadParams {
  uri: string;
}

export interface ResourceSubscribeParams {
  uri: string;
}

export interface ToolCallResult {
  content: Content[];
  isError?: boolean;
}

export interface PromptGetResult {
  description?: string;
  messages: unknown[];
}

export interface ResourceReadResult {
  contents: ResourceContents[];
  _meta?: { [key: string]: unknown };
}

export interface ListToolsResult {
  tools: Tool[];
}

export interface ListPromptsResult {
  prompts: Prompt[];
}

export interface ListResourcesResult {
  resources: Resource[];
  _meta?: { [key: string]: unknown };
}

export interface ListResourceTemplatesResult {
  resourceTemplates: ResourceTemplate[];
  _meta?: { [key: string]: unknown };
}

export interface ResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
  _meta?: { [key: string]: unknown };
  annotations?: Annotations;
}

export type ResourceVars = Record<string, string>;

export interface ResourceMeta {
  name?: string;
  description?: string;
  mimeType?: string;
  _meta?: { [key: string]: unknown };
  annotations?: Annotations;
}

export type ResourceVarValidators = Record<string, unknown>;

export type ResourceHandler = (
  uri: URL,
  vars: ResourceVars,
  ctx: MCPServerContext,
) => Promise<ResourceReadResult>;

export interface NotificationSenderOptions {
  relatedRequestId?: string;
}

export type NotificationSender = (
  sessionId: string | undefined,
  notification: { method: string; params?: unknown },
  options?: NotificationSenderOptions,
) => Promise<void> | void;

type GlobalNotification = (typeof GLOBAL_NOTIFICATIONS)[number];

export function isGlobalNotification(
  notificationMethod: string,
): notificationMethod is GlobalNotification {
  for (const globalNotification of GLOBAL_NOTIFICATIONS) {
    if (notificationMethod === globalNotification) {
      return true;
    }
  }
  return false;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationResult<TContent = Record<string, unknown>> {
  action: ElicitationAction;
  content?: TContent; // present on "accept"
}
