import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { requireAccessToken } from "./auth.js";
import { jsonRpcError, messagesOf, responseIdFor } from "./jsonrpc.js";

const PORT = Number(process.env.PORT) || 8000;
const MCP_PATH = "/mcp";

// Build the McpServer ONCE at startup. Tools are registered once;
// the per-request access token rides in AsyncLocalStorage.
const server = createServer();

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post(MCP_PATH, requireAccessToken, async (req: Request, res: Response) => {
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
    console.error("[gdrive-hosted] MCP request error:", err);
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[gdrive-hosted] listening on 0.0.0.0:${PORT}${MCP_PATH}`);
});
