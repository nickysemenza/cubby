import { productId } from "@cubby/schemas/identifiers";
import { type ProductShortcode } from "@cubby/schemas/identifiers";
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
} from "~/server/domains/product/repo/product-match";
import {
  listProductMatchRows,
  productPairKey,
  upsertAgentProductMatch,
} from "~/server/domains/product/repo/product-match-candidate";
import { unknownProductVariantComparison } from "~/server/domains/product/repo/product-variant-comparison";
import { type EntityKernelContext } from "~/server/entity-kernel";
import { mergeReviewedProductPair } from "~/server/generic/assessment/repo/assessment-product";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
const BOTH_STOCKED_WARNING =
  "Both Products have stock. Identity merging combines quantities; any duplicate receiving requires a separate reviewed inventory correction.";

function orient(
  a: LoadedMatchSide,
  b: LoadedMatchSide,
): [LoadedMatchSide, LoadedMatchSide] {
  if (a.role === "purchase" && b.role !== "purchase") return [a, b];
  if (b.role === "purchase" && a.role !== "purchase") return [b, a];
  return [a, b];
}

const publicSide = ({
  entityId: _entityId,
  rootCategoryId: _rootCategoryId,
  ownerPartyId: _ownerPartyId,
  ...side
}: LoadedMatchSide) => side;

function candidate(
  source: ProductMatchCandidate["source"],
  a: LoadedMatchSide,
  b: LoadedMatchSide,
  details: Pick<
    ProductMatchCandidate,
    | "assessmentId"
    | "fingerprint"
    | "identityConflict"
    | "evidence"
    | "sourceUrls"
    | "signals"
  >,
): ProductMatchCandidate {
  const [keeper, other] = orient(a, b);
  const variant = unknownProductVariantComparison(keeper.name, other.name);
  return {
    source,
    keeper: publicSide(keeper),
    other: publicSide(other),
    ...details,
    variant,
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
  const sides = await loadProductMatchSides(
    db,
    rows.flatMap((row) => [row.productAId, row.productBId]),
  );
  return {
    semanticRanking: false,
    items: rows.flatMap((row) => {
      const a = sides.get(row.productAId),
        b = sides.get(row.productBId);
      return a && b
        ? [
            {
              ...candidate(row.source, a, b, {
                assessmentId: row.id,
                fingerprint: row.fingerprint,
                identityConflict: row.conflict,
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
