import { createFileRoute } from "@tanstack/react-router";

async function handler({ request }: { request: Request }) {
  // Dynamic import: static MCP SDK imports crash the Vite HMR server.
  const { handleMcpHttpRequest } = await import("~/server/mcp/http-handler");
  return await handleMcpHttpRequest(request);
}

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
