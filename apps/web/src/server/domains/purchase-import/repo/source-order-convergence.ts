import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  parseShortcodeFor,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import {
  convergeDuplicateSourceOrderInput,
  convergeDuplicateSourceOrderOut,
} from "@cubby/schemas/purchase-import";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { notDeleted } from "~/server/db/helpers/predicates";
import { textArrayParam } from "~/server/db/helpers/query";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  auditLog,
  email,
  expense,
  expenseAttribution,
  ledgerSourceClaim,
  purchase,
} from "~/server/db/schema";
import {
  rejectPurchaseEventWhere,
  updatePurchaseEventWhere,
} from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { purchaseRecords } from "~/server/domains/financial-transaction/repo/purchase-event-records";
import { loadExpenseAllocations } from "~/server/domains/household-contribution/repo/allocation";
import {
  duplicateSourceOrderReplay,
  duplicateSourceOrderRefusal,
  pairLines,
  type Line,
} from "~/server/domains/purchase-import/policy/duplicate-source-order";
import { normalizeOrderKey } from "~/server/domains/purchase-import/policy/order-identity";
import {
  orderEventKey,
  orderPaymentKeys,
} from "~/server/domains/purchase-import/policy/payment-keys";
import {
  acceptedOrders,
  acceptedOrderLinesSql,
} from "~/server/domains/purchase-import/repo/accepted-order-read";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import {
  decide,
  householdWrite,
  merge,
  recordSubject,
  resolveForRead,
  type DecisionInput,
} from "~/server/kernel/api";

import { settleOrderEvidence } from "./settle-order-evidence";

