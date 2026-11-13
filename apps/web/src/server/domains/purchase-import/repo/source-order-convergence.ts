import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor, type PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
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
import { duplicateSourceOrderReplay } from "~/server/domains/purchase-import/policy/duplicate-source-order";
import { duplicateSourceOrderRefusal } from "~/server/domains/purchase-import/policy/duplicate-source-order";
import {
  Line,
  pairLines,
} from "~/server/domains/purchase-import/policy/duplicate-source-order";
import { mergePurchases } from "~/server/domains/purchase/repo/purchase";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { normalizeOrderKey } from "./order-identity";

async function readLines(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
): Promise<Line[]> {
  const rows = await tx
    .select({
      id: expense.id,
      shortcode: expense.shortcode,
      title: expense.name,
      amountMinor: expense.cost,
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
    amountMinor: row.amountMinor,
    economicRole: row.economicRole,
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
    const [converged] =
      identity?.mergedIntoId === survivorId
        ? await tx
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entityId, survivorId),
                sql`${auditLog.changes} -> 'convergedSourceOrder' -> 'to' ->> 'duplicate' = ${identity.id}`,
              ),
            )
            .limit(1)
        : [];
    const replay = duplicateSourceOrderReplay({
      identity: identity ?? null,
      survivorId,
      survivorCode: input.survivorPurchaseId,
      duplicateCode: input.duplicatePurchaseId,
      hasReceipt: Boolean(converged),
    });
    if (replay.kind === "refused")
      throw createAppError(replay.code, replay.reason);
    if (replay.kind === "already_applied")
      return {
        status: "already_applied" as const,
        survivorPurchaseId: parseShortcodeFor(
          "purchase",
          input.survivorPurchaseId,
        ),
        retiredExpenseIds: [],
        movedSourceOrders: 0,
      };
    const duplicateId = parseEntityId("purchase", replay.identity.id);
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
    let sharesThread = false;
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
      sharesThread = threads.some(
        (row) =>
          row.purchaseId === duplicateId && survivorThreads.has(row.thread),
      );
    }
    const sourceOrders = await tx
      .select({ id: importSourceOrder.id })
      .from(importSourceOrder)
      .where(eq(importSourceOrder.purchaseId, duplicateId))
      .for("update");
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
    const refusal = duplicateSourceOrderRefusal({
      survivor,
      duplicate,
      survivorOrderKey:
        survivor.orderId === null ? null : normalizeOrderKey(survivor.orderId),
      duplicateOrderKey:
        duplicate.orderId === null
          ? null
          : normalizeOrderKey(duplicate.orderId),
      sharesThread,
      hasSourceOrder: sourceOrders.length > 0,
      hasClaimedLine: claimed.length > 0,
      duplicateLines,
      survivorLines,
    });
    if (refusal) throw createAppError(refusal.code, refusal.reason);
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
