import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleDriveTools } from "./tools.js";

const SERVER_NAME = "Google Drive";
const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const tools = GoogleDriveTools.getTools();

  for (const [toolName, toolConfig] of Object.entries(tools)) {
    const t = toolConfig as any;
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
