/** biome-ignore-all lint/style/noNonNullAssertion: tests */
/** biome-ignore-all lint/suspicious/noExplicitAny: tests */
import { describe, expect, test } from "bun:test";
import { InMemoryClientRequestAdapter } from "../../src/index.js";

describe("Elicitation E2E Tests", () => {
  test("E2E: client request adapter interface works correctly", async () => {
    // Test the client request adapter interface that's used for elicitation
    const adapter = new InMemoryClientRequestAdapter();

    // Test creating a pending request
    const { promise } = adapter.createPending("test-session", "req-123", {
      timeout_ms: 5000,
    });

    // Test resolving the request
    const result = { action: "accept", content: { response: "test" } };
    const resolved = adapter.resolvePending("test-session", "req-123", result);

    expect(resolved).toBe(true);

    // Verify the promise resolves with the correct result
    const promiseResult = await promise;
    expect(promiseResult).toEqual(result);
  });
});
