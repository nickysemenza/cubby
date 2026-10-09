import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/v1/$resource")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        // Route modules ship in the router chunk; the HTTP API graph loads on use.
        const { handleHttpOperation } = await import("~/server/http-api");
        return handleHttpOperation(request);
      },
    },
  },
});
