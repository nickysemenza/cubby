import { getErrorMessage } from "@cubby/shared";
import { createFileRoute } from "@tanstack/react-router";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { importRunShortcode } from "~/lib/purchase-import-run-detail";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import {
  assertPhotoRunReviewer,
  PhotoRunNotFoundError,
} from "~/server/photo-import-run/proposals";
import { findActivePurchaseAgentGrant } from "~/server/purchase-import/agent-auth";
import { dispatchImportRunEvent } from "~/server/purchase-import/dispatch";
import { startPhotoInventoryCoordinator } from "~/server/purchase-import/run-service";
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
          await assertPhotoRunReviewer(
            context.db,
            context.actorContext,
            publicId.data,
          );
          const grant = await findActivePurchaseAgentGrant(
            context.db,
            context.auth.userId,
          );
          if (!grant)
            return Response.json(
              { error: "Connect the Cubby agent before grouping photos" },
              { status: 409 },
            );
          const queue = getPurchaseAgentQueue();
          if (!queue)
            return Response.json(
              { error: "Photo import agent is unavailable" },
              { status: 503 },
            );
          const run = await startPhotoInventoryCoordinator(context.db, {
            publicId: publicId.data,
            actorUserId: context.auth.userId,
          });
          if (run.created)
            await dispatchImportRunEvent(context.db, queue, {
              version: 1,
              runId: run.id,
              eventId: run.eventId,
              purpose: "photo_inventory",
              type: "start_or_resume",
            });
          return Response.json({ runId: run.publicId, started: run.created });
        } catch (error) {
          if (error instanceof PhotoRunNotFoundError)
            return Response.json(
              { error: "Import run was not found" },
              { status: 404 },
            );
          return Response.json(
            { error: scrubErrorMessage(getErrorMessage(error)) },
            { status: 409 },
          );
        }
      },
    },
  },
});
