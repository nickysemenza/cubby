/* eslint-disable anti-slop/no-unknown-parameters -- This workerd-only transport shim receives Cloudflare Queue wire payloads. */
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { z } from "zod";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { dispatchInputForEvent } from "../../../src/server/purchase-agent/queue-dispatch";
import type { PurchaseImportRunAgent } from "../../../src/server/worker-bindings";

export default {
  async fetch(
    request: Request,
    env: {
      PURCHASE_AGENT_QUEUE: { send(message: unknown): Promise<void> };
      PURCHASE_AGENT_RUN_CLIENT: DurableObjectNamespace<PurchaseImportRunAgent>;
    },
  ) {
    const url = new URL(request.url);
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/dispatch") {
      await env.PURCHASE_AGENT_QUEUE.send(await request.json());
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/coordinator-fetch") {
      const input = z
        .object({ agentId: z.string() })
        .parse(await request.json());
      const response = await env.PURCHASE_AGENT_RUN_CLIENT.getByName(
        input.agentId,
      ).fetch("https://coordinator.test/");
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
