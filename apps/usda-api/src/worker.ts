import * as Sentry from "@sentry/cloudflare";
import { registerSentryErrorCapture, withSpan } from "@cubby/worker-tracing";
import { createUsdaApp } from "./app.js";
import { createEdgeUsdaDataSource } from "./data/edge.js";
import type { EdgeBindings } from "./data/cloudflare-types.js";

let app: ReturnType<typeof createUsdaApp> | undefined;

const handler = {
  fetch(request: Request, env: EdgeBindings, executionContext: unknown) {
    if (!app) {
      app = createUsdaApp(createEdgeUsdaDataSource(env), {
        logRequests: true,
      });
      // Hono catches route throws and returns a 500 without rethrowing, so
      // `Sentry.withSentry`'s throw-only auto-capture below never sees them.
      registerSentryErrorCapture(app, Sentry.captureException);
    }
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

// Error capture into the shared `cubby` Sentry project, tagged `service:usda-api`
// so this worker's exceptions (CPU/OOM/throws) surface at their source rather
// than as a downstream JSON-parse error on the web side (see CUBBY-AH).
// `@cubby/worker-tracing` (OTel) keeps owning spans, so tracesSampleRate is 0.
// `withSentry`'s auto-capture only fires on a throw that escapes `fetch`; Hono
// swallows route throws into a 500 response instead, so the
// `registerSentryErrorCapture` call above is what actually reports those.
export default Sentry.withSentry(
  () => ({
    // Public DSN — canonical copy in apps/web/src/lib/sentry-dsn.ts.
    dsn: "https://a50b2f76dd1586f95cdd29cd13a6c0dc@o83311.ingest.us.sentry.io/4508775559135232",
    tracesSampleRate: 0,
    initialScope: { tags: { service: "usda-api" } },
  }),
  handler,
);
