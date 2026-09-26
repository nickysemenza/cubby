// Sentry first: its bridge and OpenTelemetry instrumentation must register
// before the generated Worker entry evaluates.
import "./sentry";
import { instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { createAgentRouter } from "@flue/runtime/routing";
import { env } from "cloudflare:workers";

import {
  cubbyAiGatewayProviders,
  type PurchaseAgentTestModelBinding,
} from "./cubby-ai-provider";
import { internalAgentRoute } from "./internal-agent-route";
import { PurchaseImportRun } from "./purchase-import-run";
import { contextCapture } from "./context-breakdown-scope";

// This named binding exists only in the workerd harness configuration. It is
// deliberately not declared in wrangler.jsonc, so deployed requests fail
// closed to the mandatory Universal Gateway transport below.
// SAFETY: the optional extension describes only the test-harness binding;
// production CloudflareBindings remains unchanged and cannot supply it.
const testModel = (
  env as typeof env & {
    CUBBY_PURCHASE_AGENT_TEST_MODEL?: PurchaseAgentTestModelBinding;
  }
).CUBBY_PURCHASE_AGENT_TEST_MODEL;

// Native Workers Traces (Grafana Tempo). Flue's default install of this same
// instrumentation ships conversation content — messages, system instructions,
// tool definitions, arguments, and results — as span attributes; the
// wrangler.jsonc policy keeps that content in the authenticated Flue transcript
// only. Registering it here, in a hoisted `app.ts` import, makes the generated
// entry's default installer yield to this content-free configuration.
instrument(createCloudflareTracing({ content: false }));

// Every production model request, including Flue compaction and retries, uses
// the same Universal Gateway/BYOK transport as Cubby's web Worker.
for (const provider of cubbyAiGatewayProviders(
  () => env.AI,
  testModel,
  contextCapture,
)) {
  setProvider(provider);
}

const purchaseImportRouter = createAgentRouter(PurchaseImportRun);

// No public route or workers.dev hostname is configured for this Worker. The
// marker additionally prevents accidental use by another service binding;
// the web Worker remains responsible for user auth before proxying a request.
export default {
  fetch(request: Request, bindings: CloudflareBindings, ctx: ExecutionContext) {
    const routed = internalAgentRoute(request);
    if (!("request" in routed)) {
      return new Response(routed.status === 403 ? "Forbidden" : "Not found", {
        status: routed.status,
      });
    }
    return purchaseImportRouter.fetch(routed.request, bindings, ctx);
  },
};
