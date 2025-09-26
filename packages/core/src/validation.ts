import { RpcError } from "./errors.js";
import type { PromptArgumentDef, SchemaAdapter } from "./types.js";
import { isStandardSchema, JSON_RPC_ERROR_CODES } from "./types.js";

export function resolveToolSchema(
  inputSchema?: unknown,
  schemaAdapter?: SchemaAdapter,
): {
  mcpInputSchema: unknown;
  validator?: unknown;
} {
  if (!inputSchema) return { mcpInputSchema: { type: "object" } };

  if (isStandardSchema(inputSchema)) {
    if (!schemaAdapter) {
      const vendor = inputSchema["~standard"].vendor;
      throw new Error(
        `Cannot use Standard Schema (vendor: "${vendor}") without a schema adapter. ` +
          `Configure a schema adapter when creating McpServer.`,
      );
    }

    const jsonSchema = schemaAdapter(inputSchema);
    return { mcpInputSchema: jsonSchema, validator: inputSchema };
  }

  return { mcpInputSchema: inputSchema };
}

export function createValidationFunction<T>(
  validator: unknown,
  input: unknown,
): T {
  if (isStandardSchema(validator)) {
    const result = validator["~standard"].validate(input);
    if (result instanceof Promise) {
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        "Async validation not supported in this context",
      );
    }
    if ("issues" in result && result.issues?.length) {
      const messages = result.issues.map((i) => i.message).join(", ");
      throw new RpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Validation failed: ${messages}`,
      );
    }
    return (result as { value: T }).value;
  }

  if (validator && typeof validator === "object" && "validate" in validator) {
    const validatorObj = validator as {
      validate(input: unknown): {
        ok: boolean;
        data?: unknown;
        issues?: unknown[];
      };
    };
    const result = validatorObj.validate(input);
    if (result?.ok && result.data !== undefined) {
      return result.data as T;
    }
    throw new RpcError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      "Validation failed",
    );
  }

  throw new RpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, "Invalid validator");
}

export function extractArgumentsFromSchema(
  schema: unknown,
): PromptArgumentDef[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const schemaObj = schema as Record<string, unknown>;

  if (schemaObj.type === "object" && schemaObj.properties) {
    const properties = schemaObj.properties as Record<string, unknown>;
    const required = (schemaObj.required as string[]) || [];

    return Object.entries(properties).map(([name, propSchema]) => {
      const prop = propSchema as Record<string, unknown>;
      return {
        name,
        description: prop.description as string | undefined,
        required: required.includes(name),
      };
    });
  }

  return [];
}

interface ElicitationJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export function toElicitationRequestedSchema(
  schema: unknown,
  strict = false,
): ElicitationJsonSchema {
  // Handle Standard Schema inputs by converting to JSON Schema first
  if (isStandardSchema(schema)) {
    throw new Error(
      "Standard Schema inputs must be converted via resolveToolSchema first",
    );
  }

  if (!schema || typeof schema !== "object") {
    if (strict) {
      throw new Error("Schema must be an object");
    }
    return { type: "object", properties: {} };
  }

  const schemaObj = schema as Record<string, unknown>;

  // Ensure root is object type
  if (schemaObj.type !== "object") {
    if (strict) {
      throw new Error("Root schema must be of type 'object'");
    }
    return { type: "object", properties: {} };
  }

  if (!schemaObj.properties || typeof schemaObj.properties !== "object") {
    if (strict) {
      throw new Error("Object schema must have properties");
    }
    return { type: "object", properties: {} };
  }

  const properties = schemaObj.properties as Record<string, unknown>;
  const requiredArray = Array.isArray(schemaObj.required)
    ? (schemaObj.required as string[])
    : [];

  const elicitationProperties: Record<string, unknown> = {};
  const validRequired: string[] = [];

  for (const [propName, propSchema] of Object.entries(properties)) {
    const projectedProp = projectPropertyToElicitation(propSchema, strict);
    if (projectedProp !== null) {
      elicitationProperties[propName] = projectedProp;
      if (requiredArray.includes(propName)) {
        validRequired.push(propName);
      }
    }
  }

  const result: ElicitationJsonSchema = {
    type: "object",
    properties: elicitationProperties,
  };

  if (validRequired.length > 0) {
    result.required = validRequired;
  }

  return result;
}

function projectPropertyToElicitation(
  propSchema: unknown,
  strict: boolean,
): unknown | null {
  if (!propSchema || typeof propSchema !== "object") {
    if (strict) {
      throw new Error("Property schema must be an object");
    }
    return null;
  }

  const prop = propSchema as Record<string, unknown>;
  const propType = prop.type;

  // Handle primitive types
  if (
    propType === "string" ||
    propType === "number" ||
    propType === "integer" ||
    propType === "boolean"
  ) {
    const result: Record<string, unknown> = { type: propType };

    // Preserve description
    if (typeof prop.description === "string") {
      result.description = prop.description;
    }

    // Preserve default
    if (prop.default !== undefined) {
      result.default = prop.default;
    }

    // Handle string-specific properties
    if (propType === "string") {
      // Preserve string constraints
      if (typeof prop.minLength === "number") {
        result.minLength = prop.minLength;
      }
      if (typeof prop.maxLength === "number") {
        result.maxLength = prop.maxLength;
      }

      // Handle string format (only supported ones)
      if (typeof prop.format === "string") {
        const supportedFormats = ["email", "uri", "date", "date-time"];
        if (supportedFormats.includes(prop.format)) {
          result.format = prop.format;
        } else if (strict) {
          throw new Error(`Unsupported string format: ${prop.format}`);
        }
      }

      // Handle string enums with enumNames
      if (Array.isArray(prop.enum)) {
        const enumValues = prop.enum;
        const enumNames = Array.isArray(prop.enumNames)
          ? (prop.enumNames as string[])
          : undefined;

        // Only include if all enum values are strings
        if (enumValues.every((val) => typeof val === "string")) {
          result.enum = enumValues;
          if (enumNames && enumNames.length === enumValues.length) {
            result.enumNames = enumNames;
          }
        } else if (strict) {
          throw new Error("Enum values must be strings for elicitation");
        }
      }
    }

    // Handle number/integer constraints
    if (propType === "number" || propType === "integer") {
      if (typeof prop.minimum === "number") {
        result.minimum = prop.minimum;
      }
      if (typeof prop.maximum === "number") {
        result.maximum = prop.maximum;
      }
    }

    return result;
  }

  // Drop unsupported types (arrays, objects, etc.)
  if (strict) {
    throw new Error(`Unsupported property type: ${propType}`);
  }

  return null;
}
