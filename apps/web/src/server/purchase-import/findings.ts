import { auditEntitySchema } from "@cubby/schemas/audit";
import type { ActorContext } from "@cubby/schemas/context";
import { costTypeSchema } from "@cubby/schemas/expense-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  resolveRunFindingInput,
  resolveRunFindingOut,
  type ResolveRunFindingInput,
} from "@cubby/schemas/problems";
import {
  proposedImportFix,
  type ProposedImportFix,
} from "@cubby/schemas/purchase-import";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  expense,
  auditLog,
  runFinding,
  importHunt,
  runMutation,
  importSourceClaim,
  inventoryEntry,
  ledgerParty,
  orderMail,
  orderMailEvent,
  product,
  purchase,
} from "~/server/db/schema";
import { logAuditEntries } from "~/server/repo/audit-log";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { validateExpenseInheritance } from "~/server/repo/expense-inheritance";
import { cascadeRemoval } from "~/server/repo/removal";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { decideLineWrite, type ExistingExpenseSnapshot } from "./writer-policy";

const loadExpenses = async (
  tx: DrizzleTransaction,
  purchaseId: string,
): Promise<ExistingExpenseSnapshot[]> => {
  const rows = await tx
    .select({
      id: expense.id,
      title: expense.name,
      amount: expense.cost,
      lineKind: expense.lineKind,
      productId: expense.productId,
      tradeId: expense.trade,
      projectId: expense.projectId,
      costType: expense.costType,
      sourceClaimId: importSourceClaim.id,
    })
    .from(expense)
    .leftJoin(
      importSourceClaim,
      eq(importSourceClaim.purchaseId, expense.purchaseId),
    )
    .where(
      and(
        eq(expense.purchaseId, parseEntityId("purchase", purchaseId)),
        notDeleted(expense),
      ),
    );
  return rows.map(({ sourceClaimId, ...row }) => ({
    ...row,
    sourceClaimed: sourceClaimId !== null,
  }));
};

/**
 * Refund Expenses of this amount already on the Purchase, and refund mails
 * for the order and amount.
 *
 * Equal partial refunds on one order are distinct money, so "an Expense of
 * this amount already exists" cannot mean "already booked". Each distinct
 * refund mail is one refund; a booked Expense of the amount (from an applied
 * finding, order history, or a human) covers one of them. Mails are counted
 * by content, so a resent copy stays one refund. A vendor's "refund
 * initiated" and "refund issued" mails still count as two: the mail alone
 * cannot tell them from two equal refunds, so the finding says so and the
 * reviewer decides.
 */
export async function refundTally(
  executor: DrizzleClient | DrizzleTransaction,
  input: { purchaseId: string; ledgerPartyId: string; amount: number },
): Promise<{ booked: number; evidenced: number }> {
  const refundCents = Math.round(Math.abs(input.amount) * 100);
  const purchaseId = parseEntityId("purchase", input.purchaseId);
  // Sequential: a transaction handle runs one statement at a time.
  const [booked] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(expense)
    .where(
      and(
        eq(expense.purchaseId, purchaseId),
        sql`round(${expense.cost} * 100) = ${-refundCents}`,
        notDeleted(expense),
      ),
    );
  const [evidenced] = await executor
    .select({
      count: sql<number>`count(distinct ${orderMail.rawChecksum})::int`,
    })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .innerJoin(
      purchase,
      and(
        eq(purchase.vendorId, orderMail.vendorId),
        eq(purchase.orderId, orderMailEvent.orderId),
      ),
    )
    .where(
      and(
        eq(purchase.id, purchaseId),
        eq(
          orderMail.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(orderMailEvent.event, "refunded"),
        sql`round(abs(${orderMailEvent.amount}) * 100) = ${refundCents}`,
      ),
    );
  return { booked: booked?.count ?? 0, evidenced: evidenced?.count ?? 0 };
}

/** Whether another refund Expense of this amount belongs on the Purchase. */
async function refundStillUnbooked(
  executor: DrizzleClient | DrizzleTransaction,
  input: { purchaseId: string; ledgerPartyId: string; amount: number },
): Promise<boolean> {
  const { booked, evidenced } = await refundTally(executor, input);
  // A refund finding without mail evidence still stands for one refund.
  return booked < Math.max(evidenced, 1);
}

const assertFixTargetsFinding = (
  finding: {
    targetKind: string;
    targetId: string;
  },
  fix: ProposedImportFix,
) => {
  const targetMatches =
    fix.kind === "relink_product"
      ? finding.targetKind === "expense" && finding.targetId === fix.expenseId
      : finding.targetKind === "purchase" &&
        finding.targetId === fix.purchaseId;
  if (!targetMatches) {
    throw new Error(
      "The proposed fix no longer targets the finding's original record.",
    );
  }
};

const assertRunProvenance = async (
  tx: DrizzleTransaction,
  finding: {
    runId: string | null;
    targetKind: string;
    targetId: string;
  },
) => {
  if (!finding.runId) return;
  const [mutation] = await tx
    .select({
      id: runMutation.id,
      createdAt: runMutation.createdAt,
    })
    .from(runMutation)
    .where(
      and(
        eq(runMutation.runId, finding.runId),
        eq(runMutation.targetKind, finding.targetKind),
        eq(runMutation.targetId, finding.targetId),
      ),
    )
    .limit(1);
  if (!mutation) {
    throw new Error(
      "The import run did not write this finding's target; refusing a stale automated fix.",
    );
  }
  const auditEntity = auditEntitySchema.parse(finding.targetKind);
  const [laterHumanWrite] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, auditEntity),
        eq(auditLog.entityId, finding.targetId),
        gt(auditLog.createdAt, mutation.createdAt),
      ),
    )
    .limit(1);
  if (laterHumanWrite) {
    throw new Error(
      "This record was edited after the import; refusing a stale automated fix.",
    );
  }
};

