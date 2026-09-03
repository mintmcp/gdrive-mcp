import { describe, test, expect } from "vitest";
import { bearerTokenFromHeader, requiresAccessToken } from "./auth.js";
import { messagesOf, responseIdFor } from "./jsonrpc.js";

describe("bearerTokenFromHeader", () => {
  test("extracts a bearer token, scheme case-insensitive per RFC 7235", () => {
    expect(bearerTokenFromHeader("Bearer ya29.abc")).toBe("ya29.abc");
    expect(bearerTokenFromHeader("bearer ya29.abc")).toBe("ya29.abc");
    expect(bearerTokenFromHeader("BEARER ya29.abc")).toBe("ya29.abc");
  });

  test("returns empty for missing, blank, or non-bearer headers", () => {
    expect(bearerTokenFromHeader(undefined)).toBe("");
    expect(bearerTokenFromHeader("")).toBe("");
    expect(bearerTokenFromHeader("Bearer    ")).toBe("");
    expect(bearerTokenFromHeader("Basic ya29.abc")).toBe("");
  });
});

describe("requiresAccessToken", () => {
  test("gates tools/call and tools/list", () => {
    expect(requiresAccessToken({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBe(true);
    expect(requiresAccessToken({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBe(true);
    expect(requiresAccessToken({ method: "resources/list", id: 3 })).toBe(true);
    expect(requiresAccessToken({ id: 4 })).toBe(true);
  });

  test("leaves the handshake open so the MintMCP health probe passes", () => {
    expect(requiresAccessToken({ method: "initialize", id: 1 })).toBe(false);
    expect(requiresAccessToken({ method: "notifications/initialized" })).toBe(false);
    expect(requiresAccessToken({ method: "ping", id: 2 })).toBe(false);
    expect(requiresAccessToken(undefined)).toBe(false);
  });

  test("gates a batch containing anything past the handshake", () => {
    expect(requiresAccessToken([{ method: "initialize" }, { method: "tools/list" }])).toBe(true);
    expect(requiresAccessToken([{ method: "initialize" }])).toBe(false);
  });
});

describe("messagesOf / responseIdFor", () => {
  test("normalizes single messages, batches, and empty bodies", () => {
    expect(messagesOf({ method: "tools/call" })).toEqual([{ method: "tools/call" }]);
    expect(messagesOf([{ method: "a" }, { method: "b" }])).toHaveLength(2);
    expect(messagesOf(undefined)).toEqual([]);
  });

  test("echoes a single id, never a batch's", () => {
    expect(responseIdFor([{ id: 7, method: "tools/call" }])).toBe(7);
    expect(responseIdFor([{ id: 1 }, { id: 2 }])).toBe(null);
    expect(responseIdFor([])).toBe(null);
  });
});
