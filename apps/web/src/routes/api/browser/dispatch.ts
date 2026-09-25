import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/browser/dispatch")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { handleBrowserOperationDispatch } =
          await import("~/server/browser-operation-dispatch");
        return handleBrowserOperationDispatch(request);
      },
    },
  },
});
