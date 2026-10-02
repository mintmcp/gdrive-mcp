import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { requireAccessToken } from "./auth.js";
import { jsonRpcError, messagesOf, responseIdFor } from "./jsonrpc.js";
import { log, errorFields } from "./log.js";

export const MCP_PATH = "/mcp";

export function createApp(granted: Set<string> | null) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // A fresh McpServer per request: an McpServer binds to one transport at a
  // time, so a shared one rejects overlapping requests with
  // "Already connected to a transport"
  app.post(MCP_PATH, requireAccessToken, async (req: Request, res: Response) => {
    const server = createServer(granted);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      res.on("close", () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "mcp_request_error", errorFields(err));
      if (!res.headersSent) {
        res
          .status(500)
          .json(
            jsonRpcError(
              -32603,
              err instanceof Error ? err.message : "Internal error",
              responseIdFor(messagesOf(req.body)),
            ),
          );
      }
    }
  });

  return app;
}
