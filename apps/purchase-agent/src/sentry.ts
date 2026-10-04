import { SENTRY_DATA_COLLECTION } from "@cubby/worker-tracing/sentry-data-collection";
import { CUBBY_SENTRY_DSN } from "@cubby/worker-tracing/sentry-dsn";
import type * as Sentry from "@sentry/cloudflare";

export interface SentryAgentEnv {
  SENTRY_ENVIRONMENT?: string;
}

// Sentry ships integrations that patch AI provider SDKs directly. Native
// Workers Traces own the platform spans; Sentry receives errors only, never
// message or tool content.
const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
  "Anthropic_AI",
  "OpenAI",
  "Google_GenAI",
  "LangChain",
  "LangGraph",
  "VercelAI",
]);

/** The Sentry options shared by the agent Durable Object and the Worker. */
export function purchaseAgentSentryOptions(
  bindings: SentryAgentEnv,
): Sentry.CloudflareOptions {
  return {
    dsn: CUBBY_SENTRY_DSN,
    // "test" is what the workerd harness sets; every SDK call becomes a no-op.
    enabled: bindings.SENTRY_ENVIRONMENT !== "test",
    environment: bindings.SENTRY_ENVIRONMENT,
    dataCollection: SENTRY_DATA_COLLECTION,
    tracesSampleRate: 0,
    tracesSampler: () => 0,
    initialScope: { tags: { service: "purchase-agent" } },
    integrations: (defaults) =>
      defaults.filter(
        (integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name),
      ),
  };
}
