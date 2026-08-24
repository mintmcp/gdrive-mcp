import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleDriveTools } from "./tools.js";
import { grantedScopes, isToolGranted } from "./scopes.js";

const SERVER_NAME = "Google Drive";
const SERVER_VERSION = "2.0.0";

export function createServer(granted = grantedScopes()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const tools = GoogleDriveTools.getTools();
  const registered: string[] = [];
  const skipped: string[] = [];

  for (const [toolName, toolConfig] of Object.entries(tools)) {
    const t = toolConfig as any;

    if (!isToolGranted(t.handler?.scope, granted)) {
      skipped.push(toolName);
      continue;
    }

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
    registered.push(toolName);
  }

  console.log(
    `[gdrive-hosted] scopes=${granted === null ? "unrestricted" : [...granted].join(",")}`,
  );
  console.log(`[gdrive-hosted] tools=${registered.join(",") || "(none)"}`);
  if (skipped.length > 0) {
    console.log(`[gdrive-hosted] withheld (scope not granted)=${skipped.join(",")}`);
  }

  return server;
}
