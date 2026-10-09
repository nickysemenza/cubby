import { runEntityId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  readRequestBody,
} from "@modelcontextprotocol/server";
import { type JSONType, z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { AppError } from "~/server/errors/app-error";
import { withErrorReporting } from "~/server/errors/report-error";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";
import { unauthorizedResponse, verifyMcpToken } from "~/server/mcp/auth";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { handleMcpRequest } from "~/server/mcp/server";
import { findActivePurchaseAgentGrant } from "~/server/purchase-import/agent-auth";
import { loadRunScope } from "~/server/purchase-import/run-service";
import { createRequestContext, requireActor } from "~/server/request-context";
import { normalizeStartOperationError } from "~/server/start-operation.server";
import { emitTelemetry } from "~/server/telemetry";
import { getRequestId } from "~/server/tracing";

const log = createLogger("MCP");

/** A POST body read once, for the SDK and for a failure's JSON-RPC id. */
type McpRequestBody = {
  /** The request to hand the SDK; its body is the text already read. */
  request: Request;
  /** The parsed JSON-RPC message, absent when the body is empty or not JSON. */
  parsedBody: JSONType | undefined;
};

/** What serving reports back to the ingress so a failure can describe itself. */
interface McpRequestProgress {
  /** From here on a failure shows the caller its raw cause. */
  authenticated(): void;
  /**
   * Read the body once, bounded by the SDK's own request limit. Call it only
   * after authentication: an unauthenticated upload is never buffered.
   */
  readBody(): Promise<McpRequestBody>;
}

/** Authenticates one MCP request and serves it. */
export type McpServe = (
  request: Request,
  progress: McpRequestProgress,
) => Promise<Response>;

/** Shared HTTP ingress for the public MCP route and the private Worker binding. */
export async function handleMcpHttpRequest(
  request: Request,
  serve: McpServe = serveAuthenticatedMcp,
) {
  return withErrorReporting(async () => {
    const startedAt = performance.now();
    let actorVerified = false;
    let body: string | undefined;
    const progress: McpRequestProgress = {
      authenticated: () => {
        actorVerified = true;
      },
      readBody: async () => {
        if (request.method !== "POST")
          return { request, parsedBody: undefined };
        const read = await readRequestBody(
          request,
          DEFAULT_MAX_REQUEST_BODY_SIZE,
        );
        if (read.tooLarge)
          throw new AppError({
            code: "BAD_REQUEST",
            reason: "MCP_REQUEST_TOO_LARGE",
            message: `The MCP request body is over the ${DEFAULT_MAX_REQUEST_BODY_SIZE} byte limit`,
          });
        body = read.text;
        return {
          request: new Request(request, { method: "POST", body }),
          parsedBody: parseJson(body),
        };
      },
    };
    try {
      return await serve(request, progress);
    } catch (error) {
      log.error("Error", { error });
      return await jsonRpcFailure({
        headers: request.headers,
        body,
        error,
        authenticated: actorVerified,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    }
  }, request.headers);
}

function parseJson(body: string): JSONType | undefined {
  try {
    return z.json().safeParse(JSON.parse(body)).data;
  } catch {
    // SILENT: the SDK answers an unparseable body with its own parse error.
    return undefined;
  }
}

// Each field parses on its own, so a malformed tool hint never costs the id.
const jsonRpcId = z.object({ id: z.union([z.string(), z.number()]) });
const jsonRpcMethod = z.object({ method: z.string() });
const toolName = z.object({ params: z.object({ name: z.string() }) });
const toolAction = z.object({
  params: z.object({ arguments: z.object({ action: z.string() }) }),
});

/**
 * Whether `tool.action` writes, from the generated bindings; a call naming no
 * known action falls back to the tool's own read-only flag.
 */
function callWrites(
  tool: string | undefined,
  action: string | undefined,
): boolean | undefined {
  if (!tool) return undefined;
  const binding = Object.entries(MCP_TOOL_BINDINGS).find(
    ([name]) => name === tool,
  )?.[1];
  if (!binding) return undefined;
  const kind = Object.entries(binding.actions).find(
    ([name]) => name === action,
  )?.[1].kind;
  return kind ? kind === "mutation" : !binding.readOnly;
}

const jsonString = z.string();
const scrubStrings = <T>(value: T): JSONType =>
  z.json().parse(
    JSON.parse(JSON.stringify(value), (_key, entry) => {
      const text = jsonString.safeParse(entry);
      return text.success ? scrubErrorMessage(text.data) : entry;
    }),
  );

/**
 * A failure that escaped the SDK still answers in JSON-RPC: a client proxy
 * reports an empty or non-JSON-RPC body only as "Invalid content from server",
 * losing the tool, cause, and request id.
 */
async function jsonRpcFailure<TError>(failure: {
  headers: Headers;
  body: string | undefined;
  error: TError;
  authenticated: boolean;
  elapsedMs: number;
}): Promise<Response> {
  const { headers, error, authenticated, elapsedMs } = failure;
  const message = failure.body ? parseJson(failure.body) : undefined;
  const tool = toolName.safeParse(message).data?.params.name;
  const action = toolAction.safeParse(message).data?.params.arguments.action;
  const target = tool
    ? action
      ? `${tool}.${action}`
      : tool
    : jsonRpcMethod.safeParse(message).data?.method;
  const detail = normalizeStartOperationError(
    error,
    authenticated ? "dispatch" : "context",
    getRequestId(headers),
    { operation: "mcp", authenticated, headers },
  ).publicError;
  const tooLarge = detail.reason === "MCP_REQUEST_TOO_LARGE";
  const writes = callWrites(tool, action);
  const request = detail.requestId ? `; Cubby request ${detail.requestId}` : "";
  // Present only when the failure was captured (not sampled out, DSN set).
  const sentry = detail.diagnostics?.sentryEventId
    ? `; Sentry ${detail.diagnostics.sentryEventId}`
    : "";
  const next =
    writes === true
      ? " The write may have completed; re-read the affected records before retrying."
      : "";
  return Response.json(
    {
      jsonrpc: "2.0",
      id: jsonRpcId.safeParse(message).data?.id ?? null,
      error: {
        code: tooLarge ? -32600 : -32603,
        // Scrub and bound each untrusted part on its own: scrubbing the whole
        // line let the 2,000-char cap or an `authorization:` redaction (which
        // runs to end of line) swallow the elapsed time, request id, and
        // write guidance appended after the cause.
        message: `${target ? `${scrubErrorMessage(target)} failed` : "Cubby MCP request failed"}: ${scrubErrorMessage(detail.message)} (after ${elapsedMs} ms${request}${sentry}).${next}`,
        data: scrubStrings({ ...detail, elapsedMs }),
      },
    },
    { status: tooLarge ? 413 : 500 },
  );
}

async function serveAuthenticatedMcp(
  request: Request,
  progress: McpRequestProgress,
): Promise<Response> {
  const actor = await verifyMcpToken(request);
  if (!actor) return unauthorizedResponse();
  progress.authenticated();
  const { request: served, parsedBody } = await progress.readBody();

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

  return await handleMcpRequest(served, parsedBody, {
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
