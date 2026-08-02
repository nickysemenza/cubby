import { createFileRoute } from "@tanstack/react-router";

// Dynamic imports: static imports of the MCP SDK cause the entire server to
// crash during Vite HMR. Deferring to request time isolates the failure.
async function handler({ request }: { request: Request }) {
  try {
    const { handleMcpRequest } = await import("~/server/mcp/server");
    const { unauthorizedResponse, verifyMcpToken } = await import(
      "~/server/mcp/auth"
    );
    const { domainRouter } = await import("~/server/api/domain");
    const { createCallerFactory, createTRPCContext } = await import(
      "~/server/api/trpc"
    );
    const { emitTelemetry } = await import("~/server/telemetry");
    const createCaller = createCallerFactory(domainRouter);

    // OAuth 2.1 only. Clients (claude.ai connectors, Claude Code) discover the
    // flow from the WWW-Authenticate header on this 401, register dynamically,
    // and come back with a JWT access token.
    const actor = await verifyMcpToken(request);
    if (!actor) return unauthorizedResponse();

    const ctx = await createTRPCContext({
      headers: request.headers,
      actor: { ...actor, source: "mcp" },
    });

    const caller = createCaller(ctx);

    return await handleMcpRequest(request, {
      token: "",
      clientId: actor.clientId ?? "unknown-oauth-client",
      scopes: [],
      extra: {
        caller,
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

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
