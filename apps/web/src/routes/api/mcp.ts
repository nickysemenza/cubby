import { createFileRoute } from "@tanstack/react-router";

// Dynamic imports: static imports of the MCP SDK cause the entire server to
// crash during Vite HMR. Deferring to request time isolates the failure.
async function handler({ request }: { request: Request }) {
  try {
    const { handleMcpRequest } = await import("~/server/mcp/server");
    const { buildActorContext } = await import("@cubby/schemas/context");
    const { appRouter } = await import("~/server/api/root");
    const { createCallerFactory, createTRPCContext } = await import(
      "~/server/api/trpc"
    );
    const createCaller = createCallerFactory(appRouter);

    // Map Authorization: Bearer → x-api-key for better-auth compatibility
    const headers = new Headers(request.headers);
    const authHeader = headers.get("authorization");
    if (authHeader?.startsWith("Bearer ") && !headers.has("x-api-key")) {
      headers.set("x-api-key", authHeader.slice(7));
      headers.delete("authorization");
    }

    // Fallback: accept the API key as a `?key=` query param. The claude.ai
    // custom-connector dialog only takes a URL (no header field), so a
    // single-user instance can paste `…/api/mcp?key=<apiKey>` instead of
    // standing up an OAuth flow. Header still wins if both are present.
    if (!headers.has("x-api-key")) {
      const key = new URL(request.url).searchParams.get("key");
      if (key) headers.set("x-api-key", key);
    }

    const ctx = await createTRPCContext({ headers });

    if (!ctx.auth.userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const apiCtx = {
      ...ctx,
      actorContext: buildActorContext(ctx.auth.userId, "api"),
    };

    const caller = createCaller(apiCtx);

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
