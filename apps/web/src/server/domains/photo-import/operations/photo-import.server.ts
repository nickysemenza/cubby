import type { RawPhotoProductOwnPhoto } from "@cubby/schemas/photo-import-raw-read";
import {
  photoCandidateGroupResult,
  photoRunCandidatesResponse,
  photoProductEvidence,
  photoProductCandidate,
  photoProductOwnPhoto,
} from "@cubby/schemas/photo-import-run";
import type { photoRunContextImage } from "@cubby/schemas/photo-import-run";
import type { z } from "zod";

import { photoImportContract } from "~/contracts/photo-import.contract";
import { decideProductVariantComparisons } from "~/server/ai/semantic-decisions";
import type { Database } from "~/server/db";
import {
  photoRunCandidates,
  rejectPhotoProductCandidate,
} from "~/server/domains/photo-import/repo/photo-group-candidates";
import { commitPhotoImport } from "~/server/domains/photo-import/repo/photo-import-commit";
import {
  findPhotoProductCandidates,
  loadPhotoProductEvidence,
} from "~/server/domains/photo-import/repo/photo-product-candidates";
import { linkablePhotoGroupExpenses } from "~/server/domains/photo-import/repo/run/expense-link";
import { startPhotoGroupingForActor } from "~/server/domains/photo-import/repo/run/grouping";
import {
  admitPhotoRunBatch,
  excludeFailedPhotoRunImages,
  readPhotoRunSnapshot,
  sealPhotoRunBatch,
  setPhotoRunProcessor,
} from "~/server/domains/photo-import/repo/run/lifecycle";
import {
  readPhotoRunDefaults,
  setPhotoRunDefaults,
  resolvePhotoGroupConcern,
  approvePhotoGroupProposals,
  assertPhotoRunReviewer,
  chooseExistingProductForPhotoGroup,
  discardPhotoGroupProposal,
  listPhotoGroupProposals,
  listPhotoRunImages,
  readPhotoRunReview,
  proposePhotoGroups,
  updatePhotoGroupProductDraft,
} from "~/server/domains/photo-import/repo/run/proposals";
import {
  endPhotoRunLiveActivity,
  endPhotoRunNotification,
  registerPhotoRunLiveActivity,
  registerPhotoRunNotification,
} from "~/server/domains/photo-import/repo/run/run-push";
import { commitPhotoGroup } from "~/server/domains/photo-import/repo/run/writer";
import { reconcilePhotoImport } from "~/server/domains/photo-import/service/photo-import-reconcile.service";
import { manifestPhotoImportRouteAdapter } from "~/server/domains/photo-import/service/photo-import-route.adapter";
import { stagePhotoImport } from "~/server/domains/photo-import/service/photo-import-stage.service";
import {
  finalizePhotoRun,
  startPhotoInventoryRun,
} from "~/server/domains/purchase-import/repo/run-service";
import { readRun } from "~/server/domains/run/repo/run";
import { publicFieldEnvelopeRows } from "~/server/generic/derived/repo/public-read";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

/** Serialize every selected own-photo Image once per operation response. */
async function publicOwnPhotos<
  T extends { ownPhotos?: readonly RawPhotoProductOwnPhoto[] },
