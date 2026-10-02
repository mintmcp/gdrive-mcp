import { afterEach, describe, expect, it, vi } from "vitest";
import { logToolErrors } from "./server.js";

function records(write: { mock: { calls: unknown[][] } }) {
  return write.mock.calls.map(([chunk]) => {
    const { ts, ...rest } = JSON.parse(String(chunk));
    return rest;
  });
}

describe("logToolErrors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the error class and a short message, then rethrows", async () => {
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handler = logToolErrors("boom_tool", async () => {
      throw new TypeError("x".repeat(300));
    });

    await expect(handler({ q: "private" })).rejects.toThrow(TypeError);

    expect(records(written)).toEqual([
      {
        level: "error",
        event: "tool_handler_throw",
        tool: "boom_tool",
        error: "TypeError",
        message: "x".repeat(199) + "…",
      },
    ]);
  });

  it("logs no message text, and drops a reason that isn't an identifier", async () => {
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const payload = { error: "Bad name: Q3 salaries.xlsx", status: 400, reason: "name is Q3 salaries.xlsx" };
    const handler = logToolErrors("rename_file", async () => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: true,
    }));

    await handler({});

    expect(records(written)).toEqual([
      { level: "warn", event: "tool_call_error", tool: "rename_file", status: 400 },
    ]);
  });

  it("logs only the tool name when the error text isn't JSON", async () => {
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handler = logToolErrors("t", async () => ({
      content: [{ type: "text", text: "plain failure about secret.pdf" }],
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
