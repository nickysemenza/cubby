import { photoImportContract } from "~/contracts/photo-import.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
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
import {
  finalizePhotoRun,
  startPhotoInventoryRun,
} from "~/server/purchase-import/run-service";
import { photoProductCandidates } from "~/server/repo/photo-product-candidates";
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
      return { candidates: await photoProductCandidates(context.db, group) };
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
        { runId: input.runId, groupKeys: input.groupKeys },
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
  },
);
