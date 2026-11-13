import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  aggregateReplacementSnapshot,
  extractedPurchaseLine,
  replacementLineIdentity,
  replacementLineAttribution,
  type ExtractedPurchaseLine,
} from "@cubby/schemas/purchase-import";
import {
  nullableMinorToMoney,
  moneyToMinor,
  minorToMoney,
} from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { notDeleted } from "~/server/db/helpers";
import {
  expense,
  expenseAttribution,
  ledgerSourceClaim,
  purchase,
} from "~/server/db/schema";
import {
  loadExpenseAllocations,
  type ExpenseAllocationRow,
} from "~/server/domains/household-contribution/repo/allocation";
import { replacementAttributions } from "~/server/domains/purchase-import/policy/replacement-attributions";

/** Split the two signed line totals into party margins, then intersect their
 * cumulative cent intervals. Both the per-line and per-party margins are exact;
 * the resulting allocations are shown before they become recorded weights. */
export async function redistributeReplacementAttributions(
  allocations: readonly Pick<
    ExpenseAllocationRow,
    "role" | "ledgerPartyId" | "allocationKey" | "cents"
  >[],
  lines: readonly ExtractedPurchaseLine[],
) {
  return z.array(replacementLineAttribution).parse(
    replacementAttributions({
      allocations,
      lines: lines.map((line) => ({
        amountMinor: line.amount === null ? null : moneyToMinor(line.amount),
      })),
    }).map(({ weightMinor, amountMinor, ...row }) => ({
      ...row,
      weight: Number(weightMinor),
      amount: minorToMoney(amountMinor),
    })),
  );
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
      // `expenseOnly: false` hashes as absent, so an approval prepared before
      // the field existed keeps its fingerprint.
      identities: z
        .array(replacementLineIdentity)
        .parse(identities)
        .map(({ expenseOnly, ...identity }) =>
          expenseOnly ? { ...identity, expenseOnly } : identity,
        ),
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
      itemizationExpectation: purchase.itemizationExpectation,
      statedTotal: sql<
        number | null
      >`${minorToDollarsSql(purchase.statedTotal, "numeric")}`.mapWith(Number),
    })
    .from(purchase)
    .where(
      and(
        eq(purchase.id, parseEntityId("purchase", purchaseId)),
        notDeleted(purchase),
      ),
    )
    .for("update");
  const [lockedRow] = await tx
    .select()
    .from(expense)
    .where(and(eq(expense.id, id), notDeleted(expense)))
    .for("update");
  // The replacement fingerprint and snapshot keep the dollar-number shape.
  const row = lockedRow && {
    ...lockedRow,
    cost: nullableMinorToMoney(lockedRow.cost),
  };
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
  const labels = await tx.execute(
    sql`SELECT
    (SELECT p.name FROM "Project" p WHERE p.id = COALESCE(${row.projectId}::uuid, ${parent.defaultProjectId}::uuid) AND ${notDeleted("p")}) AS "projectName",
    (SELECT c.name FROM "SpendingCategory" c WHERE c.id = COALESCE(${row.spendingCategoryId}::uuid, ${parent.spendingCategoryId}::uuid) AND ${notDeleted("c")}) AS "categoryName"
  `,
    "objects",
  );
  const label = z
    .object({
      projectName: z.string().nullable(),
      categoryName: z.string().nullable(),
    })
    .parse(labels[0]);
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
