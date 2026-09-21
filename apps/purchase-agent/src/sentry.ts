// flue-blueprint: tooling/sentry@1
//
// Sentry wiring for the purchase agent, ported from Flue's official
// tooling/sentry blueprint with Cubby adjustments: the DSN is the shared code
// constant rather than a secret, `SENTRY_ENVIRONMENT=test` disables reporting
// (workerd harness), and model / tool content is never recorded — the
// wrangler.jsonc policy is that agent message, tool, and evidence content
// belongs to the authenticated Flue transcript only, so the blueprint's opt-in
// record flags are omitted.
//
// What reaches Sentry: the `invoke_agent` → `chat` / `execute_tool` span
// hierarchy with token usage (via `@flue/opentelemetry`; the Durable Object
// wrapper registers Sentry as the isolate's OTel tracer provider), Flue
// `log.*` calls as Sentry Logs, and issues for terminal failures only (see
// `sentry-bridge.ts`). Native Workers Traces (Grafana Tempo) keep flowing
// unchanged: Flue's Cloudflare tracing instrumentation is keyed separately
// from the OpenTelemetry one, so both stay installed side by side.
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";
import { instrument } from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import * as Sentry from "@sentry/cloudflare";
import { env } from "cloudflare:workers";

import {
  clampRate,
  createSentryObservation,
  purchaseAgentSentryOptions,
  type SentryAgentEnv,
} from "./sentry-bridge";

// Per-isolate `env` bindings are only available inside the DO wrapper below;
// the module-scope `instrument(...)` gate reads the Worker-level `env`. Both
// paths go through `clampRate` so an invalid rate becomes 0 on both.
const tracesSampleRate = clampRate(env.SENTRY_TRACES_SAMPLE_RATE, 0);

// Flue applies `wrap` to the generated agent Durable Object class; the SDK
// initializes there, once per isolate. Do not call `Sentry.init()` here.
export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry(
      (bindings: SentryAgentEnv) => ({
        ...purchaseAgentSentryOptions(
          bindings,
          clampRate(bindings.SENTRY_TRACES_SAMPLE_RATE, 0),
        ),
        // Stream spans to Sentry as each one finishes, so gen_ai children
        // that complete after their parent span are not lost.
        traceLifecycle: "stream",
        streamGenAiSpans: true,
        enableLogs: true,
      }),
      Final,
    ),
});

// `content: false`: spans carry timing, token usage, model identifiers, and
// `flue.*` correlation ids, never prompts, completions, or tool payloads. The
// instrumentation is keyed, so a dev reload replaces the previous registration
// instead of stacking a duplicate.
if (tracesSampleRate > 0) {
  instrument(createOpenTelemetryInstrumentation({ content: false }));
}

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
