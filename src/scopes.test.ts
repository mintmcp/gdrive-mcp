import { describe, test, expect } from "vitest";
import { FEATURES, PROFILES, SCOPES, expandScopes, isToolGranted, resolveGrant, type Grant } from "./scopes.js";
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

describe("resolveGrant scopes", () => {
  test("unset means unrestricted", () => {
    expect(resolveGrant(undefined)).toBeNull();
  });

  test("resolves a profile to its scope set", () => {
    const granted = resolveGrant("standard")?.scopes;
    expect(granted).toEqual(new Set([SCOPES.DRIVE_READONLY, SCOPES.DRIVE_FILE]));
  });

  test("expands implied scopes, so full covers the narrow grants", () => {
    const granted = resolveGrant("full")?.scopes;
    expect(granted?.has(SCOPES.DRIVE_FILE)).toBe(true);
    expect(granted?.has(SCOPES.DRIVE_READONLY)).toBe(true);
  });

  test("an unknown profile fails at boot, not silently serving every tool", () => {
    expect(() => resolveGrant("readonly")).toThrow(/unknown profile/i);
  });

  test("set but empty is a misconfiguration, not a silent lockout", () => {
    expect(() => resolveGrant("   ")).toThrow(/unset it/i);
  });
});

describe("resolveGrant", () => {
  test("unset means every tool and feature", () => {
    expect(resolveGrant(undefined)).toBeNull();
  });

  test("standard carries no feature", () => {
    expect(resolveGrant("standard")?.features).toEqual(new Set());
  });

  test("standard-resources has the scopes of standard plus the resources feature", () => {
    expect(resolveGrant("standard-resources")?.scopes).toEqual(resolveGrant("standard")?.scopes);
    expect(resolveGrant("standard-resources")?.features).toEqual(new Set([FEATURES.RESOURCES]));
  });

  test("full carries every feature", () => {
    expect(resolveGrant("full")?.features).toEqual(new Set(Object.values(FEATURES)));
  });

  test("every profile lists only known features", () => {
    for (const profile of Object.values(PROFILES)) {
      expect(Object.values(FEATURES)).toEqual(expect.arrayContaining([...profile.features]));
    }
  });
});

describe("isToolGranted", () => {
  test("a tool with no declared scope is always granted", () => {
    expect(isToolGranted(undefined, scopesOnly([]))).toBe(true);
  });

  test("withholds a tool whose scope is missing", () => {
    expect(isToolGranted(SCOPES.DRIVE_LABELS_READONLY, scopesOnly([SCOPES.DRIVE]))).toBe(false);
  });
});

function scopesOnly(scopes: string[]): Grant {
  return { scopes: expandScopes(scopes), features: new Set() };
}

function toolNames(grant: Grant | null): string[] {
  const server = createServer(grant);
  return Object.keys((server as any)._registeredTools ?? {}).sort();
}

const ALL_TOOLS = [
  "copy_file",
  "create_folder",
  "export_file",
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

describe("createServer tool surface", () => {
  test("unrestricted registers every tool", () => {
    expect(toolNames(null)).toEqual(ALL_TOOLS);
  });

  test("the standard profile registers every tool", () => {
    expect(toolNames(resolveGrant("standard"))).toEqual(ALL_TOOLS);
  });

  test("the full profile registers every tool, via the implication map", () => {
    expect(toolNames(resolveGrant("full"))).toEqual(ALL_TOOLS);
  });

  test("every profile's tools are a subset of the unrestricted surface", () => {
    for (const name of Object.keys(PROFILES)) {
      const tools = toolNames(resolveGrant(name));
      expect(ALL_TOOLS).toEqual(expect.arrayContaining(tools));
    }
  });

  test("a read-only grant withholds every write tool", () => {
    expect(toolNames(scopesOnly([SCOPES.DRIVE_READONLY]))).toEqual([
      "export_file",
      "get_file",
      "get_file_metadata",
      "get_file_permissions",
      "list_recent_files",
      "search_files",
    ]);
  });

  test("a grant covering nothing registers nothing", () => {
    expect(toolNames(scopesOnly([SCOPES.DRIVE_LABELS_READONLY]))).toEqual([]);
  });
});
