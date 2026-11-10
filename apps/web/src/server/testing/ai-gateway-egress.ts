import { aiGatewayId, CF_ACCOUNT_ID } from "@cubby/shared/ai/gateway-metadata";
import { runProviderGateway } from "@cubby/shared/ai/gateway-request";
import { fromPartial } from "@total-typescript/shoehorn";

import { gatewayEgressInput } from "~/server/ai/gateway-egress-contract";

/**
 * The `AI_GATEWAY_EGRESS` binding every runtime has, running its Durable
 * Object's provider transport in-process so the physical `fetch` stays the
 * observed seam. Holds and the plan budget are not modeled.
 */
export const gatewayEgressEnv = (token = "synthetic-gateway-token") => ({
  AI_GATEWAY_EGRESS: {
    getByName: () =>
      fromPartial<ReturnType<Env["AI_GATEWAY_EGRESS"]["getByName"]>>({
        fetch: async (request: Request) => {
          const input = gatewayEgressInput.parse(await request.json());
          return runProviderGateway({
            accountId: CF_ACCOUNT_ID,
            gatewayId: aiGatewayId(input.controls.metadata.environment),
            token,
            provider: input.provider,
            controls: input.controls,
            request: {
              endpoint: input.endpoint,
              input: new URL(`https://gateway.internal/${input.endpoint}`),
              init: { method: "POST" },
              headers: new Headers(input.headers),
              signal: request.signal,
              query: async () => input.query,
            },
          });
        },
      }),
  },
});
