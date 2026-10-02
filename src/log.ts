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

// Describes an error for a log line without its message, which can echo ids,
// names or other user data: the class, plus status, reason and code when the
// error carries them (a failed fetch keeps its code on `cause`). reason and
// code are kept only when they look like identifiers
export function errorFields(err: unknown): { error: string; status?: number; reason?: string; code?: string } {
  const e = err as { status?: unknown; reason?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? v : undefined);
  return {
    error: err instanceof Error ? err.name : typeof err,
    status: typeof e?.status === "number" ? e.status : undefined,
    reason: id(e?.reason),
    code: id(e?.code) ?? id(e?.cause?.code),
  };
}
