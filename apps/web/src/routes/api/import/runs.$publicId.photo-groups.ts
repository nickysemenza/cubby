import {
  photoRunReviewResponse,
  reviewPhotoGroupsAction,
  reviewPhotoGroupsOutput,
} from "@cubby/schemas/photo-import-run";
import { getErrorMessage } from "@cubby/shared";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { importRunShortcode } from "~/lib/purchase-import-run-detail";
import {
  approvePhotoGroupProposals,
  assertPhotoRunReviewer,
  discardPhotoGroupProposal,
  listPhotoGroupProposals,
  listPhotoRunImages,
  PhotoRunNotFoundError,
  proposePhotoGroups,
} from "~/server/photo-import-run/proposals";
import { createRequestContext, requireActor } from "~/server/request-context";

const notFound = () =>
  Response.json({ error: "Import run was not found" }, { status: 404 });

/** Raw diagnostics, credential-scrubbed only — the household is the audience. */
const refused = (message: string) =>
  Response.json({ error: scrubErrorMessage(message) }, { status: 409 });

/**
 * Review surface for a photo-inventory run: the agent's proposed item groups
 * plus every run photo with its processing state (GET), and the reviewer's
 * save / approve / discard actions (POST).
 */
export const Route = createFileRoute("/api/import/runs/$publicId/photo-groups")(
  {
    server: {
      handlers: {
        GET: async ({ params, request }) => {
          const publicId = importRunShortcode.safeParse(params.publicId);
          if (!publicId.success) return notFound();
          const context = requireActor(
            await createRequestContext({ headers: request.headers }),
          );
          try {
            await assertPhotoRunReviewer(
              context.db,
              context.actorContext,
              publicId.data,
            );
            const [review, images] = await Promise.all([
              listPhotoGroupProposals(context.db, publicId.data),
              listPhotoRunImages(context.db, publicId.data),
            ]);
            return Response.json(
              photoRunReviewResponse.parse({ review, images }),
            );
          } catch (error) {
            if (error instanceof PhotoRunNotFoundError) return notFound();
            return refused(getErrorMessage(error));
          }
        },
        POST: async ({ params, request }) => {
          const publicId = importRunShortcode.safeParse(params.publicId);
          if (!publicId.success) return notFound();
          const action = reviewPhotoGroupsAction.safeParse(
            await request.json(),
          );
          if (!action.success)
            return Response.json(
              { error: z.prettifyError(action.error) },
              { status: 400 },
            );
          const context = requireActor(
            await createRequestContext({ headers: request.headers }),
          );
          const runId = publicId.data;
          try {
            await assertPhotoRunReviewer(
              context.db,
              context.actorContext,
              runId,
            );
            const body = action.data;
            if (body.action === "save") {
              const saved = await proposePhotoGroups(context.db, {
                runId,
                groups: body.groups,
                removeGroupKeys: body.removeGroupKeys,
              });
              return Response.json(
                reviewPhotoGroupsOutput.parse({ ...saved, results: [] }),
              );
            }
            if (body.action === "approve") {
              const approved = await approvePhotoGroupProposals(
                context.db,
                { runId, groupKeys: body.groupKeys },
                context.actorContext,
              );
              return Response.json(
                reviewPhotoGroupsOutput.parse({
                  ...approved,
                  frozenGroupKeys: [],
                }),
              );
            }
            const discarded = await discardPhotoGroupProposal(
              context.db,
              { runId, groupKey: body.groupKey },
              context.actorContext,
            );
            return Response.json(
              reviewPhotoGroupsOutput.parse({
                ...discarded,
                results: [],
                frozenGroupKeys: [],
              }),
            );
          } catch (error) {
            if (error instanceof PhotoRunNotFoundError) return notFound();
            return refused(getErrorMessage(error));
          }
        },
      },
    },
  },
);
