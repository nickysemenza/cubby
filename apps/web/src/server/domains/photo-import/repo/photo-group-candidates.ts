import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  PhotoGroupProposal,
  PhotoGroupProposalList,
} from "@cubby/schemas/photo-import-run";
import { getErrorMessage } from "@cubby/shared";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
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
    const productId = await resolveOrThrow(txDb, "product", input.productId);
    const runId = await resolveOrThrow(txDb, "run", input.runId);
    const { decide } = await import("~/server/kernel/api");
    for (const scope of scopes(proposal)) {
      const imageId = await resolveOrThrow(
        txDb,
        "image",
        scope.slice("photo-group-image:".length),
      );
      await decide(txDb, context.actorContext, [
        {
          channel: "veto",
          kind: "veto",
          subject: `photo-candidate/${runId}/${imageId}`,
          field: "product",
          value: productId,
          proposalHash: `${input.operationId}:${scope}`,
        },
      ]);
    }
    return { ...review, results: [], frozenGroupKeys: [] };
  });
}

async function loadRunRejections(db: Database, runId: string) {
  const runUuid = await resolveOrThrow(db, "run", runId);
  const rows = await getDb(db).execute<{
    scope: { scope: string };
    id: string;
    name: string;
  }>(sql`
    SELECT jsonb_build_object(${"scope"}::text, ${"photo-group-image:"} || image.shortcode) AS scope,
      p.shortcode AS id, p.name
    FROM (SELECT DISTINCT ON (subject, slot) * FROM "Decision" WHERE subject LIKE ${`photo-candidate/${runUuid}/%`}
      AND channel=${"veto"} AND field=${"product"} ORDER BY subject, slot, at DESC, id DESC) d
    JOIN "Product" p ON p.id::text=d.value #>> '{}' JOIN "Image" image ON image.id::text=split_part(d.subject, '/', 3)
    WHERE d.kind=${"veto"} AND ${notDeleted("p")}`);
  return rows.rows;
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
) {
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
