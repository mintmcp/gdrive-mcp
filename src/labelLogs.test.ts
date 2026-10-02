import { afterEach, describe, expect, it, vi } from "vitest";
import { getFileLabels } from "./labels.js";

const SECRET = "Q3-salaries-secret";

function stubRoutes(routes: Array<[string, () => Response]>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const hit = routes.find(([part]) => String(url).includes(part));
    if (!hit) throw new Error(`unrouted ${url}`);
    return hit[1]();
  }));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("label log lines", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function lines(write: { mock: { calls: unknown[][] } }) {
    return write.mock.calls.map(([chunk]) => String(chunk));
  }

  it("logs a failed label read with its status, but no file id or message", async () => {
    stubRoutes([["listLabels", () => json({ error: { code: 404, message: `File not found: ${SECRET}`, errors: [{ reason: "notFound" }] } }, 404)]]);
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await getFileLabels(SECRET, "tok");

    const out = lines(written);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ level: "warn", event: "label_read_failed", status: 404 });
    expect(out.join("")).not.toContain(SECRET);
  });

  it("logs a failed label lookup with its status, but no file or label id", async () => {
    stubRoutes([
      ["listLabels", () => json({ labels: [{ id: `lbl-${SECRET}`, revisionId: "r1", fields: {} }] })],
      ["drivelabels.googleapis.com", () => json({ error: { code: 500, message: `boom ${SECRET}` } }, 500)],
    ]);
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await getFileLabels(SECRET, "tok");

    const out = lines(written);
    expect(out.map((l) => JSON.parse(l).event)).toContain("label_lookup_failed");
    expect(out.join("")).not.toContain(SECRET);
  });
});
