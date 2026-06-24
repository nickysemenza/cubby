import { withSpan } from "@cubby/worker-tracing";
import { createUsdaApp } from "./app.js";
import { createEdgeUsdaDataSource } from "./data/edge.js";
import type { EdgeBindings } from "./data/cloudflare-types.js";

let app: ReturnType<typeof createUsdaApp> | undefined;

export default {
  fetch(request: Request, env: EdgeBindings, executionContext: unknown) {
    app ??= createUsdaApp(createEdgeUsdaDataSource(env), {
      logRequests: true,
    });
    // Entry span at the very top of the handler. The CF platform's auto root
    // span covers the whole invocation (incl. queue/transport before our code
    // runs); this child span measures *only* the time inside `app.fetch`. The
    // gap between a caller's fetch span and this span's duration is therefore
    // platform overhead (queuing, binding transport), not our handler — exactly
    // the signal we need to explain a 5s caller-side time vs ~500ms of work.
    const url = new URL(request.url);
    return withSpan(
      "usda.request",
      async (span) => {
        const res = await app!.fetch(request, env, executionContext as never);
        span.setAttribute("http.response.status_code", res.status);
        return res;
      },
      { "http.request.method": request.method, "url.path": url.pathname },
    );
  },
};
