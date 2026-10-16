// What each profile feature needs and how it registers on a server. The
// server loops over this table the way it loops over the tools, so adding a
// feature is one entry here plus its own module, and the server never names
// a feature itself

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FEATURES, SCOPES } from "./scopes.js";
import { registerResources } from "./resources.js";

export interface Feature {
  scope: string;
  register: (server: McpServer) => void;
}

export const FEATURE_REGISTRY: Record<string, Feature> = {
  // Resources read files, so drive.readonly is required as well as the opt-in
  [FEATURES.RESOURCES]: { scope: SCOPES.DRIVE_READONLY, register: registerResources },
};
