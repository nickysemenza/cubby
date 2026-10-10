import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { getErrorMessage } from "~/lib/error-utils";
import { AppError } from "~/server/errors/app-error";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/evidence")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const context = requireActor(
            await createRequestContext({ headers: request.headers }),
          );
          const { readRunEvidenceMedia } =
            await import("~/server/purchase-import/run-evidence");
          const query = new URL(request.url).searchParams;
          return await readRunEvidenceMedia(
            context.db,
            {
              runId: query.get("runId") ?? "",
              targetId: query.get("targetId") ?? "",
              evidenceId: query.get("evidenceId") ?? "",
            },
            context.auth.userId,
          );
        } catch (error) {
          return new Response(scrubErrorMessage(getErrorMessage(error)), {
            status:
              error instanceof AppError && error.code === "UNAUTHORIZED"
                ? 401
                : error instanceof z.ZodError
                  ? 400
                  : 500,
            headers: {
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
      },
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
