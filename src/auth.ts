import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  accessToken: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getAccessToken(): string | undefined {
  return requestContext.getStore()?.accessToken;
}

/**
 * Wraps a tool handler so it can read the Google access token from
 * AsyncLocalStorage. MintMCP forwards the user's OAuth token as
 * `Authorization: Bearer <token>` on every request; index.ts parses it
 * and runs the request inside requestContext.run().
 *
 * The `scope` parameter is informational only — MintMCP enforces scope
 * gating at the connector configuration level, so the server doesn't
 * need to re-check.
 */
export function withGoogleAuth<TArgs>(
  _scope: string,
  handler: (args: TArgs, context: { accessToken: string }) => Promise<any>,
) {
  return async (args: TArgs) => {
    const accessToken = getAccessToken();
    if (!accessToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error:
                "Missing Google access token. MintMCP should forward the user's token via the Authorization: Bearer header.",
            }),
          },
        ],
        isError: true,
      };
    }
    return handler(args, { accessToken });
  };
}
