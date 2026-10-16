import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  PhotoGroupProposal,
  PhotoGroupProposalList,
  photoRunCandidatesResponse,
} from "@cubby/schemas/photo-import-run";
import { getErrorMessage } from "@cubby/shared";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { assessment, assessmentState, product } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { assessRecommendation } from "~/server/generic/assessment/repo/assessment-recommendation";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  photoProductCandidates,
  selectedPhotoProductComparison,
  type ProductVariantComparator,
} from "./photo-product-candidates";
import { listPhotoGroupProposals } from "./run/proposals";

const scopes = (proposal: PhotoGroupProposal) => [
  ...new Set(
    [
      ...proposal.images.map((image) => image.id),
      ...proposal.skip.map((image) => image.id),
      ...(proposal.review?.candidateScopeImageIds ?? []),
    ].map((id) => `photo-group-image:${id}`),
  ),
];

/** Each rejection follows its constituent photos through arbitrary regrouping. */
export async function rejectPhotoProductCandidate(
  db: Database,
  input: {
    runId: string;
    groupKey: string;
    productId: string;
    operationId: string;
  },
  context: EntityKernelContext,
) {
  return withTransactionDatabase(db, async (txDb) => {
    const review = await listPhotoGroupProposals(txDb, input.runId);
    const proposal = review.proposals.find(
      (item) => item.groupKey === input.groupKey,
    );
    if (!proposal || proposal.state !== "proposed")
      throw new Error("Proposed photo group was not found");
    await resolveOrThrow(txDb, "product", input.productId);
    for (const scope of scopes(proposal)) {
      const reference = await assessRecommendation(
        txDb,
        input.runId,
        scope,
        [input.productId],
        { productId: input.productId },
        "run",
      );
      await reviewAssessment(
        txDb,
        { ...context, db: txDb },
        {
          ...reference,
          operationId: `${input.operationId}:${scope}`,
          verdict: "wrong",
          intent: "history",
          reason: "Not this one",
        },
      );
    }
    return { ...review, results: [], frozenGroupKeys: [] };
  });
}

async function loadRunRejections(db: Database, runId: string) {
  const runUuid = await resolveOrThrow(db, "run", runId);
  return getDb(db)
    .select({
      scope: assessmentState.suppression,
      id: product.shortcode,
      name: product.name,
    })
    .from(assessmentState)
    .innerJoin(assessment, eq(assessment.id, assessmentState.id))
    .innerJoin(
      product,
      and(
        sql`${assessment.evidence}->>'productId' = ${product.shortcode}`,
        notDeleted(product),
      ),
    )
    .where(
      and(
        eq(assessmentState.entity, "run"),
        eq(assessmentState.recordId, runUuid),
        eq(assessmentState.family, "recommendation"),
        eq(assessmentState.active, true),
        isNotNull(assessmentState.suppression),
      ),
    );
}

export async function loadRejectedPhotoProductCandidates(
  db: Database,
  runId: string,
  proposal: PhotoGroupProposal,
  snapshot?: Awaited<ReturnType<typeof loadRunRejections>>,
) {
  const wanted = new Set(scopes(proposal));
  const rows = snapshot ?? (await loadRunRejections(db, runId));
  const rejected = new Map(
    rows
      .filter((row) => row.scope && wanted.has(row.scope.scope))
      .map((row) => [
        row.id,
        {
          id: parseShortcodeFor("product", row.id),
          name: row.name,
          rejected: true as const,
        },
      ]),
  );
  return [...rejected.values()];
}

/** Requested groups start together; callers partition invocations without limiting total decisions. */
export async function photoRunCandidates(
  db: Database,
  review: PhotoGroupProposalList,
  images: Parameters<typeof photoProductCandidates>[2],
  actor: ActorContext,
  compareVariants: ProductVariantComparator,
  groupKeys?: readonly string[],
): Promise<z.infer<typeof photoRunCandidatesResponse>> {
  const proposals = groupKeys
    ? review.proposals.filter((proposal) =>
        groupKeys.includes(proposal.groupKey),
      )
    : review.proposals;
  let rejections: Awaited<ReturnType<typeof loadRunRejections>>;
  try {
    rejections = await loadRunRejections(db, review.runId);
  } catch (error) {
    return {
      groups: proposals.map((proposal) => ({
        groupKey: proposal.groupKey,
        status: "failed",
        error: scrubErrorMessage(getErrorMessage(error)),
        candidates: [],
        rejectedCandidates: [],
        selectedComparison: null,
      })),
    };
  }
  const groups = await Promise.all(
    proposals.map(async (proposal) => {
      let rejectedCandidates: Awaited<
        ReturnType<typeof loadRejectedPhotoProductCandidates>
      > = [];
      try {
        rejectedCandidates = await loadRejectedPhotoProductCandidates(
          db,
          review.runId,
          proposal,
          rejections,
        );
        const candidates = await photoProductCandidates(
          db,
          proposal,
          images,
          actor,
          compareVariants,
          rejectedCandidates.map((item) => item.id),
        );
        const selectedId =
          proposal.product.kind === "existing"
            ? proposal.product.existing?.id
            : null;
        const rankedSelected = candidates.find(
          (item) => item.id === selectedId,
        );
        const selectedComparison = rankedSelected
          ? {
              id: rankedSelected.id,
              variant: rankedSelected.match.variant,
              crossCheck: rankedSelected.crossCheck ?? [],
            }
          : await selectedPhotoProductComparison(
              db,
              proposal,
              images ?? [],
              actor,
              compareVariants,
            );
        return {
          groupKey: proposal.groupKey,
          status: "ready" as const,
          error: null,
          candidates,
          rejectedCandidates,
          selectedComparison,
        };
      } catch (error) {
        return {
          groupKey: proposal.groupKey,
          status: "failed" as const,
          error: scrubErrorMessage(getErrorMessage(error)),
          candidates: [],
          rejectedCandidates,
          selectedComparison: null,
        };
      }
    }),
  );
  return { groups };
}
