import {
  productId,
  type ProductId,
  type ProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  mergeProductMatchInput,
  ProductMatchCandidate,
  ProductMatchQueueOut,
  proposeProductMatchInput,
  proposeProductMatchOut,
} from "@cubby/schemas/recommendations";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  type LoadedMatchSide,
  loadProductMatchSides,
} from "~/server/domains/product/repo/match/product-match";
import {
  listProductMatchRows,
  productPairKey,
  upsertAgentProductMatch,
} from "~/server/domains/product/repo/match/product-match-candidate";
import {
  readStoredProductPair,
  storedVariantComparison,
} from "~/server/domains/product/repo/match/product-pair-signals";
import { type EntityKernelContext } from "~/server/entity-kernel";
import { mergeReviewedProductPair } from "~/server/generic/assessment/repo/assessment-product";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
const BOTH_STOCKED_WARNING =
  "Both Products have stock. Identity merging combines quantities; any duplicate receiving requires a separate reviewed inventory correction.";

type RankedSide = LoadedMatchSide & { quality: number };

/** Purchase side (spend history), then better identified, then older. */
function orient(a: RankedSide, b: RankedSide): [RankedSide, RankedSide] {
  if (a.role === "purchase" && b.role !== "purchase") return [a, b];
  if (b.role === "purchase" && a.role !== "purchase") return [b, a];
  if (a.quality !== b.quality) return a.quality > b.quality ? [a, b] : [b, a];
  return b.createdAt < a.createdAt ? [b, a] : [a, b];
}

const publicSide = ({
  entityId: _entityId,
  rootCategoryId: _rootCategoryId,
  ownerPartyId: _ownerPartyId,
  createdAt: _createdAt,
  quality: _quality,
  ...side
}: RankedSide) => side;

function candidate(
  source: ProductMatchCandidate["source"],
  a: RankedSide,
  b: RankedSide,
  signals: unknown,
  details: Pick<
    ProductMatchCandidate,
    | "assessmentId"
    | "fingerprint"
    | "identityConflict"
    | "actionable"
    | "evidence"
    | "sourceUrls"
    | "signals"
  >,
): ProductMatchCandidate {
  const [keeper, other] = orient(a, b);
  const pair = readStoredProductPair({ signals }, keeper.entityId);
  return {
    source,
    keeper: publicSide(keeper),
    other: publicSide(other),
    ...details,
    conflictReasons: details.identityConflict ? pair.conflictReasons : [],
    variant: storedVariantComparison(
      pair.variantEvidence,
      keeper.name,
      other.name,
    ),
    warnings: [
      keeper.inventoryCount > 0 && other.inventoryCount > 0
        ? BOTH_STOCKED_WARNING
        : null,
    ].filter((warning): warning is string => warning !== null),
  };
}

/** Browse stored pairs; discovery and model calls belong to durable AI refresh. */
export async function getProductMatchQueue(
  db: Database,
  input: { productId?: ProductShortcode; candidateId?: ProductShortcode },
): Promise<ProductMatchQueueOut> {
  const focus = input.productId
    ? await resolveOrThrow(db, "product", input.productId)
    : undefined;
  const other = input.candidateId
    ? await resolveOrThrow(db, "product", input.candidateId)
    : undefined;
  const rows = (
    await listProductMatchRows(db, focus, {
      reviewableOnly: true,
      candidateId: other,
      limit: 200,
    })
  ).sort((a, b) => Number(b.source === "agent") - Number(a.source === "agent"));
  const productIds = rows.flatMap((row) => [row.productAId, row.productBId]);
  const [sides, qualities] = await Promise.all([
    loadProductMatchSides(db, productIds),
    loadDataQualities(db, "product", productIds),
  ]);
  const ranked = (id: ProductId): RankedSide | undefined => {
    const side = sides.get(id);
    // An unscored record ranks below any scored one.
    return side && { ...side, quality: qualities.get(id)?.score ?? -1 };
  };
  return {
    semanticRanking: false,
    items: rows.flatMap((row) => {
      const a = ranked(row.productAId),
        b = ranked(row.productBId);
      return a && b
        ? [
            {
              ...candidate(row.source, a, b, row.signals, {
                assessmentId: row.id,
                fingerprint: row.fingerprint,
                identityConflict: row.conflict,
                actionable: row.actionable,
                evidence: row.evidence,
                sourceUrls: row.sourceUrls,
                signals:
                  row.verification === "pending_verification"
                    ? ["Variant verification pending"]
                    : row.conflict
                      ? ["Identity conflict"]
                      : [],
              }),
              review: {
                assessmentId: row.id,
                suppression: {
                  scope: "product_pair",
                  candidateKey: productPairKey(row.productAId, row.productBId),
                  fingerprint: null,
                },
              },
            },
          ]
        : [];
    }),
  };
}

async function resolvePair(db: Database, codes: readonly ProductShortcode[]) {
  const values = await Promise.all(
    codes.map((code) => resolveOrThrow(db, "product", code)),
  );
  const pair = z.tuple([productId, productId]).parse(values);
  if (pair[0] === pair[1])
    throw new Error("A Product cannot be paired with itself");
  return pair;
}

export async function proposeProductMatch(
  db: Database,
  input: z.output<typeof proposeProductMatchInput>,
): Promise<z.output<typeof proposeProductMatchOut>> {
  const pair = await resolvePair(db, input.productIds);
  const row = await upsertAgentProductMatch(db, {
    productIds: pair,
    evidence: input.evidence,
    sourceUrls: input.sourceUrls ?? [],
  });
  return {
    productIds: [...input.productIds],
    source: row.source,
    state: row.state,
    evidence: row.evidence,
    sourceUrls: row.sourceUrls,
    created: row.created,
  };
}

export async function mergeProductMatch(
  context: EntityKernelContext,
  input: z.output<typeof mergeProductMatchInput>,
) {
  return mergeReviewedProductPair(context, input);
}
