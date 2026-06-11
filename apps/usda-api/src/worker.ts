import { createUsdaApp } from "./app.js";
import { createEdgeUsdaDataSource } from "./data/edge.js";
import type { EdgeBindings } from "./data/cloudflare-types.js";

let app: ReturnType<typeof createUsdaApp> | undefined;

export default {
  fetch(request: Request, env: EdgeBindings, executionContext: unknown) {
    app ??= createUsdaApp(createEdgeUsdaDataSource(env), {
      logRequests: true,
    });
    return app.fetch(request, env, executionContext as never);
  },
};