async function applyFix(
  tx: DrizzleTransaction,
  fix: ProposedImportFix,
  actor: ActorContext,
  ledgerPartyId: string,
) {
  if (fix.kind === "receive_purchase") {
    throw new Error(
      "Receiving stays interactive. Open the Purchase and use its existing receive flow.",
    );
  }
  if (fix.kind === "relink_product") {
    const expenseId = parseEntityId("expense", fix.expenseId);
    const productId = parseEntityId("product", fix.productId);
    const [targetProduct] = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.id, productId), notDeleted(product)))
      .limit(1);
    if (!targetProduct)
      throw new Error("The proposed Product no longer exists.");
    const [updated] = await tx
      .update(expense)
      .set({ productId, updatedAt: new Date() })
      .where(
        and(
          eq(expense.id, expenseId),
          isNull(expense.productId),
          notDeleted(expense),
        ),
      )
      .returning({ id: expense.id });
    if (!updated) throw new Error("The proposed Expense no longer exists.");
    await logAuditEntries(tx, actor, [
      {
        entityType: "expense",
        entityId: expenseId,
        action: "update",
        changes: { productId: { from: null, to: productId } },
      },
    ]);
    return;
  }

  const purchaseId = parseEntityId("purchase", fix.purchaseId);
  const [targetPurchase] = await tx
    .select({
      id: purchase.id,
      date: purchase.date,
      displayLabel: purchase.displayLabel,
    })
    .from(purchase)
    .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
    .limit(1)
    .for("update");
  if (!targetPurchase)
    throw new Error("The proposed Purchase no longer exists.");

  if (fix.kind === "create_refund") {
    if (
      !(await refundStillUnbooked(tx, {
        purchaseId,
        ledgerPartyId,
        amount: fix.amount,
      }))
    )
      return;
    const row = await insertWithShortcode(tx, "expense", {
      purchaseId,
      name: fix.title,
      cost: fix.amount,
      date: targetPurchase.date,
      lineKind: "principal",
      lineBasis: "item_line",
      costType: "materials",
      trade: null,
    });
    await validateExpenseInheritance(tx, row);
    await logAuditEntries(tx, actor, [
      { entityType: "expense", entityId: row.id, action: "create" },
    ]);
    return;
  }

  if (fix.lines.length === 0)
    throw new Error("The proposed replacement has no lines.");
  const current = await loadExpenses(tx, purchaseId);
  const decision = decideLineWrite(current, fix.lines);
  if (decision.kind !== "replace_aggregate") {
    throw new Error(
      "The Purchase changed after this finding was created; its aggregate can no longer be replaced safely.",
    );
  }
  const aggregate = decision.aggregate;
  await tx
    .update(expense)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(expense.id, parseEntityId("expense", aggregate.id)),
        notDeleted(expense),
      ),
    );
  const audit = [];
  for (const line of decision.lines) {
    const row = await insertWithShortcode(tx, "expense", {
      purchaseId,
      name: line.title,
      notes: line.seller ? `Seller: ${line.seller}` : null,
      cost: line.amount,
      date: targetPurchase.date,
      lineKind: line.lineKind,
      lineBasis: "item_line",
      costType: costTypeSchema.parse(aggregate.costType ?? "materials"),
      trade: tradeSchema.nullable().parse(aggregate.tradeId ?? null),
      projectId:
        line.lineKind === "principal" && aggregate.projectId
          ? parseEntityId("project", aggregate.projectId)
          : null,
    });
    await validateExpenseInheritance(tx, row);
    audit.push({
      entityType: "expense" as const,
      entityId: row.id,
      action: "create" as const,
    });
  }
  await cascadeRemoval(tx, {
    entity: "expense",
    ids: [parseEntityId("expense", aggregate.id)],
    audit: { into: audit },
  });
  await logAuditEntries(tx, actor, audit);
  await tx
    .update(purchase)
    .set({ displayLabel: targetPurchase.displayLabel ?? aggregate.title })
    .where(and(eq(purchase.id, purchaseId), isNull(purchase.deletedAt)));
}

