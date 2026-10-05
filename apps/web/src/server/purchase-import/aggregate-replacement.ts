import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  aggregateReplacementSnapshot,
  extractedPurchaseLine,
  replacementLineIdentity,
  replacementLineAttribution,
  type ExtractedPurchaseLine,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import {
  expense,
  expenseAttribution,
  ledgerSourceClaim,
  purchase,
} from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import {
  loadExpenseAllocations,
  type ExpenseAllocationRow,
} from "~/server/repo/household-contribution/allocation";

/** Split the two signed line totals into party margins, then intersect their
 * cumulative cent intervals. Both the per-line and per-party margins are exact;
 * the resulting allocations are shown before they become recorded weights. */
export async function redistributeReplacementAttributions(
  tx: DrizzleTransaction,
  allocations: readonly Pick<
    ExpenseAllocationRow,
    "role" | "ledgerPartyId" | "allocationKey" | "cents"
  >[],
  lines: readonly ExtractedPurchaseLine[],
) {
  const targets = JSON.stringify(
    allocations.map((row) => ({
      role: row.role,
      partyId: row.ledgerPartyId,
      partyCode: row.allocationKey,
      targetCents: row.cents.toString(),
    })),
  );
  const inputs = JSON.stringify(
    lines.map((line, lineIndex) => ({ lineIndex, amount: line.amount })),
  );
  const result = await tx.execute(sql`
    WITH targets AS (
      SELECT * FROM jsonb_to_recordset(${targets}::jsonb)
        AS t(role text, "partyId" uuid, "partyCode" text, "targetCents" bigint)
    ), lines AS (
      SELECT "lineIndex", round(amount * 100)::bigint AS cents
      FROM jsonb_to_recordset(${inputs}::jsonb) AS l("lineIndex" int, amount numeric)
    ), roles AS (
      SELECT role, CASE WHEN sum("targetCents") < 0 THEN -1 ELSE 1 END AS direction,
        sum(abs("targetCents")) AS total_weight
      FROM targets GROUP BY role
    ), weighted AS (
      SELECT t.*, r.direction,
        CASE WHEN r.total_weight = 0 THEN 1 ELSE abs(t."targetCents") END AS weight,
        COALESCE((SELECT sum(abs(l.cents)) FROM lines l WHERE sign(l.cents) = -r.direction), 0) AS opposite_cents
      FROM targets t JOIN roles r USING (role)
    ), based AS (
      SELECT w.*,
        floor(opposite_cents * weight / sum(weight) OVER (PARTITION BY role)) AS base,
        mod(opposite_cents * weight, sum(weight) OVER (PARTITION BY role)) AS remainder
      FROM weighted w
    ), ranked AS (
      SELECT b.*, sum(base) OVER (PARTITION BY role) AS assigned,
        row_number() OVER (PARTITION BY role ORDER BY remainder DESC, "partyCode") AS rank
      FROM based b
    ), opposite AS (
      SELECT *, base + CASE WHEN rank <= opposite_cents - assigned THEN 1 ELSE 0 END AS share
      FROM ranked
    ), margins AS (
      SELECT role, "partyId", "partyCode", direction, abs("targetCents") + share AS cents FROM opposite
      UNION ALL
      SELECT role, "partyId", "partyCode", -direction, share FROM opposite
    ), party_intervals AS (
      SELECT *, sum(cents) OVER (PARTITION BY role, direction ORDER BY "partyCode") - cents AS start,
        sum(cents) OVER (PARTITION BY role, direction ORDER BY "partyCode") AS finish
      FROM margins
    ), line_intervals AS (
      SELECT *, sign(cents) AS direction,
        sum(abs(cents)) OVER (PARTITION BY sign(cents) ORDER BY "lineIndex") - abs(cents) AS start,
        sum(abs(cents)) OVER (PARTITION BY sign(cents) ORDER BY "lineIndex") AS finish
      FROM lines
    ), transported AS (
      SELECT l."lineIndex", p.role, p."partyId", p."partyCode", p.direction,
        greatest(0, least(l.finish, p.finish) - greatest(l.start, p.start)) AS weight
      FROM line_intervals l JOIN party_intervals p ON p.direction = l.direction
    )
    SELECT "lineIndex", role, "partyId", "partyCode", weight::double precision AS weight,
      (direction * weight / 100.0)::double precision AS amount
    FROM transported WHERE weight > 0 ORDER BY "lineIndex", role, "partyCode"
  `);
  return z.array(replacementLineAttribution).parse(result.rows);
}

