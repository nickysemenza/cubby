import { setProvider } from "@flue/runtime";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import { env } from "cloudflare:workers";

// Flue's generated entry sees this registered provider and does not install a
// second default. Every model request, including compaction and retries, uses
// Cubby's mandatory AI Gateway.
setProvider(
  cloudflareBindingProvider({
    binding: env.AI,
    gateway: {
      id: "cubby",
      metadata: { jobKind: "purchase_import_run" },
    },
  }),
);

// This Worker is private. The generated fetch exists only for Flue runtime
// plumbing and deliberately exposes no public application route.
export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
