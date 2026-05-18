import debugPanel from "../debug-panel/index.html";

import { createDebugAgentService } from "./debug-agent-service";

const port = Number(Bun.env.PORT ?? 3001);
const service = createDebugAgentService();

Bun.serve({
  port,
  idleTimeout: 255,
  routes: {
    "/": debugPanel,
    "/internal/debug": debugPanel,
  },
  fetch: service.fetch,
  development: Bun.env.NODE_ENV !== "production",
});

console.info(`Helixent debug agent service listening on http://localhost:${port}/internal/debug`);
