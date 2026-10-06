import { runEntityId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import { withErrorReporting } from "~/server/errors/report-error";
import { normalizeStartOperationError } from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";

const log = createLogger("MCP");

/**
 * Authenticates one MCP request and serves it. `authenticated` marks the point
 * after which a failure may show the authenticated caller its raw cause.
 */
export type McpServe = (
  request: Request,
  authenticated: () => void,
) => Promise<Response>;

/** Shared HTTP ingress for the public MCP route and the private Worker binding. */
export async function handleMcpHttpRequest(
  request: Request,
  serve: McpServe = serveAuthenticatedMcp,
) {
  return withErrorReporting(async () => {
    let actorVerified = false;
    // Kept for a failure's JSON-RPC id and tool name. Read once up front: an
    // unread `clone()` branch makes workerd warn on every request.
    const body = request.method === "POST" ? await request.text() : undefined;
    try {
      return await serve(
        body === undefined
          ? request
          : new Request(request, { method: "POST", body }),
        () => {
          actorVerified = true;
        },
      );
    } catch (error) {
      log.error("Error", { error });
      return jsonRpcFailure(request.headers, body, error, actorVerified);
    }
  }, request.headers);
}

const jsonRpcCall = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().optional(),
  params: z
    .object({
      name: z.string().optional(),
      arguments: z.object({ action: z.string().optional() }).optional(),
    })
    .optional(),
});

function readCall(
  body: string | undefined,
): z.infer<typeof jsonRpcCall> | undefined {
  if (body === undefined) return undefined;
  try {
    return jsonRpcCall.safeParse(JSON.parse(body)).data;
  } catch {
    // SILENT: an unparseable body has no id to echo; the error answers with null.
    return undefined;
  }
}

/**
 * A failure that escaped the SDK still answers in JSON-RPC: a client proxy
 * reports an empty or non-JSON-RPC body only as "Invalid content from server",
 * losing the tool, cause, and request id.
 */
function jsonRpcFailure<TError>(
  headers: Headers,
  body: string | undefined,
  error: TError,
  authenticated: boolean,
): Response {
  const call = readCall(body);
  const tool = call?.params?.name;
  const action = call?.params?.arguments?.action;
  const target = tool ? (action ? `${tool}.${action}` : tool) : call?.method;
  const detail = normalizeStartOperationError(
    error,
    authenticated ? "dispatch" : "context",
    getRequestId(headers),
    { operation: "mcp", authenticated, headers },
  ).publicError;
  const request = detail.requestId
    ? ` (Cubby request ${detail.requestId})`
    : "";
  return Response.json(
    {
      jsonrpc: "2.0",
      id: call?.id ?? null,
      error: {
        code: -32603,
        message: `${target ? `${target} failed` : "Cubby MCP request failed"}: ${detail.message}${request}`,
        data: detail,
      },
    },
    { status: 500 },
  );
}

async function serveAuthenticatedMcp(
  request: Request,
  authenticated: () => void,
): Promise<Response> {
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
  authenticated();

  const ctx = requireActor(
    await createRequestContext({
      headers: request.headers,
      actor: {
        userId: actor.userId,
        sessionId: actor.sessionId,
        channel: "mcp",
        oauthClientId: actor.clientId,
        // The agent's token is scoped to its run, so everything it writes
        // inherits that run (validated against the grant below).
        runId: actor.purchaseAgentRunId
          ? runEntityId.parse(actor.purchaseAgentRunId)
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
}
