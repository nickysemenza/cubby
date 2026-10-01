import { createFileRoute } from "@tanstack/react-router";

import { getPurchaseImportNamespace } from "~/server/cf-env";
import { createRequestContext, requireActor } from "~/server/request-context";

async function handler(input: {
  request: Request;
  params: { publicId: string; _splat?: string };
}) {
  const context = requireActor(
    await createRequestContext({ headers: input.request.headers }),
  );
  // Loaded on request: run-service reaches the AI SDK stack.
  const { controlRun, loadRunScopeByShortcode } =
    await import("~/server/purchase-import/run-service");
  const party = await context.currentParty();
  if (!party)
    return Response.json(
      { error: "Member identity is required" },
      { status: 403 },
    );
  const suffix = input.params._splat ?? "";
  if (input.request.method === "POST" && suffix === "abort") {
    const cancellation = await controlRun(context.db, context.actorContext, {
      runPublicId: input.params.publicId,
      action: "cancel",
    });
    if (cancellation.cancelledBrowserCommandIds) {
      const scope = await loadRunScopeByShortcode(
        context.db,
        input.params.publicId,
      );
      const namespace = getPurchaseImportNamespace();
      if (namespace && scope.public.vendorAccountId) {
        const broker = namespace.getByName(scope.public.vendorAccountId);
        await Promise.all(
          cancellation.cancelledBrowserCommandIds.map((commandId) =>
            broker.cancel(commandId),
          ),
        );
      }
    }
  }
  // Loaded on request: the proxy reaches run-service and the AI SDK stack.
  const { proxyPurchaseAgentRequest } =
    await import("~/server/purchase-import/agent-proxy");
  return await proxyPurchaseAgentRequest({
    request: input.request,
    publicId: input.params.publicId,
    suffix,
    context,
    party,
  });
}

export const Route = createFileRoute("/api/import/runs/$publicId/agent/$")({
  server: {
    handlers: { GET: handler, HEAD: handler, POST: handler },
  },
});
