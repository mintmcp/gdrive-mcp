export const SCOPES = {
  DRIVE: "https://www.googleapis.com/auth/drive",
  DRIVE_FILE: "https://www.googleapis.com/auth/drive.file",
  DRIVE_READONLY: "https://www.googleapis.com/auth/drive.readonly",
  DRIVE_LABELS_READONLY: "https://www.googleapis.com/auth/drive.labels.readonly",
} as const;

// Editing a profile forces every user of its connector to re-consent, so
// frozen profiles never change. `full` is the evolving exception: its users
// accept re-consent as it grows. Keep each profile matching the scopes its
// brokered mcp-registry entry requests
export const PROFILES: Record<string, readonly string[]> = {
  standard: [SCOPES.DRIVE_READONLY, SCOPES.DRIVE_FILE],
  "standard-labels": [SCOPES.DRIVE_READONLY, SCOPES.DRIVE_FILE, SCOPES.DRIVE_LABELS_READONLY],
  full: [SCOPES.DRIVE, SCOPES.DRIVE_LABELS_READONLY],
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
 * Unset means every tool registers (self-hosted default). An unknown or
 * empty profile throws so a misdeploy fails at boot, not silently
 */
export function grantedScopes(profile = process.env.PROFILE): Set<string> | null {
  if (profile === undefined) return null;

  const name = profile.trim();
  if (name === "") {
    throw new Error("PROFILE is set but empty. Unset it to register every tool.");
  }

  const scopes = PROFILES[name];
  if (!scopes) {
    throw new Error(
      `Unknown PROFILE "${name}". Known profiles: ${Object.keys(PROFILES).join(", ")}.`,
    );
  }
  return expandScopes(scopes);
}

export function isToolGranted(toolScope: string | undefined, granted: Set<string> | null): boolean {
  if (granted === null) return true;
  if (!toolScope) return true;
  return granted.has(toolScope);
}
