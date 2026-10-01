import { createFileRoute } from "@tanstack/react-router";

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
  // Loaded on request: the proxy reaches run-service and the AI SDK stack.
  const { proxyPurchaseAgentRequest } =
    await import("~/server/purchase-import/agent-proxy");
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
