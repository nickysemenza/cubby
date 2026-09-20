import { createFileRoute } from "@tanstack/react-router";

import { proxyPurchaseAgentRequest } from "~/server/purchase-import/agent-proxy";
import { createRequestContext, requireActor } from "~/server/request-context";

async function handler(input: {
  request: Request;
  params: { publicId: string };
}) {
  const context = requireActor(
    await createRequestContext({ headers: input.request.headers }),
  );
  const party = await context.currentParty();
  if (!party)
    return Response.json(
      { error: "Member identity is required" },
      { status: 403 },
    );
  return await proxyPurchaseAgentRequest({
    request: input.request,
    publicId: input.params.publicId,
    context,
    party,
  });
}

export const Route = createFileRoute("/api/import/runs/$publicId/agent")({
  server: {
    handlers: { GET: handler, HEAD: handler, POST: handler },
  },
});
