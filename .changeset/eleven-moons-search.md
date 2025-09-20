---
"mcp-lite": minor
---

Breaking change: `eventStore` is replaced by `sessionStore` with a generic `SessionStore` interface that allows for combined MCP session management. Default `InMemorySessionStore` is provided.
