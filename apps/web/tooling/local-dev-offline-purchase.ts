import type { MessageBatch } from "@cloudflare/workers-types";

const refusal =
  "Purchase agent is unavailable in offline local development. Restart with CUBBY_DEV_PROFILE=integrations and isolated development AI bindings.";

export default {
  fetch(): Response {
    return Response.json(
      { error: "provider_unavailable", message: refusal },
      { status: 503 },
    );
  },
  queue(batch: MessageBatch<unknown>): never {
    batch.retryAll();
    throw new Error(refusal);
  },
};
