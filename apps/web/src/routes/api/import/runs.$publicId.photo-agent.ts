import { getErrorMessage } from "@cubby/shared";
import { createFileRoute } from "@tanstack/react-router";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { importRunShortcode } from "~/lib/purchase-import-run-detail";
import { startPhotoGroupingForActor } from "~/server/photo-import-run/grouping";
import { PhotoRunNotFoundError } from "~/server/photo-import-run/proposals";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/runs/$publicId/photo-agent")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const publicId = importRunShortcode.safeParse(params.publicId);
        if (!publicId.success)
          return Response.json(
            { error: "Import run was not found" },
            { status: 404 },
          );
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        try {
          return Response.json(
            await startPhotoGroupingForActor(
              context.db,
              context.actorContext,
              context.auth.userId,
              publicId.data,
            ),
          );
        } catch (error) {
          if (error instanceof PhotoRunNotFoundError)
            return Response.json(
              { error: "Import run was not found" },
              { status: 404 },
            );
          if (
            error instanceof Error &&
            error.message === "Photo import agent is unavailable"
          )
            return Response.json({ error: error.message }, { status: 503 });
          return Response.json(
            { error: scrubErrorMessage(getErrorMessage(error)) },
            { status: 409 },
          );
        }
      },
    },
  },
});
