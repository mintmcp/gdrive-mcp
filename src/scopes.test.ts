import { describe, test, expect } from "vitest";
import { PROFILES, SCOPES, expandScopes, grantedScopes, isToolGranted } from "./scopes.js";
import { createServer } from "./server.js";

describe("expandScopes", () => {
  test("full drive covers the narrow write and read scopes", () => {
    const granted = expandScopes([SCOPES.DRIVE]);
    expect(granted.has(SCOPES.DRIVE_FILE)).toBe(true);
    expect(granted.has(SCOPES.DRIVE_READONLY)).toBe(true);
  });

  test("drive.file does not imply drive.readonly", () => {
    const granted = expandScopes([SCOPES.DRIVE_FILE]);
    expect(granted.has(SCOPES.DRIVE_READONLY)).toBe(false);
  });

  test("an unrelated scope brings nothing with it", () => {
    const granted = expandScopes([SCOPES.DRIVE_LABELS_READONLY]);
    expect([...granted]).toEqual([SCOPES.DRIVE_LABELS_READONLY]);
  });
});

describe("grantedScopes", () => {
  test("unset means unrestricted", () => {
    expect(grantedScopes(undefined)).toBeNull();
  });

  test("resolves a profile to its scope set", () => {
    const granted = grantedScopes("standard");
    expect(granted).toEqual(new Set([SCOPES.DRIVE_READONLY, SCOPES.DRIVE_FILE]));
  });

  test("labels-write adds the metadata scope for label writes", () => {
    const granted = grantedScopes("labels-write");
    expect(granted).toEqual(new Set([
      SCOPES.DRIVE_READONLY,
      SCOPES.DRIVE_FILE,
      SCOPES.DRIVE_LABELS_READONLY,
      SCOPES.DRIVE_METADATA,
    ]));
  });

  test("expands implied scopes, so full covers the narrow grants", () => {
    const granted = grantedScopes("full");
    expect(granted?.has(SCOPES.DRIVE_FILE)).toBe(true);
    expect(granted?.has(SCOPES.DRIVE_READONLY)).toBe(true);
    expect(granted?.has(SCOPES.DRIVE_METADATA)).toBe(true);
  });

  test("an unknown profile fails at boot, not silently serving every tool", () => {
    expect(() => grantedScopes("readonly")).toThrow(/unknown profile/i);
  });

  test("set but empty is a misconfiguration, not a silent lockout", () => {
    expect(() => grantedScopes("   ")).toThrow(/unset it/i);
  });
});

describe("isToolGranted", () => {
  test("a tool with no declared scope is always granted", () => {
    expect(isToolGranted(undefined, new Set())).toBe(true);
  });

  test("withholds a tool whose scope is missing", () => {
    expect(isToolGranted(SCOPES.DRIVE_LABELS_READONLY, expandScopes([SCOPES.DRIVE]))).toBe(false);
  });
});

function toolNames(granted: Set<string> | null): string[] {
  const server = createServer(granted);
  return Object.keys((server as any)._registeredTools ?? {}).sort();
}

const CORE_TOOLS = [
  "copy_file",
  "create_folder",
  "get_file",
  "get_file_metadata",
  "get_file_permissions",
  "list_recent_files",
  "move_file",
  "search_files",
  "share_file",
  "trash_file",
  "update_file_metadata",
  "upload_file",
].sort();

const ALL_TOOLS = [...CORE_TOOLS, "remove_file_label", "set_file_label"].sort();

describe("createServer tool surface", () => {
  test("unrestricted registers every tool", () => {
    expect(toolNames(null)).toEqual(ALL_TOOLS);
  });

  test("the standard profile registers the core tools but no label writes", () => {
    expect(toolNames(grantedScopes("standard"))).toEqual(CORE_TOOLS);
  });

  test("labels-write registers the label write tools", () => {
    expect(toolNames(grantedScopes("labels-write")))
      .toEqual([...CORE_TOOLS, "remove_file_label", "set_file_label"].sort());
  });

  test("the full profile registers every tool, via the implication map", () => {
    expect(toolNames(grantedScopes("full"))).toEqual(ALL_TOOLS);
  });

  test("every profile's tools are a subset of the unrestricted surface", () => {
    for (const name of Object.keys(PROFILES)) {
      const tools = toolNames(grantedScopes(name));
      expect(ALL_TOOLS).toEqual(expect.arrayContaining(tools));
    }
  });

  test("a read-only grant withholds every write tool", () => {
    expect(toolNames(expandScopes([SCOPES.DRIVE_READONLY]))).toEqual([
      "get_file",
      "get_file_metadata",
      "get_file_permissions",
      "list_recent_files",
      "search_files",
    ]);
  });

  test("a grant covering nothing registers nothing", () => {
    expect(toolNames(expandScopes([SCOPES.DRIVE_LABELS_READONLY]))).toEqual([]);
  });
});
