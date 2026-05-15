import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { requestContext } from "./auth.js";

const PORT = 8000;
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

app.post(MCP_PATH, async (req: Request, res: Response) => {
  const authHeader = req.header("authorization") ?? req.header("Authorization") ?? "";
  const accessToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  requestContext.run({ accessToken }, async () => {
    try {
      res.on("close", () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[gdrive-hosted] MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal error",
          },
          id: null,
        });
      }
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[gdrive-hosted] listening on 0.0.0.0:${PORT}${MCP_PATH}`);
});
