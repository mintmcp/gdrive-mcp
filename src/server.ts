import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleDriveTools } from "./tools.js";
import { isToolGranted } from "./scopes.js";

const SERVER_NAME = "Google Drive";
const SERVER_VERSION = "2.0.0";

// Built once: createServer runs per request, and rebuilding every Zod shape
// each time would put that cost on every call
const TOOLS = Object.entries(GoogleDriveTools.getTools()) as Array<[string, any]>;

export function logToolSurface(granted: Set<string> | null): void {
  const registered: string[] = [];
  const skipped: string[] = [];
  for (const [toolName, t] of TOOLS) {
    (isToolGranted(t.handler?.scope, granted) ? registered : skipped).push(toolName);
  }

  console.log(
    `[gdrive-hosted] scopes=${granted === null ? "unrestricted" : [...granted].join(",")}`,
  );
  console.log(`[gdrive-hosted] tools=${registered.join(",") || "(none)"}`);
  if (skipped.length > 0) {
    console.log(`[gdrive-hosted] withheld (scope not granted)=${skipped.join(",")}`);
  }
}

export function createServer(granted: Set<string> | null): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const [toolName, t] of TOOLS) {
    if (!isToolGranted(t.handler?.scope, granted)) continue;

    server.registerTool(
      toolName,
      {
        description: t.description,
        inputSchema: t.schema,
        outputSchema: t.outputSchema,
        annotations: {
          readOnlyHint: t.readOnlyHint ?? false,
          destructiveHint: t.destructiveHint ?? false,
        },
      },
      async (args: Record<string, unknown>) => t.handler(args),
    );
  }

  return server;
}
