export const SCOPES = {
  DRIVE: "https://www.googleapis.com/auth/drive",
  DRIVE_FILE: "https://www.googleapis.com/auth/drive.file",
  DRIVE_READONLY: "https://www.googleapis.com/auth/drive.readonly",
  DRIVE_LABELS_READONLY: "https://www.googleapis.com/auth/drive.labels.readonly",
} as const;

// A feature is a capability a profile opts into that no Google scope
// distinguishes, so it can't ride on the scope set the way label enrichment
// does. Adding one to a frozen profile changes what its existing users get
export const FEATURES = {
  RESOURCES: "resources",
} as const;

export type Profile = {
  scopes: readonly string[];
  features: readonly string[];
};

// A profile resolved for the running server. null means unrestricted: every
// tool and feature registers
export type Grant = {
  scopes: Set<string>;
  features: Set<string>;
};

const STANDARD_SCOPES = [SCOPES.DRIVE_READONLY, SCOPES.DRIVE_FILE];
const ALL_FEATURES = Object.values(FEATURES);

// Editing a profile forces every user of its connector to re-consent, so
// frozen profiles never change. `full` is the evolving exception: its users
// accept re-consent as it grows. Keep each profile matching the scopes its
// brokered mcp-registry entry requests
export const PROFILES: Record<string, Profile> = {
  "standard": { scopes: STANDARD_SCOPES, features: [] },
  "standard-resources": { scopes: STANDARD_SCOPES, features: [FEATURES.RESOURCES] },
  "labels": { scopes: [...STANDARD_SCOPES, SCOPES.DRIVE_LABELS_READONLY], features: [] },
  "full": { scopes: [SCOPES.DRIVE, SCOPES.DRIVE_LABELS_READONLY], features: ALL_FEATURES },
};

// Google's scope hierarchy, not our policy: full drive is a superset of the
// narrow scopes. Never add an implication Google doesn't grant
const IMPLIES: Record<string, readonly string[]> = {
  [SCOPES.DRIVE]: [SCOPES.DRIVE_FILE, SCOPES.DRIVE_READONLY],
};

export function expandScopes(granted: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const scope of granted) {
    out.add(scope);
    for (const implied of IMPLIES[scope] ?? []) out.add(implied);
  }
  return out;
}

/**
 * Unset means every tool and feature registers (self-hosted default). An
 * unknown or empty profile throws so a misdeploy fails at boot, not silently
 */
function resolveProfile(profile: string | undefined): Profile | null {
  if (profile === undefined) return null;

  const name = profile.trim();
  if (name === "") {
    throw new Error("PROFILE is set but empty. Unset it to register every tool.");
  }

  const resolved = PROFILES[name];
  if (!resolved) {
    throw new Error(
      `Unknown PROFILE "${name}". Known profiles: ${Object.keys(PROFILES).join(", ")}.`,
    );
  }
  return resolved;
}

export function resolveGrant(profile = process.env.PROFILE): Grant | null {
  const resolved = resolveProfile(profile);
  if (resolved === null) return null;
  return { scopes: expandScopes(resolved.scopes), features: new Set(resolved.features) };
}

export function grantedScopes(profile = process.env.PROFILE): Set<string> | null {
  return resolveGrant(profile)?.scopes ?? null;
}

export function isToolGranted(toolScope: string | undefined, grant: Grant | null): boolean {
  if (grant === null || !toolScope) return true;
  return grant.scopes.has(toolScope);
}

export function isFeatureGranted(feature: string, grant: Grant | null): boolean {
  return grant === null || grant.features.has(feature);
}
