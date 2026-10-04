import { importRunIdFromAgentIdentity } from "@cubby/schemas/import-run-agent";
import * as Sentry from "@sentry/cloudflare";
import { getAgentByName } from "agents";

import { consumePurchaseAgentQueue } from "./cloudflare";
import { internalAgentRoute } from "./internal-agent-route";
import { PurchaseImportRunAgent as RunAgent } from "./run-agent";
import { purchaseAgentSentryOptions } from "./sentry";

// The SDK initializes inside the Durable Object once per isolate; native
// Workers Traces own spans (tracesSampleRate 0).
export const PurchaseImportRunAgent = Sentry.instrumentDurableObjectWithSentry(
  (env: CloudflareBindings) => purchaseAgentSentryOptions(env),
  RunAgent,
);

// No public route or workers.dev hostname is configured for this Worker. The
// marker additionally prevents accidental use by another service binding;
// the web Worker remains responsible for user auth before proxying.
async function fetchAgent(
  request: Request,
  env: CloudflareBindings,
): Promise<Response> {
  const routed = internalAgentRoute(request);
  if (!("request" in routed))
    return new Response(routed.status === 403 ? "Forbidden" : "Not found", {
      status: routed.status,
    });
  const url = new URL(routed.request.url);
  const [encodedId = "", ...rest] = url.pathname
    .replace(/^\/+/u, "")
    .split("/");
  const agentId = decodeURIComponent(encodedId);
  if (!importRunIdFromAgentIdentity(agentId))
    return new Response("Not found", { status: 404 });
  url.pathname = `/${rest.join("/")}`;
  const agent = await getAgentByName(env.PURCHASE_IMPORT_RUN, agentId);
  return agent.fetch(new Request(url, routed.request));
}

export default Sentry.withSentry(
  (env: CloudflareBindings) => purchaseAgentSentryOptions(env),
  {
    fetch: (request, env) => fetchAgent(request, env),
    queue: (batch, env) => consumePurchaseAgentQueue(batch, env),
  } satisfies ExportedHandler<CloudflareBindings>,
);
