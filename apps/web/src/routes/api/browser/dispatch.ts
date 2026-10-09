import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/browser/dispatch")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        // Route modules ship in the router chunk; the handler graph loads on use.
        const { handleBrowserOperationDispatch } =
          await import("~/server/browser-operation-dispatch");
        return handleBrowserOperationDispatch(request);
      },
    },
  },
});
