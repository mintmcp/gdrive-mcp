import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, logToolErrors } from "./server.js";
import { requestContext } from "./auth.js";

const SECRET = "Q3-salaries-secret";
const FIELDS = ["ts", "level", "event", "tool", "status", "reason", "code"];

function records(write: { mock: { calls: unknown[][] } }) {
  return write.mock.calls.map(([chunk]) => {
    const { ts, ...rest } = JSON.parse(String(chunk));
    return rest;
  });
}

async function callTool(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await createServer(null).connect(serverTransport);
  await client.connect(clientTransport);
  const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const result = await requestContext.run({ accessToken: "tok-" + SECRET } as any, () =>
    client.callTool({ name: "get_file_metadata", arguments: { file_id: "f1" } }),
  );
  return { result, lines: written.mock.calls.map(([chunk]) => String(chunk)) };
}

describe("tool error logging over MCP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs the status of a Google error, but not its message or the token", async () => {
    const body = {
      error: { code: 400, status: "INVALID_ARGUMENT", message: `Invalid value: ${SECRET}.`, errors: [{ reason: "invalid" }] },
    };
    const { result, lines } = await callTool(async () =>
      new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(SECRET);
    const logged = lines.filter((l) => l.includes('"tool_call_error"'));
    expect(logged).toHaveLength(1);
    const record = JSON.parse(logged[0]);
    expect(record).toMatchObject({ level: "warn", event: "tool_call_error", tool: "get_file_metadata", status: 400 });
    expect(Object.keys(record).every((k) => FIELDS.includes(k))).toBe(true);
    expect(lines.join("")).not.toContain(SECRET);
  });

  it("logs the error class when our own code fails", async () => {
    const { result, lines } = await callTool(async () => {
      throw new TypeError(`cannot read ${SECRET}`);
    });

    expect(result.isError).toBe(true);
    const logged = lines.filter((l) => l.includes('"tool_call_error"'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({ tool: "get_file_metadata", code: "TypeError" });
    expect(lines.join("")).not.toContain(SECRET);
  });

  it("logs the system code of a failed fetch instead of TypeError", async () => {
    const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET}`), { code: "ENOTFOUND" });
    const { result, lines } = await callTool(async () => {
      throw new TypeError("fetch failed", { cause });
    });

    expect(result.isError).toBe(true);
    const logged = lines.filter((l) => l.includes('"tool_call_error"'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({ tool: "get_file_metadata", code: "ENOTFOUND" });
    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("logToolErrors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the error class and a short message on a throw, then rethrows", async () => {
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handler = logToolErrors("boom", async () => {
      throw new TypeError("x".repeat(300));
    });

    await expect(handler({})).rejects.toThrow(TypeError);

    expect(records(written)).toEqual([
      { level: "error", event: "tool_handler_throw", tool: "boom", error: "TypeError", message: "x".repeat(199) + "…" },
    ]);
  });

  it("rethrows the original value even when it can't be turned into a log line", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const thrown = Object.create(null);
    const handler = logToolErrors("boom", async () => {
      throw thrown;
    });

    await expect(handler({})).rejects.toBe(thrown);
  });

  it("drops a reason or code that isn't an identifier", async () => {
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const payload = { error: SECRET, status: 403, reason: `file ${SECRET}`, code: "not an id" };
    const handler = logToolErrors("t", async () => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: true,
    }));

    await handler({});

    expect(records(written)).toEqual([{ level: "warn", event: "tool_call_error", tool: "t", status: 403 }]);
  });

  it("logs only the tool name when the error text isn't JSON", async () => {
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handler = logToolErrors("t", async () => ({
      content: [{ type: "text", text: `plain failure about ${SECRET}` }],
      isError: true,
    }));

    await handler({});

    expect(records(written)).toEqual([{ level: "warn", event: "tool_call_error", tool: "t" }]);
  });

  it("logs nothing for a successful call", async () => {
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await logToolErrors("t", async () => ({ content: [] }))({});
    expect(written).not.toHaveBeenCalled();
  });
});
