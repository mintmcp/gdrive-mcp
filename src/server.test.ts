import { describe, expect, it, vi } from "vitest";
import { logToolErrors } from "./server.js";

describe("logToolErrors", () => {
  it("logs and rethrows an error thrown by the handler", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = logToolErrors("boom_tool", async () => {
      throw new TypeError("x is undefined");
    });

    await expect(handler({ q: "private" })).rejects.toThrow("x is undefined");

    const lines = logged.mock.calls.map((call) => call.join(" "));
    logged.mockRestore();
    expect(lines).toEqual([
      "[gdrive-hosted] tool_error tool=boom_tool thrown=TypeError error=x is undefined",
    ]);
  });
});
