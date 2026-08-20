export interface JsonRpcMessage {
  method?: string;
  id?: string | number | null;
}

export function messagesOf(body: unknown): JsonRpcMessage[] {
  if (Array.isArray(body)) return body as JsonRpcMessage[];
  return body ? [body as JsonRpcMessage] : [];
}

export function responseIdFor(messages: JsonRpcMessage[]): string | number | null {
  return messages.length === 1 ? messages[0]?.id ?? null : null;
}

export function jsonRpcError(code: number, message: string, id: string | number | null) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id };
}
