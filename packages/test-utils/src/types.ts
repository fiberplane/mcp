// Interface for server creation
export interface TestServer {
  url: string;
  stop: () => Promise<void>;
}

// Type for JSON-RPC response
export interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
