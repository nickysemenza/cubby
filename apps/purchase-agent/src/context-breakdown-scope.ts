import { getCloudflareContext } from "@flue/runtime/cloudflare";

import {
  createContextRecorder,
  type ContextBreakdown,
} from "./context-breakdown";

/** One isolate-wide buffer; entries are keyed by the owning Durable Object. */
const contextRecorder = createContextRecorder();

/**
 * The Durable Object that owns the current model call or response hook.
 * Flue scopes its Cloudflare context with AsyncLocalStorage, so provider
 * fetches and response hooks of one agent instance resolve the same id even
 * when several instances share an isolate.
 */
function currentContextScope(): string {
  try {
    return getCloudflareContext().durableObjectIdentity?.id ?? "isolate";
  } catch {
    return "isolate";
  }
}

/** Drains this agent instance's measured calls for response metadata. */
export function takeContextBreakdown(): ContextBreakdown | undefined {
  return contextRecorder.take(currentContextScope());
}

/** Provider fetch capture wired in app.ts via `cubbyAiGatewayProviders`. */
export const contextCapture = {
  recorder: contextRecorder,
  scope: currentContextScope,
};
