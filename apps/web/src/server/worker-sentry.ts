import { SENTRY_DATA_COLLECTION } from "@cubby/worker-tracing/sentry-data-collection";
import { CUBBY_SENTRY_DSN } from "@cubby/worker-tracing/sentry-dsn";
import type * as Sentry from "@sentry/cloudflare";

import {
  resolveWorkerSentryEnvironment,
  workerSentryEnabled,
} from "~/lib/sentry-environment";
import { SENTRY_IGNORED_ERRORS } from "~/lib/sentry-noise";
import { scrubSentryEvent } from "~/lib/sentry-scrub";

/**
 * The one Sentry configuration of the Worker: its handlers (`cf-server.ts`)
 * and the purchase agent's Durable Object share it.
 */
export function workerSentryOptions(env: Env): Sentry.CloudflareOptions {
  return {
    dsn: CUBBY_SENTRY_DSN,
    // The e2e harness identity (see `tests/e2e/e2e-worker-runtime.ts`) must
    // never ship envelopes to the real DSN.
    enabled: workerSentryEnabled(env),
    dataCollection: SENTRY_DATA_COLLECTION,
    release: `cubby@${__GIT_COMMIT__}`,
    // Covers queue/cron events without request URLs. Deployed previews retain
    // production reporting (NODE_ENV stays "production" there;
    // only `preview:cf`'s local `wrangler dev` overrides it to "development")
    // because they access the production database.
    environment: resolveWorkerSentryEnvironment(env),
    // Keep the scrubber as defense in depth for manually attached request data,
    // even though the SDK no longer sends default PII.
    beforeSend: scrubSentryEvent,
    // Drop known-noise messages before send — free-plan quota hygiene.
    ignoreErrors: SENTRY_IGNORED_ERRORS,
    // Cloudflare native tracing already exports server spans. A sampled
    // browser `sentry-trace` header overrides `tracesSampleRate: 0` in Sentry,
    // so use a sampler to decline even inherited performance traces. Error
    // capture remains enabled.
    tracesSampler: () => 0,
  };
}