>(db: Database, rows: readonly T[]) {
  const photos = await publicFieldEnvelopeRows({
    db,
    entity: "image",
    schema: photoProductOwnPhoto,
    rows: rows.flatMap((row) => row.ownPhotos ?? []),
  });
  let offset = 0;
  return rows.map(({ ownPhotos, ...row }) => {
    const count = ownPhotos?.length ?? 0;
    const group = photos.slice(offset, offset + count);
    offset += count;
    return { ...row, ownPhotos: ownPhotos === undefined ? undefined : group };
  });
}

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
      const snapshot = await readPhotoRunSnapshot(context.db, input.runId);
      return {
        review: snapshot.review,
        defaults: snapshot.defaults,
        images: snapshot.images,
        lifecycle: snapshot.lifecycle,
      };
    },
    candidates: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const [review, images] = await Promise.all([
        listPhotoGroupProposals(context.db, input.runId),
        listPhotoRunImages(context.db, input.runId),
      ]);
      const proposal = review.proposals.find(
        (item) => item.groupKey === input.groupKey,
      );
      if (!proposal) throw new Error("Photo group was not found");
      const result = await photoRunCandidates(
        context.db,
        { ...review, proposals: [proposal] },
        images,
        {
          ...context.actorContext,
          runId: await resolveOrThrow(context.db, "run", input.runId),
        },
        decideProductVariantComparisons,
      );
      const group = result.groups[0];
      if (!group) throw new Error("Photo candidate group was not found");
      return photoCandidateGroupResult.parse({
        ...group,
        candidates: await publicOwnPhotos(context.db, group.candidates),
      });
    },
    candidatesBatch: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const { review, images } = await readPhotoRunReview(
        context.db,
        input.runId,
      );
      const result = await photoRunCandidates(
        context.db,
        review,
        images,
        {
          ...context.actorContext,
          runId: await resolveOrThrow(context.db, "run", input.runId),
        },
        decideProductVariantComparisons,
        input.groupKeys,
      );
      const candidates = await publicOwnPhotos(
        context.db,
        result.groups.flatMap((group) => group.candidates),
      );
      let offset = 0;
      return photoRunCandidatesResponse.parse({
        groups: result.groups.map((group) => {
          const rows = candidates.slice(
            offset,
            offset + group.candidates.length,
          );
          offset += group.candidates.length;
          return { ...group, candidates: rows };
        }),
      });
    },
    productEvidence: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      const id = await resolveOrThrow(context.db, "product", input.productId);
      const evidence = (
        await loadPhotoProductEvidence(context.db, [id], context.actorContext)
      ).get(id);
      if (!evidence) throw new Error("Product was not found");
      const [result] = await publicOwnPhotos(context.db, [evidence]);
      return photoProductEvidence.parse(result);
    },
    rejectCandidate: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return rejectPhotoProductCandidate(context.db, input, context);
    },
    linkableExpenses: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return linkablePhotoGroupExpenses(
        context.db,
        input,
        context.actorContext,
      );
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
    resolveConcern: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return {
        ...(await resolvePhotoGroupConcern(
          context.db,
          input,
          context.actorContext,
        )),
        results: [],
        frozenGroupKeys: [],
      };
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
      const saved = await proposePhotoGroups(
        context.db,
        input,
        "member",
        undefined,
        context.actorContext,
      );
      return { ...saved, results: [] };
    },
    stage: (context, input) => stagePhotoImport(context.db, input),
    commit: (context, input) =>
      commitPhotoImport(context, input, manifestPhotoImportRouteAdapter),
    setDefaults: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      await setPhotoRunDefaults(context.db, input.runId, input.defaults);
      const { review, images, lifecycle, defaults } =
        await readPhotoRunSnapshot(context.db, input.runId);
      return { review, images, lifecycle, defaults };
    },
    createRun: async (context, input) => {
      if (input.defaults?.locationId)
        await resolveOrThrow(context.db, "location", input.defaults.locationId);
      const ledgerPartyId = input.ledgerPartyId
        ? await resolveOrThrow(context.db, "ledgerParty", input.ledgerPartyId)
        : undefined;
      const run = await startPhotoInventoryRun(context.db, {
        ledgerPartyId,
        actorUserId: context.auth.userId,
        notes: input.notes,
        defaults: input.defaults,
        grouping: {
          processor: input.processor,
          clientBatchId: input.clientBatchId,
          imageCount: input.imageCount,
        },
        deviceId: context.actorContext.deviceId,
      });
      return { runId: run.publicId };
    },
    admitBatch: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return admitPhotoRunBatch(context.db, input);
    },
    sealBatch: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return sealPhotoRunBatch(context.db, input);
    },
    setProcessor: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return setPhotoRunProcessor(context.db, input);
    },
    excludeFailed: async (context, input) => {
      await assertPhotoRunReviewer(
        context.db,
        context.actorContext,
        input.runId,
      );
      return excludeFailedPhotoRunImages(context.db, input);
    },
    registerLiveActivity: (context, input) =>
      registerPhotoRunLiveActivity(context.db, context.actorContext, input),
    endLiveActivity: (context, input) =>
      endPhotoRunLiveActivity(context.db, context.actorContext, input),
    registerNotification: (context, input) =>
      registerPhotoRunNotification(context.db, context.actorContext, input),
    endNotification: (context, input) =>
      endPhotoRunNotification(context.db, context.actorContext, input),
    finalize: (context, input) =>
      finalizePhotoRun(context.db, input, context.actorContext),
    reconcile: (context, input) => reconcilePhotoImport(context.db, input),
    runContext: async (context, input) => {
      const run = await readRun(context.db, input.runId);
      if (!run || run.purpose !== "photo_inventory" || !run.ledgerPartyId)
        throw new Error("Photo-inventory run and owner were not found");
      const all = await listPhotoRunImages(context.db, input.runId);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? PHOTO_CONTEXT_PAGE_DEFAULT);
      return {
        runId: input.runId,
        ledgerPartyId: run.ledgerPartyId,
        notes: run.notes,
        defaults: await readPhotoRunDefaults(context.db, input.runId),
        totalImages: all.length,
        nextCursor: end < all.length ? end : null,
        images: all.slice(cursor, end).map((image) => {
          const summary: z.infer<typeof photoRunContextImage> = {
            id: image.id,
            position: image.position,
            capturedAt: image.capturedAt,
            capturedAtOffsetMinutes: image.capturedAtOffsetMinutes,
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
      candidates: (
        await publicOwnPhotos(
          context.db,
          await findPhotoProductCandidates(
            context.db,
            input,
            context.actorContext,
            decideProductVariantComparisons,
          ),
        )
      ).map((row) => photoProductCandidate.parse(row)),
    }),
    proposals: (context, input) =>
      listPhotoGroupProposals(context.db, input.runId),
    // A run-bound coordinator's envelope carries its signed dispatch
    // generation (`tool-registration` drops any unsigned value); any other
    // MCP caller is an external Claude/Codex session.
    proposeGroups: (context, input) =>
      proposePhotoGroups(
        context.db,
        input,
        context.actorContext.channel === "mcp" &&
          input._runExecution?.generation
          ? "coordinator"
          : context.actorContext.channel === "mcp"
            ? "external_agent"
            : "member",
        input._runExecution?.generation,
        context.actorContext,
      ),
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
