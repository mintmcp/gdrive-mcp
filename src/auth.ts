import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { jsonRpcError, messagesOf, responseIdFor } from "./jsonrpc.js";

export interface RequestContext {
  accessToken: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getAccessToken(): string | undefined {
  return requestContext.getStore()?.accessToken;
}

export const NOT_CONNECTED_MESSAGE =
  "Google Drive is not connected. Authorize the Google Drive connector for this user, then retry. " +
  "(No access token reached the server: MintMCP forwards the user's OAuth token as an " +
  "Authorization: Bearer header, and that header was missing or empty.)";

export function bearerTokenFromHeader(header: string | undefined): string {
  return header?.match(/^Bearer\s+(.*)$/i)?.[1].trim() ?? "";
}

export function requiresAccessToken(body: unknown): boolean {
  return messagesOf(body).some((m) => m.method === "tools/call");
}

// initialize and tools/list stay open: MintMCP health-checks by running
// initialize against /mcp, so 401ing that marks the connector down
export const requireAccessToken: RequestHandler = (req, res, next) => {
  const accessToken = bearerTokenFromHeader(req.header("authorization"));
  if (!accessToken && requiresAccessToken(req.body)) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        'Bearer realm="gdrive-mcp", error="invalid_token", error_description="Missing Google access token"',
      )
      .json(jsonRpcError(-32001, NOT_CONNECTED_MESSAGE, responseIdFor(messagesOf(req.body))));
    return;
  }
  requestContext.run({ accessToken }, next);
};

export interface ScopedHandler<TArgs> {
  (args: TArgs): Promise<any>;
  scope: string;
}

/**
 * Wraps a tool handler so it can read the Google access token from
 * AsyncLocalStorage. MintMCP forwards the user's OAuth token as
 * `Authorization: Bearer <token>` on every request; requireAccessToken parses it
 * and runs the request inside requestContext.run().
 *
 * `scope` is the Google scope the tool needs. It rides on the returned handler
 * so createServer can skip tools this deployment wasn't granted, instead of
 * advertising a tool that can only ever 403
 */
export function withGoogleAuth<TArgs>(
  scope: string,
  handler: (args: TArgs, context: { accessToken: string }) => Promise<any>,
): ScopedHandler<TArgs> {
  const wrapped = async (args: TArgs) => {
    const accessToken = getAccessToken();
    if (!accessToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: NOT_CONNECTED_MESSAGE, status: 401 }),
          },
        ],
        isError: true,
      };
    }
    return handler(args, { accessToken });
  };

  return Object.assign(wrapped, { scope });
}
