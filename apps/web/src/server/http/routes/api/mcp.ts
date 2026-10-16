import type { HttpRouteHandlers } from "~/lib/http-route-handler";
async function handler({ request }: { request: Request }) {
  // Dynamic import: static MCP SDK imports crash the Vite HMR server.
  const { handleMcpHttpRequest } = await import("~/server/mcp/http-handler");
  return await handleMcpHttpRequest(request);
}

export const handlers: HttpRouteHandlers<
  Record<never, never>,
  "GET" | "POST"
> = {
  GET: handler,
  POST: handler,
};