export async function resolveRunFinding(
  db: Database,
  rawInput: ResolveRunFindingInput,
  actor: ActorContext,
) {
  const input = resolveRunFindingInput.parse(rawInput);
  return withTransaction(db, async (tx) => {
    const [finding] = await tx
      .select({
        id: runFinding.id,
        status: runFinding.status,
        proposedFix: runFinding.proposedFix,
        runId: runFinding.runId,
        ledgerPartyId: runFinding.ledgerPartyId,
        targetKind: runFinding.targetKind,
        targetId: runFinding.targetId,
      })
      .from(runFinding)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, runFinding.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(eq(runFinding.id, input.id))
      .limit(1)
      .for("update");
    if (!finding) {
      const [hunt] = await tx
        .select({ id: importHunt.id, state: importHunt.state })
        .from(importHunt)
        .innerJoin(
          ledgerParty,
          and(
            eq(ledgerParty.id, importHunt.ledgerPartyId),
            eq(ledgerParty.userId, actor.userId),
            notDeleted(ledgerParty),
          ),
        )
        .where(eq(importHunt.id, input.id))
        .limit(1)
        .for("update");
      if (!hunt) throw new Error("Import finding not found for this member.");
      if (input.action === "apply") {
        throw new Error(
          "Open Cubby on iPhone or Mac to attach receipt evidence.",
        );
      }
      await tx
        .update(importHunt)
        .set({ state: "dismissed", updatedAt: new Date() })
        .where(eq(importHunt.id, hunt.id));
      return resolveRunFindingOut.parse({
        id: hunt.id,
        status: "dismissed",
      });
    }
    if (finding.status !== "open") {
      throw new Error("This import finding has already been resolved.");
    }
    if (input.action === "apply") {
      const fix = proposedImportFix.parse(finding.proposedFix);
      assertFixTargetsFinding(finding, fix);
      await assertRunProvenance(tx, finding);
      await applyFix(tx, fix, actor, finding.ledgerPartyId);
    }
    const status = input.action === "apply" ? "applied" : "dismissed";
    await tx
      .update(runFinding)
      .set({
        status,
        resolvedAt: new Date(),
        resolvedByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(runFinding.id, finding.id));
    return resolveRunFindingOut.parse({ id: finding.id, status });
  });
}

/**
 * Resolve any OPEN "arrived" findings on a Purchase once receiving has caught
 * up, without ever moving inventory itself (that stays interactive — see
 * `applyFix`'s refusal of `receive_purchase` above).
 *
 * Partial-receipt rule: a Purchase can have several product-bearing Expense
 * lines (one per shipment/item), and a member may receive them one at a time.
 * The finding is left open until EVERY live, product-bearing Expense line on
 * the Purchase has at least one live InventoryEntry for its Product — so
 * receiving line 1 of 2 does not silently close out line 2. This is checked
 * fresh on every call rather than cached, so it stays correct regardless of
 * how many partial receives happened before this one.
 */
export async function resolveArrivedFindingsForPurchase(
  db: Database,
  input: { purchaseId: string },
  actor: ActorContext,
): Promise<{ resolved: number }> {
  return withTransaction(db, async (tx) => {
    const openFindings = await tx
      .select({ id: runFinding.id })
      .from(runFinding)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, runFinding.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          eq(runFinding.targetKind, "purchase"),
          eq(runFinding.targetId, input.purchaseId),
          eq(runFinding.kind, "arrived"),
          eq(runFinding.status, "open"),
        ),
      )
      .for("update");
    if (openFindings.length === 0) return { resolved: 0 };

    const productLines = await tx
      .select({ productId: expense.productId })
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, parseEntityId("purchase", input.purchaseId)),
          isNotNull(expense.productId),
          notDeleted(expense),
        ),
      );
    // No product-bearing line at all: nothing to receive against, so leave
    // the finding open rather than resolving it vacuously.
    if (productLines.length === 0) return { resolved: 0 };

    const productIds = [
      ...new Set(productLines.map(({ productId }) => productId!)),
    ];
    const stocked = await tx
      .select({ productId: inventoryEntry.productId })
      .from(inventoryEntry)
      .where(
        and(
          inArray(inventoryEntry.productId, productIds),
          notDeleted(inventoryEntry),
        ),
      );
    const stockedIds = new Set(stocked.map((row) => row.productId));
    const everyLineReceived = productIds.every((id) => stockedIds.has(id));
    if (!everyLineReceived) return { resolved: 0 };

    const ids = openFindings.map((finding) => finding.id);
    await tx
      .update(runFinding)
      .set({
        status: "applied",
        resolvedAt: new Date(),
        resolvedByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .where(inArray(runFinding.id, ids));
    return { resolved: ids.length };
  });
}
