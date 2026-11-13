import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type ExpenseId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { expenseCostDollarsSql } from "~/server/db/computed/expense-aggregate-sql";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import {
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import {
  auditLog,
  email as emailTable,
  expense,
  expenseAttribution,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  ledgerSourceClaim,
  purchase,
} from "~/server/db/schema";
import { deleteExpensesWithPurchaseEffects } from "~/server/domains/expense/repo/crud";
import { mergePurchases } from "~/server/domains/purchase/repo/purchase";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { normalizeOrderKey } from "./order-identity";

type Line = {
  id: ExpenseId;
  shortcode: string;
  title: string;
  amount: number | null;
  lineKind: string;
  productId: string | null;
  projectId: string | null;
  productQuantity: number | null;
  attribution: string;
  /** Booking facts a retired line hands to its survivor when the survivor has none. */
  carried: Record<CarriedField, string | null>;
};

const CARRIED_FIELDS = [
  "bookingTransactionCode",
  "spendingCategoryId",
  "trade",
] as const;
type CarriedField = (typeof CARRIED_FIELDS)[number];

const titleOf = (line: Line) =>
  line.title.trim().replace(/\s+/gu, " ").toLowerCase();
const centsOf = (line: Line) =>
  line.amount === null ? null : cents(line.amount);

async function readLines(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
): Promise<Line[]> {
  const rows = await tx
    .select({
      id: expense.id,
      shortcode: expense.shortcode,
      title: expense.name,
      amount: expenseCostDollarsSql(),
      lineKind: expense.lineKind,
      productId: expense.productId,
      projectId: expense.projectId,
      productQuantity: expense.productQuantity,
      economicRole: expense.economicRole,
      bookingTransactionCode: expense.bookingTransactionCode,
      spendingCategoryId: expense.spendingCategoryId,
      trade: expense.trade,
    })
    .from(expense)
    .where(and(eq(expense.purchaseId, purchaseId), notDeleted(expense)))
    .for("update");
  if (rows.some((row) => row.economicRole !== "vendor"))
    throw createAppError(
      "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
      "Only vendor lines converge; reimbursement lines need their own review.",
    );
  const attributions = rows.length
    ? await tx
        .select({
          expenseId: expenseAttribution.expenseId,
          role: expenseAttribution.role,
          ledgerPartyId: expenseAttribution.ledgerPartyId,
          weight: expenseAttribution.weight,
        })
        .from(expenseAttribution)
        .where(
          and(
            inArray(
              expenseAttribution.expenseId,
              rows.map((row) => row.id),
            ),
            notDeleted(expenseAttribution),
          ),
        )
    : [];
  return rows.map((row) => ({
    id: row.id,
    shortcode: row.shortcode,
    title: row.title,
    amount: row.amount,
    lineKind: row.lineKind,
    productId: row.productId,
    projectId: row.projectId,
    productQuantity: row.productQuantity,
    attribution: JSON.stringify(
      attributions
        .filter((item) => item.expenseId === row.id)
        .map((item) => [item.role, item.ledgerPartyId, item.weight])
        .sort(),
    ),
    carried: {
      bookingTransactionCode: row.bookingTransactionCode,
      spendingCategoryId: row.spendingCategoryId,
      trade: row.trade,
    },
  }));
}

type Pair = {
  from: Line;
  to: Line;
  carry: Partial<Record<CarriedField, string>>;
};

/** One duplicate line onto one survivor line, or why that pairing would lose a fact. */
function pairOne(
  line: Line,
  to: Line,
  survivor: readonly Line[],
): Pair | { error: string } {
  const keeps = (from: unknown, into: unknown) =>
    from === null || from === into;
  if (
    !keeps(line.productId, to.productId) ||
    !keeps(line.projectId, to.projectId) ||
    !keeps(line.productQuantity, to.productQuantity) ||
    (line.attribution !== "[]" && line.attribution !== to.attribution)
  )
    return {
      error: `The duplicate line "${line.title}" carries a Product, Project, quantity or attribution the survivor's line does not.`,
    };
  const carry: Partial<Record<CarriedField, string>> = {};
  for (const field of CARRIED_FIELDS) {
    const value = line.carried[field];
    if (value === null || value === to.carried[field]) continue;
    if (to.carried[field] !== null)
      return {
        error: `The duplicate line "${line.title}" and its survivor line disagree on ${field}.`,
      };
    carry[field] = value;
  }
  // A booking code another survivor line already holds would book one charge twice.
  if (
    carry.bookingTransactionCode &&
    survivor.some(
      (other) =>
        other.id !== to.id &&
        other.carried.bookingTransactionCode === carry.bookingTransactionCode,
    )
  )
    return {
      error: `The duplicate line "${line.title}" carries a booking another survivor line already holds.`,
    };
  // Only principal lines carry a spending category.
  if (carry.spendingCategoryId && to.lineKind !== "principal")
    return {
      error: `The duplicate line "${line.title}" carries a spending category its survivor's ${to.lineKind} line cannot hold.`,
    };
  return { from: line, to, carry };
}

/**
 * Booking-fact matches outrank title matches, which outrank role matches,
 * across a whole assignment: each tier's weight exceeds the most any lower
 * tier can add for a group of at most PAIRING_GROUP_MAX lines.
 */
const pairScore = (pair: Pair) =>
  (JSON.stringify(pair.from.carried) === JSON.stringify(pair.to.carried)
    ? 100
    : 0) +
  (titleOf(pair.from) === titleOf(pair.to) ? 10 : 0) +
  (pair.from.lineKind === pair.to.lineKind ? 1 : 0);

/** The best complete assignment found so far for one amount. */
type PairingSearch = {
  best: { score: number; pairs: Pair[] } | null;
  tied: boolean;
  firstError: string | null;
};

/** Most lines of one amount the exhaustive assignment search accepts. */
const PAIRING_GROUP_MAX = 8;

/**
 * Pair every duplicate line with one survivor line of the same amount: money
 * pairs by cents, since two documents may title or classify a line
 * differently. Within each amount, every valid one-to-one assignment is
 * scored and the best wins; two different best assignments are ambiguous and
 * refuse, so row order never decides which line a source binds to. The
 * survivor keeps its own description.
 */
function pairLines(duplicate: Line[], survivor: Line[]) {
  if (duplicate.length !== survivor.length)
    return { error: "The two Purchases hold different numbers of lines." };
  const groups = new Map<string, { from: Line[]; to: Line[] }>();
  const group = (line: Line) => {
    const key = String(centsOf(line));
    const found = groups.get(key) ?? { from: [], to: [] };
    groups.set(key, found);
    return found;
  };
  for (const line of duplicate) group(line).from.push(line);
  for (const line of survivor) group(line).to.push(line);
  const pairs: Pair[] = [];
  for (const { from, to } of groups.values()) {
    if (from.length !== to.length)
      return {
        error: `The duplicate line "${(from[0] ?? to[0])!.title}" has no survivor line of the same amount.`,
      };
    if (from.length > PAIRING_GROUP_MAX)
      return {
        error: `More than ${PAIRING_GROUP_MAX} lines share one amount; pair them by review.`,
      };
    const state: PairingSearch = { best: null, tied: false, firstError: null };
    const used = new Set<number>();
    const chosen: Pair[] = [];
    const search = (index: number, score: number) => {
      if (index === from.length) {
        if (!state.best || score > state.best.score) {
          state.best = { score, pairs: [...chosen] };
          state.tied = false;
        } else if (score === state.best.score) state.tied = true;
        return;
      }
      for (const [position, candidate] of to.entries()) {
        if (used.has(position)) continue;
        const pair = pairOne(from[index]!, candidate, survivor);
        if ("error" in pair) {
          state.firstError ??= pair.error;
          continue;
        }
        used.add(position);
        chosen.push(pair);
        search(index + 1, score + pairScore(pair));
        chosen.pop();
        used.delete(position);
      }
    };
    search(0, 0);
    const found = state.best;
    if (!found)
      return {
        error:
          state.firstError ?? "The duplicate lines do not match the survivor.",
      };
    if (state.tied)
      return {
        error: `Lines of one amount ("${from[0]!.title}") pair equally well more than one way; converge them by review.`,
      };
    pairs.push(...found.pairs);
  }
  return { pairs };
}

/**
 * One order imported twice from two source documents (a pre-payment notice
 * and its receipt): move the duplicate Purchase's accepted source orders onto
 * the survivor, bind their lines to the survivor's identical lines, retire the
 * duplicate lines and fold the rest of the duplicate (Email links, documents,
 * payments, allocations, shipments) through the Purchase merge. One
 * transaction; a repeat after success returns `already_applied`.
 */
export async function convergeDuplicateSourceOrder(
  db: Database,
  input: { survivorPurchaseId: string; duplicatePurchaseId: string },
  actor: ActorContext,
) {
  return withTransaction(db, async (tx) => {
    const survivorId = await resolveOrThrow(
      tx,
      "purchase",
      input.survivorPurchaseId,
    );
    const [identity] = await tx
      .select({
        id: entityIdentity.id,
        mergedIntoId: entityIdentity.mergedIntoId,
      })
      .from(entityIdentity)
      .where(eq(entityIdentity.shortcode, input.duplicatePurchaseId))
      .limit(1);
    if (!identity)
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        `Purchase not found: ${input.duplicatePurchaseId}`,
      );
    if (identity.mergedIntoId === survivorId) {
      // Only this command's own record proves the duplicate lines were retired;
      // a plain merge into the survivor keeps both line sets.
      const [converged] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityId, survivorId),
            sql`${auditLog.changes} -> 'convergedSourceOrder' -> 'to' ->> 'duplicate' = ${identity.id}`,
          ),
        )
        .limit(1);
      if (!converged)
        throw createAppError(
          "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
          `${input.duplicatePurchaseId} was merged into ${input.survivorPurchaseId} without converging its lines; review the survivor's line sets.`,
        );
      return {
        status: "already_applied" as const,
        survivorPurchaseId: parseShortcodeFor(
          "purchase",
          input.survivorPurchaseId,
        ),
        retiredExpenseIds: [],
        movedSourceOrders: 0,
      };
    }
    // SAFETY: the Entity row was looked up by a PUR- shortcode, so its id is a Purchase id.
    const duplicateId = identity.id as PurchaseId;
    if (duplicateId === survivorId)
      throw createAppError(
        "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
        "Name two different Purchases.",
      );
    const rows = await tx
      .select()
      .from(purchase)
      .where(
        and(
          inArray(purchase.id, [survivorId, duplicateId]),
          notDeleted(purchase),
        ),
      )
      .for("update");
    const survivor = rows.find((row) => row.id === survivorId);
    const duplicate = rows.find((row) => row.id === duplicateId);
    if (!survivor || !duplicate)
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        "Both Purchases must be live.",
      );
    if (survivor.vendorId !== duplicate.vendorId)
      throw createAppError(
        "PURCHASE_MERGE_VENDOR_MISMATCH",
        "The two Purchases belong to different Vendors.",
      );
    if (
      survivor.vendorAccountId !== null &&
      duplicate.vendorAccountId !== null &&
      survivor.vendorAccountId !== duplicate.vendorAccountId
    )
      throw createAppError(
        "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
        "The two Purchases belong to different vendor accounts.",
      );
    if (
      survivor.orderId !== null &&
      duplicate.orderId !== null &&
      normalizeOrderKey(survivor.orderId) !==
        normalizeOrderKey(duplicate.orderId)
    )
      throw createAppError(
        "PURCHASE_MERGE_ORDER_COLLISION",
        `The Purchases carry different order ids (${survivor.orderId}, ${duplicate.orderId}).`,
      );
    // Unless both sides carry the same order id, only one shared Email thread
    // and the same date tie the two documents to one order; two identical rides
    // do not.
    if (survivor.orderId === null || duplicate.orderId === null) {
      const threads = await tx
        .selectDistinct({
          purchaseId: importSourceOrder.purchaseId,
          thread: sql<string>`${emailTable.mailboxId} || ':' || ${emailTable.threadId}`,
        })
        .from(importSourceOrder)
        .innerJoin(
          importSourceClaim,
          eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
        )
        .innerJoin(
          emailTable,
          and(
            // A message key, or one of its attachments' keys.
            sql`(${importSourceClaim.externalKey} = ${emailTable.provider} || ':' || ${emailTable.mailboxId} || ':' || ${emailTable.messageId}
              OR starts_with(${importSourceClaim.externalKey}, ${emailTable.provider} || ':' || ${emailTable.mailboxId} || ':' || ${emailTable.messageId} || ':attachment:'))`,
            isNotNull(emailTable.threadId),
            notDeleted(emailTable),
          ),
        )
        .where(
          inArray(importSourceOrder.purchaseId, [survivorId, duplicateId]),
        );
      const survivorThreads = new Set(
        threads
          .filter((row) => row.purchaseId === survivorId)
          .map((row) => row.thread),
      );
      const sharesThread = threads.some(
        (row) =>
          row.purchaseId === duplicateId && survivorThreads.has(row.thread),
      );
      if (!sharesThread || survivor.date !== duplicate.date)
        throw createAppError(
          "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
          "The Purchases share no order id, and their source Emails share no thread and date; they may be two orders.",
        );
    }
    const sourceOrders = await tx
      .select({ id: importSourceOrder.id })
      .from(importSourceOrder)
      .where(eq(importSourceOrder.purchaseId, duplicateId))
      .for("update");
    if (sourceOrders.length === 0)
      throw createAppError(
        "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
        "The duplicate Purchase has no accepted source order to move.",
      );

    const duplicateLines = await readLines(tx, duplicateId);
    const survivorLines = await readLines(tx, survivorId);
    const claimed = duplicateLines.length
      ? await tx
          .select({ expenseId: ledgerSourceClaim.expenseId })
          .from(ledgerSourceClaim)
          .where(
            and(
              inArray(
                ledgerSourceClaim.expenseId,
                duplicateLines.map((line) => line.id),
              ),
              isNotNull(ledgerSourceClaim.expenseId),
              notDeleted(ledgerSourceClaim),
            ),
          )
      : [];
    if (claimed.length)
      throw createAppError(
        "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
        "A duplicate line carries financial source claims; correct its booking instead.",
      );
    const paired = pairLines(duplicateLines, survivorLines);
    if (!paired.pairs)
      throw createAppError(
        "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
        paired.error ?? "The duplicate lines do not match the survivor.",
      );

    // Source bindings move to the survivor's identical line before the
    // duplicate is retired, so the accepted source replays onto it.
    for (const { from, to } of paired.pairs)
      await tx
        .update(importSourceProduct)
        .set({ expenseId: to.id })
        .where(
          and(
            inArray(
              importSourceProduct.sourceOrderId,
              sourceOrders.map((row) => row.id),
            ),
            eq(importSourceProduct.expenseId, from.id),
          ),
        );
    for (const { to, carry } of paired.pairs) {
      if (Object.keys(carry).length === 0) continue;
      await tx
        .update(expense)
        .set({
          ...(carry.bookingTransactionCode
            ? { bookingTransactionCode: carry.bookingTransactionCode }
            : {}),
          ...(carry.spendingCategoryId
            ? {
                // SAFETY: copied from a live Expense's own spendingCategoryId column.
                spendingCategoryId:
                  carry.spendingCategoryId as typeof expense.$inferInsert.spendingCategoryId,
              }
            : {}),
          ...(carry.trade
            ? {
                // SAFETY: copied from a live Expense's own trade column.
                trade: carry.trade as typeof expense.$inferInsert.trade,
              }
            : {}),
        })
        .where(eq(expense.id, to.id));
      await logAuditEntries(tx, actor, [
        {
          entityKind: "expense" as const,
          entityId: to.id,
          action: "update" as const,
          changes: Object.fromEntries(
            Object.entries(carry).map(([field, value]) => [
              field,
              { from: null, to: value },
            ]),
          ),
        },
      ]);
    }
    const transactionDb = databaseForTransaction(tx);
    if (duplicateLines.length)
      await deleteExpensesWithPurchaseEffects(
        transactionDb,
        duplicateLines.map((line) =>
          parseShortcodeFor("expense", line.shortcode),
        ),
        actor,
      );
    await logAuditEntries(tx, actor, [
      {
        entityKind: "purchase" as const,
        entityId: survivorId,
        action: "update" as const,
        changes: {
          convergedSourceOrder: {
            from: null,
            to: {
              duplicate: duplicateId,
              lines: paired.pairs.map(({ from, to }) => [from.id, to.id]),
            },
          },
        },
      },
    ]);
    await mergePurchases(
      transactionDb,
      {
        keepId: parseShortcodeFor("purchase", survivor.shortcode),
        mergeIds: [parseShortcodeFor("purchase", duplicate.shortcode)],
      },
      actor,
    );
    return {
      status: "applied" as const,
      survivorPurchaseId: parseShortcodeFor("purchase", survivor.shortcode),
      retiredExpenseIds: duplicateLines.map((line) =>
        parseShortcodeFor("expense", line.shortcode),
      ),
      movedSourceOrders: sourceOrders.length,
    };
  });
}
