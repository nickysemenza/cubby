import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { z } from "zod";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { dispatchInputForEvent } from "#web/src/server/domains/purchase-agent/service/dispatch-input.ts";
import type { PurchaseImportRunAgent } from "#web/src/server/worker-bindings.ts";

export default {
  async fetch(
    request: Request,
    env: {
      BACKGROUND_QUEUE: { send(message: unknown): Promise<void> };
      PURCHASE_AGENT_RUN_CLIENT: DurableObjectNamespace<PurchaseImportRunAgent>;
    },
  ) {
    const url = new URL(request.url);
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/wake") {
      await env.BACKGROUND_QUEUE.send({ version: 3, queueType: "background" });
      return new Response(null, { status: 202 });
    }
    if (
      url.pathname === "/coordinator-fetch" ||
      url.pathname === "/coordinator-transcript"
    ) {
      const input = z
        .object({ agentId: z.string() })
        .parse(await request.json());
      const response = await env.PURCHASE_AGENT_RUN_CLIENT.getByName(
        input.agentId,
      ).fetch(
        url.pathname === "/coordinator-transcript"
          ? "https://coordinator.test/transcript"
          : "https://coordinator.test/",
      );
      return new Response(await response.text(), { status: response.status });
    }
    if (url.pathname === "/coordinator-retire") {
      const input = z
        .object({ agentId: z.string() })
        .parse(await request.json());
      return Response.json(
        await env.PURCHASE_AGENT_RUN_CLIENT.getByName(input.agentId).retire(),
      );
    }
    if (url.pathname === "/coordinator-dispatch") {
      const input = z
        .object({
          agentId: z.string(),
          purpose: agentImportRunPurpose,
          event: purchaseAgentEvent,
        })
        .parse(await request.json());
      return Response.json(
        await env.PURCHASE_AGENT_RUN_CLIENT.getByName(input.agentId).dispatch(
          dispatchInputForEvent(input.event, input.purpose),
        ),
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
