import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { z } from "zod";
import {
  resolveToolSchema,
  toElicitationRequestedSchema,
} from "../../src/validation.js";

describe("toElicitationRequestedSchema", () => {
  describe("Basic JSON Schema support", () => {
    test("handles simple object with primitive types", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", description: "User name" },
          age: { type: "number", minimum: 0, maximum: 120 },
          active: { type: "boolean", default: true },
          count: { type: "integer", minimum: 1 },
        },
        required: ["name", "age"],
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string", description: "User name" },
          age: { type: "number", minimum: 0, maximum: 120 },
          active: { type: "boolean", default: true },
          count: { type: "integer", minimum: 1 },
        },
        required: ["name", "age"],
      });
    });

    test("handles string constraints and formats", () => {
      const schema = {
        type: "object",
        properties: {
          email: {
            type: "string",
            format: "email",
            minLength: 5,
            maxLength: 100,
          },
          website: { type: "string", format: "uri" },
          birthday: { type: "string", format: "date" },
          timestamp: { type: "string", format: "date-time" },
        },
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result.properties).toEqual({
        email: {
          type: "string",
          format: "email",
          minLength: 5,
          maxLength: 100,
        },
        website: { type: "string", format: "uri" },
        birthday: { type: "string", format: "date" },
        timestamp: { type: "string", format: "date-time" },
      });
    });

    test("handles string enums with enumNames", () => {
      const schema = {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "inactive", "pending"],
            enumNames: ["Active", "Inactive", "Pending"],
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            // No enumNames - should still work
          },
        },
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result.properties).toEqual({
        status: {
          type: "string",
          enum: ["active", "inactive", "pending"],
          enumNames: ["Active", "Inactive", "Pending"],
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
      });
    });

    test("drops unsupported types in non-strict mode", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          metadata: { type: "object", properties: { key: { type: "string" } } },
          mixed: { type: ["string", "number"] },
        },
        required: ["name", "tags"],
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"], // tags removed from required since property was dropped
      });
    });

    test("preserves only valid required fields", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array" }, // Will be dropped
        },
        required: ["name", "tags", "nonexistent"],
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result.required).toEqual(["name"]);
    });
  });

  describe("Strict mode", () => {
    test("throws on unsupported property types", () => {
      const schema = {
        type: "object",
        properties: {
          tags: { type: "array" },
        },
      };

      expect(() => toElicitationRequestedSchema(schema, true)).toThrow(
        "Unsupported property type: array",
      );
    });

    test("throws on unsupported string formats", () => {
      const schema = {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
        },
      };

      expect(() => toElicitationRequestedSchema(schema, true)).toThrow(
        "Unsupported string format: uuid",
      );
    });

    test("throws on non-string enum values", () => {
      const schema = {
        type: "object",
        properties: {
          code: { type: "string", enum: [1, 2, 3] },
        },
      };

      expect(() => toElicitationRequestedSchema(schema, true)).toThrow(
        "Enum values must be strings for elicitation",
      );
    });

    test("throws on non-object root schema", () => {
      const schema = { type: "string" };

      expect(() => toElicitationRequestedSchema(schema, true)).toThrow(
        "Root schema must be of type 'object'",
      );
    });

    test("throws on missing properties", () => {
      const schema = { type: "object" };

      expect(() => toElicitationRequestedSchema(schema, true)).toThrow(
        "Object schema must have properties",
      );
    });
  });

  describe("Edge cases", () => {
    test("handles null/undefined schema", () => {
      expect(toElicitationRequestedSchema(null)).toEqual({
        type: "object",
        properties: {},
      });

      expect(toElicitationRequestedSchema(undefined)).toEqual({
        type: "object",
        properties: {},
      });
    });

    test("handles non-object schema", () => {
      expect(toElicitationRequestedSchema("string")).toEqual({
        type: "object",
        properties: {},
      });

      expect(toElicitationRequestedSchema(123)).toEqual({
        type: "object",
        properties: {},
      });
    });

    test("handles schema without type", () => {
      const schema = {
        properties: {
          name: { type: "string" },
        },
      };

      expect(toElicitationRequestedSchema(schema)).toEqual({
        type: "object",
        properties: {},
      });
    });

    test("handles empty properties object", () => {
      const schema = {
        type: "object",
        properties: {},
      };

      expect(toElicitationRequestedSchema(schema)).toEqual({
        type: "object",
        properties: {},
      });
    });

    test("handles invalid property schema", () => {
      const schema = {
        type: "object",
        properties: {
          valid: { type: "string" },
          invalid: "not an object",
          another: null,
        },
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result.properties).toEqual({
        valid: { type: "string" },
      });
    });

    test("handles enumNames length mismatch", () => {
      const schema = {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["a", "b", "c"],
            enumNames: ["A", "B"], // Length mismatch
          },
        },
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result.properties).toEqual({
        status: {
          type: "string",
          enum: ["a", "b", "c"],
          // enumNames should be omitted due to length mismatch
        },
      });
    });

    test("preserves all supported constraint types", () => {
      const schema = {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "A text field",
            minLength: 1,
            maxLength: 50,
            default: "default value",
          },
          num: {
            type: "number",
            description: "A number",
            minimum: -100.5,
            maximum: 100.5,
            default: 0,
          },
          int: {
            type: "integer",
            description: "An integer",
            minimum: 1,
            maximum: 100,
          },
          flag: {
            type: "boolean",
            description: "A flag",
            default: false,
          },
        },
      };

      const result = toElicitationRequestedSchema(schema);

      expect(result.properties).toEqual({
        text: {
          type: "string",
          description: "A text field",
          minLength: 1,
          maxLength: 50,
          default: "default value",
        },
        num: {
          type: "number",
          description: "A number",
          minimum: -100.5,
          maximum: 100.5,
          default: 0,
        },
        int: {
          type: "integer",
          description: "An integer",
          minimum: 1,
          maximum: 100,
        },
        flag: {
          type: "boolean",
          description: "A flag",
          default: false,
        },
      });
    });
  });

  describe("Standard Schema integration", () => {
    test("throws error for Standard Schema inputs", () => {
      const standardSchema = {
        "~standard": {
          version: 1,
          vendor: "zod",
          validate: () => ({ value: {} }),
        },
      };

      expect(() => toElicitationRequestedSchema(standardSchema)).toThrow(
        "Standard Schema inputs must be converted via resolveToolSchema first",
      );
    });

    test("works with Zod schemas via resolveToolSchema", () => {
      const zodSchema = z.object({
        email: z.string().email().min(5).max(100),
        age: z.number().min(0).max(150),
        tags: z.array(z.string()), // Should be dropped
        agree: z.boolean().default(false),
        role: z.enum(["admin", "user", "guest"]),
      });

      // Use Zod's built-in toJSONSchema method
      const schemaAdapter = (schema: any) => z.toJSONSchema(schema);

      const { mcpInputSchema } = resolveToolSchema(zodSchema, schemaAdapter);
      const result = toElicitationRequestedSchema(mcpInputSchema);

      expect(result.type).toBe("object");
      expect(result.properties).toBeDefined();

      // Check individual properties that should be preserved
      expect(result.properties.email).toEqual({
        type: "string",
        format: "email",
        minLength: 5,
        maxLength: 100,
      });
      expect(result.properties.age).toEqual({
        type: "number",
        minimum: 0,
        maximum: 150,
      });
      expect(result.properties.agree).toEqual({
        type: "boolean",
        default: false,
      });
      expect(result.properties.role).toEqual({
        type: "string",
        enum: ["admin", "user", "guest"],
      });

      // Tags should be dropped as arrays are unsupported
      expect(result.properties.tags).toBeUndefined();

      // Check required array (agree should not be required as it has a default)
      expect(result.required).toEqual(["email", "age", "agree", "role"]);
    });

    test("works with ArkType schemas via resolveToolSchema", () => {
      const arkSchema = type({
        email: "string.email",
        age: "number>=0",
        nested: {
          user: "string",
        }, // Should be dropped as nested object
        active: "boolean",
        count: "number>=1",
      });

      // Use ArkType's built-in toJsonSchema method
      const schemaAdapter = (schema: any) => schema.toJsonSchema();

      const { mcpInputSchema } = resolveToolSchema(arkSchema, schemaAdapter);
      const result = toElicitationRequestedSchema(mcpInputSchema);

      // The exact structure depends on ArkType's JSON Schema output
      expect(result.type).toBe("object");
      expect(result.properties).toBeDefined();

      // Should have supported properties
      expect(result.properties.email).toEqual({
        type: "string",
        format: "email",
      });
      expect(result.properties.age).toEqual({
        type: "number",
        minimum: 0,
      });
      expect(result.properties.active).toEqual({ type: "boolean" });
      expect(result.properties.count).toEqual({ type: "number", minimum: 1 });

      // Should not have nested object
      expect(result.properties.nested).toBeUndefined();
    });

    test("handles complex Zod schema with mixed supported/unsupported types", () => {
      const complexSchema = z.object({
        // Supported types
        name: z.string().min(1).max(50),
        email: z.string().email(),
        age: z.number().int().min(18).max(100),
        isActive: z.boolean().default(true),
        role: z.enum(["admin", "user", "moderator"]),

        // Unsupported types that should be dropped
        tags: z.array(z.string()),
        metadata: z.object({
          created: z.string(),
          updated: z.string(),
        }),
        union: z.union([z.string(), z.number()]),
        optional: z.string().optional(),
      });

      const schemaAdapter = (schema: any) => z.toJSONSchema(schema);

      const { mcpInputSchema } = resolveToolSchema(
        complexSchema,
        schemaAdapter,
      );
      const result = toElicitationRequestedSchema(mcpInputSchema);

      expect(result.type).toBe("object");
      expect(result.properties).toBeDefined();

      // Should have supported properties
      expect(result.properties.name).toEqual({
        type: "string",
        minLength: 1,
        maxLength: 50,
      });
      expect(result.properties.email).toEqual({
        type: "string",
        format: "email",
      });
      expect(result.properties.age).toEqual({
        type: "integer",
        minimum: 18,
        maximum: 100,
      });
      expect(result.properties.isActive).toEqual({
        type: "boolean",
        default: true,
      });
      expect(result.properties.role).toEqual({
        type: "string",
        enum: ["admin", "user", "moderator"],
      });

      // Optional string should be preserved
      expect(result.properties.optional).toEqual({
        type: "string",
      });

      // Unsupported types should be dropped
      expect(result.properties.tags).toBeUndefined();
      expect(result.properties.metadata).toBeUndefined();
      expect(result.properties.union).toBeUndefined();

      // Required should include all non-optional fields (Zod includes defaults as required)
      expect(result.required).toContain("name");
      expect(result.required).toContain("email");
      expect(result.required).toContain("age");
      expect(result.required).toContain("role");
      expect(result.required).toContain("isActive"); // Zod includes defaults as required
      expect(result.required).not.toContain("optional"); // is optional
    });
  });

  describe("resolveToolSchema integration", () => {
    test("works with resolved JSON Schema from resolveToolSchema", () => {
      const jsonSchema = {
        type: "object",
        properties: {
          name: { type: "string", description: "User name" },
          age: { type: "number", minimum: 0 },
        },
        required: ["name"],
      };

      const { mcpInputSchema } = resolveToolSchema(jsonSchema);
      const result = toElicitationRequestedSchema(mcpInputSchema);

      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string", description: "User name" },
          age: { type: "number", minimum: 0 },
        },
        required: ["name"],
      });
    });

    test("works with undefined schema via resolveToolSchema", () => {
      const { mcpInputSchema } = resolveToolSchema();
      const result = toElicitationRequestedSchema(mcpInputSchema);

      expect(result).toEqual({
        type: "object",
        properties: {},
      });
    });
  });
});
