/** biome-ignore-all lint/style/noNonNullAssertion: tests */
/** biome-ignore-all lint/suspicious/noExplicitAny: tests */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

describe("Elicitation schema validation tests", () => {
  test("schema validation and projection works correctly", async () => {
    // Test that Zod schemas are properly converted to JSON Schema for elicitation
    const testSchema = z.object({
      name: z.string().min(2).max(50).describe("Full name"),
      age: z.number().int().min(18).max(120),
      email: z.string().email().describe("Email address"),
      role: z.enum(["admin", "user", "guest"]).describe("User role"),
      settings: z
        .object({
          notifications: z.boolean().default(true),
          theme: z.enum(["light", "dark"]).optional(),
        })
        .describe("User preferences"),
      tags: z.array(z.string()).optional().describe("User tags"),
    });

    // Import the schema processing functions directly to test them
    const { resolveToolSchema, toElicitationRequestedSchema } = await import(
      "../../../src/validation.js"
    );

    // Test schema resolution
    const { mcpInputSchema } = resolveToolSchema(testSchema, (s) =>
      z.toJSONSchema(s as z.ZodType),
    );

    // Test elicitation schema projection
    const requestedSchema = toElicitationRequestedSchema(mcpInputSchema);

    // Verify the schema projection is correct
    expect(requestedSchema.type).toBe("object");

    // Verify basic properties are projected correctly
    expect(requestedSchema.properties.name).toMatchObject({
      type: "string",
      minLength: 2,
      maxLength: 50,
      description: "Full name",
    });

    expect(requestedSchema.properties.age).toMatchObject({
      type: "integer",
      minimum: 18,
      maximum: 120,
    });

    expect(requestedSchema.properties.email).toMatchObject({
      type: "string",
      description: "Email address",
    });

    expect(requestedSchema.properties.role).toMatchObject({
      type: "string",
      enum: ["admin", "user", "guest"],
      description: "User role",
    });

    // Note: Complex nested objects and arrays may be filtered out by schema projection
    // to keep elicitation schemas simple and supported by all clients.
    // This is expected behavior - only basic types (string, number, boolean, enum) are preserved.
    expect(requestedSchema.required).toEqual(["name", "age", "email", "role"]);
  });

  test("plain JSON Schema works correctly with elicitation schema", async () => {
    const { resolveToolSchema, toElicitationRequestedSchema } = await import(
      "../../../src/validation.js"
    );

    const jsonSchema = {
      type: "object",
      properties: {
        username: {
          type: "string",
          minLength: 3,
          description: "Username",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["username", "count"],
    };

    // Test schema resolution with plain JSON Schema
    const { mcpInputSchema } = resolveToolSchema(jsonSchema, undefined);

    // Test elicitation schema projection
    const requestedSchema = toElicitationRequestedSchema(mcpInputSchema);

    // Verify schema is projected correctly from JSON Schema input
    expect(requestedSchema).toMatchObject({
      type: "object",
      properties: {
        username: {
          type: "string",
          minLength: 3,
          description: "Username",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["username", "count"],
    });
  });
});
