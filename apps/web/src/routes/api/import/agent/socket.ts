import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/import/agent/socket")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        // Route modules ship in the router chunk; the socket graph loads on upgrade.
        const { handleDirectBrowserSocketUpgrade } =
          await import("~/server/purchase-import/direct-socket-route");
        return handleDirectBrowserSocketUpgrade(request);
      },
    },
  },
});
