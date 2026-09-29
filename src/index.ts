import { createApp, MCP_PATH } from "./app.js";
import { logToolSurface } from "./server.js";
import { grantedScopes } from "./scopes.js";

const PORT = Number(process.env.PORT) || 8000;

// Resolved once at boot so a bad PROFILE fails the deploy, not each request
const granted = grantedScopes();
logToolSurface(granted);

createApp(granted).listen(PORT, "0.0.0.0", () => {
  console.log(`[gdrive-hosted] listening on 0.0.0.0:${PORT}${MCP_PATH}`);
});
