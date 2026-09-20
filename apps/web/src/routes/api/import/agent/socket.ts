import { createFileRoute } from "@tanstack/react-router";

import { handleDirectBrowserSocketUpgrade } from "~/server/purchase-import/direct-socket-route";

export const Route = createFileRoute("/api/import/agent/socket")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        return handleDirectBrowserSocketUpgrade(request);
      },
    },
  },
});
