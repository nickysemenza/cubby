import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/v1/$resource")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { handleHttpOperation } = await import("~/server/http-api");
        return handleHttpOperation(request);
      },
    },
  },
});
