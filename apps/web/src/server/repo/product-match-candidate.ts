import type { ProductId } from "@cubby/schemas/identifiers";
import { eq, getTableColumns, inArray, or, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productMatchCandidate } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Persistence for the product match queue's durable half: agent proposals
 * (with their evidence) and dismissals of any pair. Detector pairs are never
 * stored while open — they are recomputed from live data on every read.
 */
export type ProductMatchCandidateRow =
  typeof productMatchCandidate.$inferSelect;

/** The table's canonical storage order (`productAId < productBId`). */
const canonicalProductPair = (a: ProductId, b: ProductId) =>
  a < b ? { productAId: a, productBId: b } : { productAId: b, productBId: a };

/** Order-free identity for a pair, for in-memory joins against stored rows. */
export const productPairKey = (a: string, b: string): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;

/**
 * Record (or refresh) an agent's proposal. Re-proposing replaces the evidence
 * and sources but never reopens a dismissed pair: the person's decision
 * stands, and the returned `state` tells the agent so.
 */
export async function upsertAgentProductMatch(
  db: Database,
  input: {
    productIds: readonly [ProductId, ProductId];
    evidence: string;
    sourceUrls: string[];
  },
): Promise<ProductMatchCandidateRow & { created: boolean }> {
  const [row] = await getDb(db)
    .insert(productMatchCandidate)
    .values({
      ...canonicalProductPair(...input.productIds),
      source: "agent",
      state: "open",
      evidence: input.evidence,
      sourceUrls: input.sourceUrls,
    })
    .onConflictDoUpdate({
      target: [
        productMatchCandidate.productAId,
        productMatchCandidate.productBId,
      ],
      set: {
        source: "agent",
        evidence: input.evidence,
        sourceUrls: input.sourceUrls,
        updatedAt: new Date(),
      },
    })
    .returning({
      ...getTableColumns(productMatchCandidate),
      // Postgres marks a freshly inserted tuple with xmax = 0; an ON CONFLICT
      // update leaves the locking transaction id there instead.
      created: sql<boolean>`(xmax = 0)`,
    });
  if (!row) throw new Error("Product match upsert returned no row");
  return row;
}

/** Hide a pair from the queue for good, whichever source proposed it. */
export async function dismissProductMatch(
  db: Database,
  productIds: readonly [ProductId, ProductId],
): Promise<void> {
  await getDb(db)
    .insert(productMatchCandidate)
    .values({
      ...canonicalProductPair(...productIds),
      source: "detector",
      state: "dismissed",
    })
    .onConflictDoUpdate({
      target: [
        productMatchCandidate.productAId,
        productMatchCandidate.productBId,
      ],
      set: { state: "dismissed", updatedAt: new Date() },
    });
}

/** Every stored pair; small by construction (proposals plus dismissals). */
export async function listProductMatchRows(
  db: Database,
  productId?: ProductId,
): Promise<ProductMatchCandidateRow[]> {
  return await getDb(db)
    .select()
    .from(productMatchCandidate)
    .where(
      productId
        ? or(
            eq(productMatchCandidate.productAId, productId),
            eq(productMatchCandidate.productBId, productId),
          )
        : undefined,
    );
}

/**
 * The delete/merge edge policy for both product columns: a review row dies
 * with either product, so a merged pair can never linger as a self-pair and
 * the table never points at a tombstone.
 */
export async function deleteProductMatchCandidatesTx(
  tx: DrizzleTransaction,
  productIds: readonly ProductId[],
): Promise<void> {
  if (productIds.length === 0) return;
  await tx
    .delete(productMatchCandidate)
    .where(
      or(
        inArray(productMatchCandidate.productAId, [...productIds]),
        inArray(productMatchCandidate.productBId, [...productIds]),
      ),
    );
}
