import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/import/evidence")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        const [{ db }, { receiveRunEvidenceUpload }] = await Promise.all([
          import("~/server/db"),
          import("~/server/purchase-import/run-evidence"),
        ]);
        return receiveRunEvidenceUpload(db, request);
      },
    },
  },
});
