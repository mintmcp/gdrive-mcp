import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleDriveTools } from "./tools.js";
import { isToolGranted } from "./scopes.js";
import { log, truncate } from "./log.js";

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

  log("info", "tool_surface", {
    scopes: granted === null ? "unrestricted" : [...granted],
    tools: registered,
    withheld: skipped,
  });
}

// Handlers return failures as isError results, so without this a failed call
// leaves no trace in the server logs. Only fields that can't hold user data are
// logged; the full message already went back to the client in the tool result.
// This is a copy: gdrive, gslides, gsheets, gdocs and gmail carry the same code
// so they log the same fields. gslides-mcp src/server.ts is the reference;
// change it there first, then copy it to the other four
export function logToolErrors(
  toolName: string,
  handler: (args: any) => Promise<any>,
): (args: any) => Promise<any> {
  return async (args) => {
    let result: any;
    try {
      result = await handler(args);
    } catch (err) {
      // A throw that gets this far is a bug in our code, so the message is
      // worth keeping. Building the line must never replace the original error
      try {
        log("error", "tool_handler_throw", {
          tool: toolName,
          error: err instanceof Error ? err.name : typeof err,
          message: truncate(err instanceof Error ? err.message : String(err), 200),
        });
      } catch {}
      throw err;
    }
    if (result?.isError) log("warn", "tool_call_error", { tool: toolName, ...errorCodes(result) });
    return result;
  };
}

// reason and code are identifiers such as notFound, permission_denied or
// TypeError. Each connector fills in only some of them, and anything that
// isn't an identifier is dropped rather than logged
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function errorCodes(result: any): { status?: number; reason?: string; code?: string } {
  let payload: any;
  try {
    payload = JSON.parse(result.content?.[0]?.text);
  } catch {
    return {};
  }
  const pick = (v: unknown) => (typeof v === "string" && IDENTIFIER.test(v) ? v : undefined);
  return {
    status: typeof payload?.status === "number" ? payload.status : undefined,
    reason: pick(payload?.reason),
    code: pick(payload?.code),
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
      logToolErrors(toolName, (args) => t.handler(args)),
    );
  }

  return server;
}
