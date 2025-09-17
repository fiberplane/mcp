import { RpcError } from "./errors";
import {
  createJsonRpcError,
  JSON_RPC_ERROR_CODES,
  type JsonRpcId,
  type JsonRpcRes,
} from "./types";

/**
 * Checks if a value is an object.
 * @param value - The value to check.
 * @returns True if the value is an object, false otherwise.
 */
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Checks if a value is an object with a specific key.
 * @param value - The value to check.
 * @param key - The key to check for.
 * @returns True if the value is an object with the key, false otherwise.
 */
export function objectWithKey<T extends string>(
  value: unknown,
  key: T,
): value is { [K in T]: unknown } {
  return isObject(value) && key in value;
}

/**
 * Checks if a value is an object with a specific key and that the value for that key is not undefined.
 * @param value - The value to check.
 * @param key - The key to check for.
 * @returns True if the value is an object with the key that is defined, false otherwise.
 */
export function objectWithDefinedKey<T extends string>(
  value: unknown,
  key: T,
): value is { [K in T]: Exclude<unknown, undefined> } {
  if (!isObject(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!(key in candidate)) {
    return false;
  }
  return candidate[key] !== undefined;
}

/**
 * Checks if a value is an object with a specific key and value.
 * @param value - The value to check.
 * @param key - The key to check for.
 * @param expectedValue - The expected value for the key.
 * @returns True if the value is an object with the key and value, false otherwise.
 */
export function objectWithKeyAndValue<T extends string, V>(
  value: unknown,
  key: T,
  expectedValue: V,
): value is { [K in T]: V } {
  return objectWithKey(value, key) && value[key] === expectedValue;
}

/**
 * Checks if a value is an object with a specific key of a specific type.
 * @param value - The value to check.
 * @param key - The key to check for.
 * @param typeGuard - A type guard function to validate the value at the key.
 * @returns True if the value is an object with the key of the specified type, false otherwise.
 */
export function objectWithKeyOfType<T extends string, V>(
  value: unknown,
  key: T,
  typeGuard: (val: unknown) => val is V,
): value is { [K in T]: V } {
  return objectWithKey(value, key) && typeGuard(value[key]);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function errorToResponse(
  err: unknown,
  requestId: JsonRpcId | undefined,
): JsonRpcRes | null {
  if (requestId === undefined) {
    return null;
  }

  if (err instanceof RpcError) {
    return createJsonRpcError(requestId, err.toJson());
  }

  const errorData =
    err instanceof Error ? { message: err.message, stack: err.stack } : err;

  return createJsonRpcError(
    requestId,
    new RpcError(
      JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      "Internal error",
      errorData,
    ).toJson(),
  );
}
