import { describe, expect, it } from "vitest";
import { errorFields } from "./log.js";

describe("errorFields", () => {
  it("keeps the class, status and identifier-shaped reason and code, never the message", () => {
    const err = Object.assign(new Error("File not found: Q3-salaries.xlsx"), { name: "DriveApiError", status: 404, reason: "notFound" });
    expect(errorFields(err)).toEqual({ error: "DriveApiError", status: 404, reason: "notFound", code: undefined });
    expect(JSON.stringify(errorFields(err))).not.toContain("Q3");
  });

  it("takes a failed fetch's system code from its cause", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
    expect(errorFields(err)).toMatchObject({ error: "TypeError", code: "ECONNRESET" });
  });

  it("drops a reason or code that isn't an identifier, and handles non-Errors", () => {
    expect(errorFields(Object.assign(new Error("x"), { reason: "file Q3.xlsx", code: 42 }))).toEqual({
      error: "Error", status: undefined, reason: undefined, code: undefined,
    });
    expect(errorFields("boom")).toMatchObject({ error: "string" });
    expect(errorFields(null)).toMatchObject({ error: "object" });
  });
});
