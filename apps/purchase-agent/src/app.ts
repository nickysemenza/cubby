import { setProvider } from "@flue/runtime";
import { env } from "cloudflare:workers";

import { cubbyAiGatewayProvider } from "./cubby-ai-provider";

// Every model request, including Flue compaction and retries, uses the same
// Universal Gateway/BYOK transport as Cubby's web Worker.
setProvider(cubbyAiGatewayProvider(() => env.AI));

// This Worker is private. The generated fetch exists only for Flue runtime
// plumbing and deliberately exposes no public application route.
export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
