import type { HttpRouteHandlers } from "~/lib/http-route-handler";
import {
  createRequestContext,
  requireActor,
} from "~/server/http/request-context";

async function handler(input: {
  request: Request;
  params: { publicId: string; _splat?: string };
}) {
  const context = requireActor(
    await createRequestContext({ headers: input.request.headers }),
  );
  // Loaded on request: run-service reaches the AI SDK stack.
  const { controlRun } =
    await import("~/server/domains/purchase-import/repo/run-service");
  const party = await context.currentParty();
  if (!party)
    return Response.json(
      { error: "Member identity is required" },
      { status: 403 },
    );
  const suffix = input.params._splat ?? "";
  if (input.request.method === "POST" && suffix === "abort")
    await controlRun(context.db, context.actorContext, {
      runPublicId: input.params.publicId,
      action: "cancel",
    });
  // Loaded on request: the proxy reaches run-service and the AI SDK stack.
  const { proxyPurchaseAgentRequest } =
    await import("~/server/domains/purchase-import/service/agent-proxy");
  return await proxyPurchaseAgentRequest({
    request: input.request,
    publicId: input.params.publicId,
    suffix,
    context,
    party,
  });
}

export const handlers: HttpRouteHandlers<
  { publicId: string; _splat: string },
  "GET" | "HEAD" | "POST"
> = { GET: handler, HEAD: handler, POST: handler };