export async function aggregateReplacementApprovalFingerprint(
  originalFingerprint: string,
  lines: readonly ExtractedPurchaseLine[],
  identities: readonly z.infer<typeof replacementLineIdentity>[],
  attributions: readonly z.infer<typeof replacementLineAttribution>[],
) {
  // JSONB reorders keys; parse each shape before hashing on both sides.
  return sha256Hex(
    JSON.stringify({
      originalFingerprint,
      lines: z.array(extractedPurchaseLine).parse(lines),
      identities: z.array(replacementLineIdentity).parse(identities),
      attributions: z.array(replacementLineAttribution).parse(attributions),
    }),
  );
}

export async function loadAggregateReplacementSnapshot(
  tx: DrizzleTransaction,
  purchaseId: string,
  expenseId: string,
) {
  const id = parseEntityId("expense", expenseId);
  const [parent] = await tx
    .select({
      id: purchase.id,
      date: purchase.date,
      defaultProjectId: purchase.defaultProjectId,
      defaultTrade: purchase.defaultTrade,
      spendingCategoryId: purchase.spendingCategoryId,
      evidenceExpectation: purchase.evidenceExpectation,
      statedTotal: purchase.statedTotal,
    })
    .from(purchase)
    .where(
      and(
        eq(purchase.id, parseEntityId("purchase", purchaseId)),
        notDeleted(purchase),
      ),
    )
    .for("update");
  const [row] = await tx
    .select()
    .from(expense)
    .where(and(eq(expense.id, id), notDeleted(expense)))
    .for("update");
  if (!parent || !row || row.purchaseId !== parent.id || row.cost === null)
    throw new Error("The aggregate no longer belongs to this live Purchase.");
  const [claim] = await tx
    .select({ id: ledgerSourceClaim.id })
    .from(ledgerSourceClaim)
    .where(
      and(eq(ledgerSourceClaim.expenseId, id), notDeleted(ledgerSourceClaim)),
    )
    .limit(1);
  if (claim)
    throw new Error(
      "A source-claimed Expense cannot be replaced by multiple receipt lines.",
    );
  const attributions = await tx
    .select()
    .from(expenseAttribution)
    .where(
      and(eq(expenseAttribution.expenseId, id), notDeleted(expenseAttribution)),
    )
    .orderBy(
      expenseAttribution.role,
      expenseAttribution.ledgerPartyId,
      expenseAttribution.id,
    )
    .for("update");
  const allocations = await loadExpenseAllocations(tx, {
    expenseIds: [id],
    includeFuture: true,
  });
  const fingerprint = await sha256Hex(
    JSON.stringify({
      parent,
      row,
      attributions,
      allocations: allocations.map((allocation) => ({
        ...allocation,
        cents: allocation.cents.toString(),
      })),
    }),
  );
  const labels = await tx.execute(sql`SELECT
    (SELECT p.name FROM "Project" p WHERE p.id = COALESCE(${row.projectId}::uuid, ${parent.defaultProjectId}::uuid) AND p."deletedAt" IS NULL) AS "projectName",
    (SELECT c.name FROM "SpendingCategory" c WHERE c.id = COALESCE(${row.spendingCategoryId}::uuid, ${parent.spendingCategoryId}::uuid) AND c."deletedAt" IS NULL) AS "categoryName"
  `);
  const label = z
    .object({
      projectName: z.string().nullable(),
      categoryName: z.string().nullable(),
    })
    .parse(labels.rows[0]);
  return {
    row,
    parent,
    attributions,
    allocations,
    snapshot: aggregateReplacementSnapshot.parse({
      fingerprint,
      expenseCode: row.shortcode,
      title: row.name,
      amount: row.cost,
      notes: row.notes,
      date: row.date,
      ...label,
      costType: row.costType,
      trade: row.trade,
      bookingTransactionCode: row.bookingTransactionCode,
    }),
  };
}
