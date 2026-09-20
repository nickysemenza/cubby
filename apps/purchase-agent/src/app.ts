import { setProvider } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { env } from "cloudflare:workers";

import { cubbyAiGatewayProviders } from "./cubby-ai-provider";
import { internalAgentRoute } from "./internal-agent-route";
import { PurchaseImportRun } from "./purchase-import-run";

// Every model request, including Flue compaction and retries, uses the same
// Universal Gateway/BYOK transport as Cubby's web Worker.
for (const provider of cubbyAiGatewayProviders(() => env.AI)) {
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
