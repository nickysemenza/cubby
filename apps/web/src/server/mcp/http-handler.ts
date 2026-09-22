import { importRunId } from "@cubby/schemas/identifiers";

import { withErrorReporting } from "~/server/errors/report-error";
import { normalizeStartOperationError } from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";

/** Shared HTTP ingress for the public MCP route and the private Worker binding. */
export async function handleMcpHttpRequest(request: Request) {
  return withErrorReporting(async () => {
    let actorVerified = false;
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
      actorVerified = true;

      const ctx = requireActor(
        await createRequestContext({
          headers: request.headers,
          actor: {
            userId: actor.userId,
            sessionId: actor.sessionId,
            channel: "mcp",
            oauthClientId: actor.clientId,
            // Flue's token is scoped to its run, so everything it writes
            // inherits that run (validated against the grant below).
            runId: actor.purchaseAgentRunId
              ? importRunId.parse(actor.purchaseAgentRunId)
              : null,
          },
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
      const detail = normalizeStartOperationError(
        error,
        "context",
        getRequestId(request.headers),
        {
          operation: "mcp",
          authenticated: actorVerified,
          headers: request.headers,
        },
      ).publicError;
      return new Response(
        JSON.stringify({
          error: detail.message,
          diagnostics: detail.diagnostics,
          requestId: detail.requestId,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }, request.headers);
}
