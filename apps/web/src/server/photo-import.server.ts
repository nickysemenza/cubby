import type { photoRunContextImage } from "@cubby/schemas/photo-import-run";
import type { z } from "zod";

import { photoImportContract } from "~/contracts/photo-import.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  linkablePhotoGroupExpenses,
  linkPhotoGroupExpense,
} from "~/server/photo-import-run/expense-link";
import { startPhotoGroupingForActor } from "~/server/photo-import-run/grouping";
import {
  approvePhotoGroupProposals,
  assertPhotoRunReviewer,
  chooseExistingProductForPhotoGroup,
  discardPhotoGroupProposal,
  listPhotoGroupProposals,
  listPhotoRunImages,
  proposePhotoGroups,
  updatePhotoGroupProductDraft,
} from "~/server/photo-import-run/proposals";
import { commitPhotoGroup } from "~/server/photo-import-run/writer";
import {
  finalizePhotoRun,
  startPhotoInventoryRun,
} from "~/server/purchase-import/run-service";
import {
  findPhotoProductCandidates,
  photoProductCandidates,
} from "~/server/repo/photo-product-candidates";
import { getRunByShortcode } from "~/server/repo/run";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { commitPhotoImport } from "~/server/services/photo-import-commit.service";
import { reconcilePhotoImport } from "~/server/services/photo-import-reconcile.service";
import { manifestPhotoImportRouteAdapter } from "~/server/services/photo-import-route.adapter";
import { stagePhotoImport } from "~/server/services/photo-import-stage.service";

export const photoImportHandlers = implementOperationDomain(
  photoImportContract,
  {
    startGrouping: async (context, input) => {
      return startPhotoGroupingForActor(
        context.db,
        context.actorContext,
        context.auth.userId,
        input.runId,
      );
    },
    review: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const [review, images] = await Promise.all([
        listPhotoGroupProposals(context.db, input.runId),
        listPhotoRunImages(context.db, input.runId),
      ]);
      return { review, images };
    },
    candidates: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const review = await listPhotoGroupProposals(context.db, input.runId);
      const group = review.proposals.find(
        (item) => item.groupKey === input.groupKey,
      );
      if (!group) throw new Error("Photo group was not found");
      const images = await listPhotoRunImages(context.db, input.runId);
      return {
        candidates: await photoProductCandidates(context.db, group, images),
      };
    },
    linkableExpenses: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return linkablePhotoGroupExpenses(context.db, input);
    },
    linkExpense: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return linkPhotoGroupExpense(context.db, input, context.actorContext);
    },
    chooseExisting: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const saved = await chooseExistingProductForPhotoGroup(context.db, input);
      return { ...saved, results: [] };
    },
    updateDraft: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const saved = await updatePhotoGroupProductDraft(context.db, input);
      return { ...saved, results: [] };
    },
    approveGroups: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const approved = await approvePhotoGroupProposals(
        context.db,
        {
          runId: input.runId,
          groupKeys: input.groupKeys,
          expectedRevisions: input.expectedRevisions,
        },
        context.actorContext,
      );
      return { ...approved, frozenGroupKeys: [] };
    },
    discardGroup: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const discarded = await discardPhotoGroupProposal(
        context.db,
        { runId: input.runId, groupKey: input.groupKey },
        context.actorContext,
      );
      return { ...discarded, results: [], frozenGroupKeys: [] };
    },
    saveGroups: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const saved = await proposePhotoGroups(context.db, input);
      return { ...saved, results: [] };
    },
    stage: (context, input) => stagePhotoImport(context.db, input),
    commit: (context, input) =>
      commitPhotoImport(context, input, manifestPhotoImportRouteAdapter),
    createRun: async (context, input) => {
      const ledgerPartyId = input.ledgerPartyId
        ? await resolveOrThrow(context.db, "ledgerParty", input.ledgerPartyId)
        : undefined;
      const run = await startPhotoInventoryRun(context.db, {
        ledgerPartyId,
        actorUserId: context.auth.userId,
        notes: input.notes,
      });
      return { runId: run.publicId };
    },
    finalize: (context, input) =>
      finalizePhotoRun(context.db, input, context.actorContext),
    reconcile: (context, input) => reconcilePhotoImport(context.db, input),
    runContext: async (context, input) => {
      const run = await getRunByShortcode(context.db, input.runId);
      if (!run || run.purpose !== "photo_inventory" || !run.ledgerPartyId)
        throw new Error("Photo-inventory run and owner were not found");
      const all = await listPhotoRunImages(context.db, input.runId);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? PHOTO_CONTEXT_PAGE_DEFAULT);
      return {
        runId: input.runId,
        ledgerPartyId: run.ledgerPartyId,
        notes: run.notes,
        totalImages: all.length,
        nextCursor: end < all.length ? end : null,
        images: all.slice(cursor, end).map((image) => {
          const summary: z.infer<typeof photoRunContextImage> = {
            id: image.id,
            position: image.position,
            targetState: image.targetState,
            describe: image.describe,
            description: clip(image.description, DESCRIPTION_CHARS),
            recognizedText: clip(image.recognizedText, RECOGNIZED_TEXT_CHARS),
          };
          if (input.withImageUrls) {
            summary.originalUrl = image.originalUrl;
            summary.cutoutUrl = image.cutoutUrl;
          }
          return summary;
        }),
      };
    },
    productCandidates: async (context, input) => ({
      candidates: await findPhotoProductCandidates(context.db, input),
    }),
    proposals: (context, input) =>
      listPhotoGroupProposals(context.db, input.runId),
    proposeGroups: (context, input) => proposePhotoGroups(context.db, input),
    commitGroup: (context, input) =>
      commitPhotoGroup(context.db, input, context.actorContext),
  },
);

// A photo's text is bounded for the same reason the page is (see
// `PHOTO_CONTEXT_PAGE_MAX`): every page stays in the coordinator's context.
const PHOTO_CONTEXT_PAGE_DEFAULT = 50;
const DESCRIPTION_CHARS = 800;
const RECOGNIZED_TEXT_CHARS = 400;

const clip = (text: string | null, max: number) =>
  text && text.length > max ? `${text.slice(0, max)}…` : text;
