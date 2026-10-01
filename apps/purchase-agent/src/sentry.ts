// Sentry receives purchase-agent errors and logs. Flue's separately installed
// native Cloudflare instrumentation owns spans without recording message content.
import { instrument } from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import * as Sentry from "@sentry/cloudflare";

import {
  createSentryObservation,
  purchaseAgentSentryOptions,
  type SentryAgentEnv,
} from "./sentry-bridge";

// Flue applies `wrap` to the generated agent Durable Object class; the SDK
// initializes there, once per isolate. Do not call `Sentry.init()` here.
export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry(
      // Sentry 11 captures logs whenever `Sentry.logger` is called; there is
      // no `enableLogs` switch.
      (bindings: SentryAgentEnv) => purchaseAgentSentryOptions(bindings),
      Final,
    ),
});

instrument({
  // Keyed registration: production isolates evaluate this module once; under
  // dev reloads the newest install wins and the previous one is disposed.
  key: Symbol.for("flue.sentry.bridge"),
  observe: createSentryObservation(Sentry),
  interceptor: (_operation, _ctx, next) => next(),
  async dispose() {
    await Sentry.flush(2000);
  },
});
