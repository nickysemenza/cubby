import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/import/evidence")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        // Route modules ship in the router chunk; the upload graph loads on use.
        const { handleRunEvidenceUpload } =
          await import("~/server/purchase-import/run-evidence");
        return handleRunEvidenceUpload(request);
      },
    },
  },
});
