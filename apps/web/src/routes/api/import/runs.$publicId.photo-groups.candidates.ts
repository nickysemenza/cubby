import { photoProductCandidatesResponse } from "@cubby/schemas/photo-import-run";
import { getErrorMessage } from "@cubby/shared";
import { createFileRoute } from "@tanstack/react-router";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { importRunShortcode } from "~/lib/purchase-import-run-detail";
import {
  assertPhotoRunReviewer,
  listPhotoGroupProposals,
  PhotoRunNotFoundError,
} from "~/server/photo-import-run/proposals";
import { photoProductCandidates } from "~/server/repo/photo-product-candidates";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute(
  "/api/import/runs/$publicId/photo-groups/candidates",
)({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const runId = importRunShortcode.safeParse(params.publicId);
        if (!runId.success)
          return Response.json(
            { error: "Import run was not found" },
            { status: 404 },
          );
        const groupKey = new URL(request.url).searchParams.get("groupKey");
        if (!groupKey || groupKey.length > 200)
          return Response.json(
            { error: "A group key is required" },
            { status: 400 },
          );
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        try {
          await assertPhotoRunReviewer(
            context.db,
            context.actorContext,
            runId.data,
          );
          const review = await listPhotoGroupProposals(context.db, runId.data);
          const group = review.proposals.find(
            (item) => item.groupKey === groupKey,
          );
          if (!group)
            return Response.json(
              { error: "Photo group was not found" },
              { status: 404 },
            );
          return Response.json(
            photoProductCandidatesResponse.parse({
              candidates: await photoProductCandidates(context.db, group),
            }),
          );
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
