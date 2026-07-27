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
    const createCaller = createCallerFactory(domainRouter);

    // OAuth 2.1 only. Clients (claude.ai connectors, Claude Code) discover the
    // flow from the WWW-Authenticate header on this 401, register dynamically,
    // and come back with a JWT access token.
    const actor = await verifyMcpToken(request);
    if (!actor) return unauthorizedResponse();

    const ctx = await createTRPCContext({
      headers: request.headers,
      actor: { ...actor, source: "api" },
    });

    const caller = createCaller(ctx);

    return await handleMcpRequest(request, {
      token: "",
      clientId: "cubby-mcp",
      scopes: [],
      extra: { caller },
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
