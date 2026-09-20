/** Shared HTTP ingress for the public MCP route and the private Worker binding. */
export async function handleMcpHttpRequest(request: Request) {
  try {
    const { handleMcpRequest } = await import("~/server/mcp/server");
    const { unauthorizedResponse, verifyMcpToken } =
      await import("~/server/mcp/auth");
    const { McpOperationContext } =
      await import("~/server/mcp/operation-context");
    const { createRequestContext, requireActor } =
      await import("~/server/request-context");
    const { emitTelemetry } = await import("~/server/telemetry");
    const { findActivePurchaseAgentGrant } =
      await import("~/server/purchase-import/agent-auth");

    const actor = await verifyMcpToken(request);
    if (!actor) return unauthorizedResponse();

    const ctx = requireActor(
      await createRequestContext({
        headers: request.headers,
        actor: { ...actor, source: "mcp" },
      }),
    );
    if (actor.purchaseAgentRunId) {
      const grant = actor.purchaseAgentGrantId
        ? await findActivePurchaseAgentGrant(
            ctx.db,
            actor.userId,
            actor.purchaseAgentGrantId,
          )
        : null;
      if (!grant) return unauthorizedResponse();
      const { loadRunScope } =
        await import("~/server/purchase-import/run-service");
      const [scope, party] = await Promise.all([
        loadRunScope(ctx.db, actor.purchaseAgentRunId),
        ctx.currentParty(),
      ]);
      if (
        scope.actorUserId !== actor.userId ||
        !party ||
        party.id !== scope.ledgerPartyId
      ) {
        return unauthorizedResponse();
      }
    }

    return await handleMcpRequest(request, {
      token: "",
      clientId: actor.clientId ?? "unknown-oauth-client",
      scopes: [],
      extra: {
        operationContext: new McpOperationContext(ctx),
        purchaseAgent:
          actor.purchaseAgentRunId && actor.purchaseAgentGrantId
            ? {
                runId: actor.purchaseAgentRunId,
                grantId: actor.purchaseAgentGrantId,
              }
            : undefined,
        telemetry: {
          identity: {
            userId: actor.userId,
            clientId: actor.clientId,
            surface: "external_mcp",
          },
          emit: (event: Parameters<typeof emitTelemetry>[1]) =>
            emitTelemetry(ctx.db, event),
        },
      },
    });
  } catch (error) {
    console.error("[MCP] Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
