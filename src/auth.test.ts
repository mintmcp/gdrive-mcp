import { describe, test, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  bearerTokenFromHeader,
  getAccessToken,
  NOT_CONNECTED_MESSAGE,
  requireAccessToken,
} from "./auth.js";
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

describe("requireAccessToken", () => {
  function invoke(body: unknown, authorization?: string) {
    const req = {
      body,
      header: vi.fn().mockReturnValue(authorization),
    };
    const res = {
      status: vi.fn(),
      set: vi.fn(),
      json: vi.fn(),
    };
    res.status.mockReturnValue(res);
    res.set.mockReturnValue(res);
    res.json.mockReturnValue(res);
    let tokenInNext: string | undefined;
    const next = vi.fn(() => {
      tokenInNext = getAccessToken();
    });

    requireAccessToken(
      req as unknown as Request,
      res as unknown as Response,
      next as unknown as NextFunction,
    );
    return { res, next, tokenInNext };
  }

  test.each(["initialize", "tools/list", "tools/call"])(
    "returns 401 for unauthenticated %s requests",
    (method) => {
      const { res, next } = invoke({ jsonrpc: "2.0", id: 7, method });

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.set).toHaveBeenCalledWith(
        "WWW-Authenticate",
        'Bearer realm="gdrive-mcp", error="invalid_token", error_description="Missing Google access token"',
      );
      expect(res.json).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        error: { code: -32001, message: NOT_CONNECTED_MESSAGE },
        id: 7,
      });
    },
  );

  test("passes authenticated requests through with the token in request context", () => {
    const { res, next, tokenInNext } = invoke(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      "Bearer ya29.abc",
    );

    expect(next).toHaveBeenCalledOnce();
    expect(tokenInNext).toBe("ya29.abc");
    expect(res.status).not.toHaveBeenCalled();
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
