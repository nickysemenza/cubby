import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/v1/$resource/$operation")({
  server: {
    handlers: {
      ANY: async ({ request, params }) => {
        const { handleHttpOperation } = await import("~/server/http-api");
        return handleHttpOperation(
          request,
          `${params.resource}.${params.operation}`,
        );
      },
    },
  },
});
