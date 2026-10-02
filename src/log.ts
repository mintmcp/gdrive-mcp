// Same format as the other Google connectors (gslides-mcp src/lib/log.ts): one
// JSON object per line on stdout

export type LogLevel = "info" | "warn" | "error";

// Call sites never pass the access token; this is a backstop in case one does
const BEARER_REDACTION = /Bearer\s+[A-Za-z0-9._~+/\-]+=*/g;

export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })
    .replace(BEARER_REDACTION, "Bearer [redacted]");
  try {
    process.stdout.write(line + "\n");
  } catch {
    // stdout can be closed during shutdown; never let logging throw
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
