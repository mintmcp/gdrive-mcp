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

// Handlers return failures as isError results, so without this a failed call
// leaves no trace in the server logs. Args are left out: they carry user data
export function logToolErrors<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<any>,
): (args: TArgs) => Promise<any> {
  return async (args) => {
    try {
      const result = await handler(args);
      if (result?.isError) {
        console.error(
          `[gdrive-hosted] tool_error tool=${toolName} error=${result.content?.[0]?.text}`,
        );
      }
      return result;
    } catch (err) {
      console.error(
        `[gdrive-hosted] tool_error tool=${toolName} ` +
          `thrown=${err instanceof Error ? err.name : typeof err} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  };
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
      logToolErrors(toolName, t.handler),
    );
  }

  return server;
}