async function readLines(
  database: Database,
  purchaseId: PurchaseId,
): Promise<Line[]> {
  const tx = repositoryQueries(database);
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
  const recorded = rows.length
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
  const attributions = rows.length
    ? await loadExpenseAllocations(database, {
        expenseIds: rows.map((row) => row.id),
        includeFuture: true,
      })
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
    effectiveAttribution: JSON.stringify(
      attributions
        .filter((item) => item.expenseId === row.id)
        .map((item) => [item.role, item.ledgerPartyId, item.cents.toString()])
        .sort(),
    ),
    attribution: JSON.stringify(
      recorded
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

/** Converge proven duplicate line sets without rewriting their source captures. */
export async function convergeDuplicateSourceOrder(
  db: Database,
  raw: { survivorPurchaseId: string; duplicatePurchaseId: string },
  actor: ActorContext,
) {
  const input = convergeDuplicateSourceOrderInput.parse(raw);
  return householdWrite(db, async (database) => {
    const first = await resolveForRead(database, input.survivorPurchaseId);
    if (first?.entity !== "purchase")
      throw new Error("Review two live Purchases");
    const q = repositoryQueries(database);
    const [identity] = await q
      .select({
        id: entityIdentity.id,
        mergedIntoId: entityIdentity.mergedIntoId,
      })
      .from(entityIdentity)
      .where(
        and(
          eq(entityIdentity.shortcode, input.duplicatePurchaseId),
          eq(entityIdentity.kind, "purchase"),
        ),
      );
    const [receipt] =
      identity?.mergedIntoId === first.id
        ? await q
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entityId, first.id),
                sql`${auditLog.changes}->'convergedSourceOrder'->'to'->>'duplicate'=${identity.id}`,
              ),
            )
            .limit(1)
        : [];
    const replay = duplicateSourceOrderReplay({
      identity: identity ?? null,
      survivorId: first.id,
      survivorCode: first.shortcode,
      duplicateCode: input.duplicatePurchaseId,
      hasReceipt: !!receipt,
    });
    if (replay.kind === "refused")
      throw createAppError(replay.code, replay.reason);
    if (replay.kind === "already_applied")
      return convergeDuplicateSourceOrderOut.parse({
        status: "already_applied",
        survivorPurchaseId: first.shortcode,
        retiredExpenseIds: [],
        movedSourceOrders: 0,
      });
    const survivorId = parseEntityId("purchase", first.id),
      duplicateId = parseEntityId("purchase", replay.identity.id);
    const rows = await q
      .select()
      .from(purchase)
      .where(
        and(
          inArray(purchase.id, [survivorId, duplicateId]),
          notDeleted(purchase),
        ),
      )
      .orderBy(purchase.id)
      .for("update");
    const survivor = rows.find((row) => row.id === survivorId),
      duplicate = rows.find((row) => row.id === duplicateId);
    if (!survivor || !duplicate) throw new Error("Review two live Purchases");
    const sources = await q
      .select()
      .from(acceptedOrders)
      .where(inArray(acceptedOrders.purchaseId, [survivorId, duplicateId]));
    const duplicateSources = sources.filter(
      (row) => row.purchaseId === duplicateId,
    );
    const threads = await q
      .select({
        id: email.id,
        party: email.ledgerPartyId,
        mailbox: email.mailboxId,
        thread: email.threadId,
      })
      .from(email)
      .where(
        and(
          inArray(
            email.id,
            sources.flatMap((row) => (row.emailId ? [row.emailId] : [])),
          ),
          isNotNull(email.threadId),
          notDeleted(email),
        ),
      );
    const threadOf = (id: string | null) => {
      const row = threads.find((row) => row.id === id);
      return row ? `${row.party}:${row.mailbox}:${row.thread}` : null;
    };
    const survivorThreads = new Set(
      sources
        .filter((row) => row.purchaseId === survivorId)
        .map((row) => threadOf(row.emailId))
        .filter(Boolean),
    );
    const sharesThread = duplicateSources.some((row) => {
      const thread = threadOf(row.emailId);
      return thread !== null && survivorThreads.has(thread);
    });
    const duplicateLines = await readLines(database, duplicateId),
      survivorLines = await readLines(database, survivorId);
    const claimed = duplicateLines.length
      ? await q
          .select({ id: ledgerSourceClaim.id })
          .from(ledgerSourceClaim)
          .where(
            and(
              inArray(
                ledgerSourceClaim.expenseId,
                duplicateLines.map((row) => row.id),
              ),
              notDeleted(ledgerSourceClaim),
            ),
          )
      : [];
    const refusal = duplicateSourceOrderRefusal({
      survivor,
      duplicate,
      survivorOrderKey: survivor.orderId
        ? normalizeOrderKey(survivor.orderId)
        : null,
      duplicateOrderKey: duplicate.orderId
        ? normalizeOrderKey(duplicate.orderId)
        : null,
      sharesThread,
      hasSourceOrder: duplicateSources.length > 0,
      hasClaimedLine: claimed.length > 0,
      duplicateLines,
      survivorLines,
    });
    if (refusal) throw createAppError(refusal.code, refusal.reason);
    const paired = pairLines(duplicateLines, survivorLines);
    if (!paired.pairs)
      throw createAppError(
        "PURCHASE_SOURCE_CONVERGENCE_REFUSED",
        paired.error ?? "The duplicate lines do not match the survivor",
      );
    const records = await q
      .select()
      .from(recordKey)
      .where(
        and(
          eq(recordKey.entity, "purchase"),
          inArray(recordKey.entityId, [survivorId, duplicateId]),
        ),
      );
    const scopes = records.map((row) => ({
      kind: row.scopeKind,
      key: row.scopeKey,
    }));
    const decisions: DecisionInput[] = [
      {
        channel: "identity",
        kind: "same",
        subject: recordSubject("purchase", survivorId),
        field: recordSubject("purchase", duplicateId),
        scopes,
      },
    ];
    const lineOwners = await q.execute<{
      sourceOrderId: string;
      lineIndex: number;
      expenseId: string | null;
    }>(sql`
      SELECT "sourceOrderId", "lineIndex", "expenseId" FROM ${acceptedOrderLinesSql} lines
      WHERE lines."sourceOrderId"=ANY(${textArrayParam(duplicateSources.map((row) => row.id))}::uuid[])`);
    for (const capture of duplicateSources) {
      const sourceScope = {
        kind: "purchaseEvent",
        key: orderEventKey(capture),
      };
      const affected = [
        ...scopes,
        sourceScope,
        ...orderPaymentKeys(capture).map((key) => ({
          kind: "purchaseEvent",
          key,
        })),
      ];
      decisions.push({
        channel: "assignment",
        kind: "set",
        subject: sourceScope.key,
        field: "purchaseId",
        value: survivorId,
        scopes: affected,
      });
      for (const binding of capture.productBindings) {
        const expenseId = lineOwners.rows.find(
          (row) =>
            row.sourceOrderId === capture.id &&
            row.lineIndex === binding.lineIndex,
        )?.expenseId;
        const pair = paired.pairs.find((pair) => pair.from.id === expenseId);
        if (!pair)
          throw new Error(
            "Every duplicate source line needs a proven survivor Expense",
          );
        for (const scope of [
          ...scopes.filter((row) =>
            records.some(
              (owner) =>
                owner.entityId === survivorId && owner.scopeKey === row.key,
            ),
          ),
          sourceScope,
        ]) {
          decisions.push(
            {
              channel: "assignment",
              kind: "set",
              subject: `purchaseEvent:${scope.key}`,
              field: `line-record:${binding.stableLineId ?? binding.lineIndex}`,
              value: pair.to.id,
              scopes: affected,
            },
            {
              channel: "assignment",
              kind: "set",
              subject: `purchaseEvent:${scope.key}`,
              field: `line:${binding.stableLineId ?? binding.lineIndex}`,
              value: pair.to.productId
                ? { kind: "existing", productId: pair.to.productId }
                : { kind: "expense_only" },
              scopes: affected,
            },
          );
        }
      }
    }
    await decide(database, actor, decisions);
    for (const { to, carry } of paired.pairs) {
      if (!Object.keys(carry).length) continue;
      await updatePurchaseEventWhere(
        database,
        "expense",
        {
          ...(carry.bookingTransactionCode
            ? { bookingTransactionCode: carry.bookingTransactionCode }
            : {}),
          ...(carry.spendingCategoryId
            ? {
                spendingCategoryId: parseEntityId(
                  "spendingCategory",
                  carry.spendingCategoryId,
                ),
              }
            : {}),
          ...(carry.trade ? { trade: tradeSchema.parse(carry.trade) } : {}),
        },
        eq(expense.id, to.id),
        actor,
      );
    }
    await rejectPurchaseEventWhere(
      database,
      "expense",
      inArray(
        expense.id,
        duplicateLines.map((row) => row.id),
      ),
      actor,
    );
    const result = await merge(database, {
      target: purchaseRecords,
      a: survivorId,
      b: duplicateId,
      basis: "decision",
      keepId: survivorId,
      actor,
    });
    if (!result.merged)
      throw new Error(`The orders cannot merge: ${result.reason}`);
    const outcomes = await settleOrderEvidence(database, sources);
    if (
      outcomes.some(
        (row) => row.status === "failed" || row.status === "conflict",
      )
    )
      throw new Error("Duplicate source ownership did not reconcile");
    const after = await readLines(database, survivorId);
    if (
      after.length !== survivorLines.length ||
      after.some(
        (row) =>
          !survivorLines.some(
            (old) => old.id === row.id && old.amountMinor === row.amountMinor,
          ),
      )
    )
      throw new Error(
        "Source convergence must preserve the survivor's exact Expense identities and spending",
      );
    const accepted = await q
      .select({ id: acceptedOrders.id, purchaseId: acceptedOrders.purchaseId })
      .from(acceptedOrders)
      .where(
        inArray(
          acceptedOrders.id,
          duplicateSources.map((row) => row.id),
        ),
      );
    if (
      duplicateSources.some(
        (row) =>
          !accepted.some(
            (bound) => bound.id === row.id && bound.purchaseId === survivorId,
          ),
      )
    )
      throw new Error(
        "Source convergence did not retain every accepted capture",
      );
    await logAuditEntries(database, actor, [
      {
        entityKind: "purchase",
        entityId: survivorId,
        action: "update",
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
    return convergeDuplicateSourceOrderOut.parse({
      status: "applied",
      survivorPurchaseId: first.shortcode,
      retiredExpenseIds: duplicateLines.map((row) =>
        parseShortcodeFor("expense", row.shortcode),
      ),
      movedSourceOrders: duplicateSources.length,
    });
  });
}
