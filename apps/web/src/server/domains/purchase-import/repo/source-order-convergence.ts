import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type ExpenseId,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import {
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import {
  expense,
  expenseAttribution,
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
};

const lineKey = (line: Line) =>
  JSON.stringify([
    line.title.trim().replace(/\s+/gu, " ").toLowerCase(),
    line.amount === null ? null : cents(line.amount),
    line.lineKind,
  ]);

async function readLines(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
): Promise<Line[]> {
  const rows = await tx
    .select({
      id: expense.id,
      shortcode: expense.shortcode,
      title: expense.name,
      amount: expense.cost,
      lineKind: expense.lineKind,
      productId: expense.productId,
      projectId: expense.projectId,
      productQuantity: expense.productQuantity,
      economicRole: expense.economicRole,
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
  }));
}

/**
 * Pair every duplicate line with one survivor line carrying the same title,
 * amount and role. Product, Project, quantity and party attribution must not
 * be lost: a duplicate value has to equal its survivor's or be empty.
 */
function pairLines(duplicate: Line[], survivor: Line[]) {
  if (duplicate.length !== survivor.length)
    return { error: "The two Purchases hold different numbers of lines." };
  const unused = [...survivor];
  const pairs: Array<{ from: Line; to: Line }> = [];
  for (const line of duplicate) {
    const index = unused.findIndex(
      (candidate) => lineKey(candidate) === lineKey(line),
    );
    if (index < 0)
      return {
        error: `The duplicate line "${line.title}" has no identical line on the survivor.`,
      };
    const [match] = unused.splice(index, 1);
    const to = match!;
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
    pairs.push({ from: line, to });
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
    if (identity.mergedIntoId === survivorId)
      return {
        status: "already_applied" as const,
        survivorPurchaseId: parseShortcodeFor(
          "purchase",
          input.survivorPurchaseId,
        ),
        retiredExpenseIds: [],
        movedSourceOrders: 0,
      };
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
