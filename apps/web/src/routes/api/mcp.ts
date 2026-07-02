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

    // API key is accepted via header ONLY (Authorization: Bearer <apiKey>, or
    // the x-api-key header directly). A `?key=` query-param path was removed for
    // security: query strings land in server access logs, browser history, and
    // Referer headers, and with Sentry `sendDefaultPii: true` the full request
    // URL (incl. query) is attached to captured events. Since the key is a
    // permanent, unthrottled credential (see lib/auth.ts apiKey plugin), a single
    // leaked URL would be a durable full-access credential. Use a header.
    const headers = new Headers(request.headers);
    const authHeader = headers.get("authorization");
    if (authHeader?.startsWith("Bearer ") && !headers.has("x-api-key")) {
      headers.set("x-api-key", authHeader.slice(7));
      headers.delete("authorization");
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
