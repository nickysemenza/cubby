import { auditEntitySchema } from "@cubby/schemas/audit";
import type { ActorContext } from "@cubby/schemas/context";
import { costTypeSchema } from "@cubby/schemas/expense-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  resolveImportFindingInput,
  resolveImportFindingOut,
  type ResolveImportFindingInput,
} from "@cubby/schemas/problems";
import {
  proposedImportFix,
  type ProposedImportFix,
} from "@cubby/schemas/purchase-import";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  auditLog,
  importFinding,
  importHunt,
  importRunMutation,
  importSourceClaim,
  inventoryEntry,
  ledgerParty,
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

const assertFixTargetsFinding = (
  finding: {
    targetType: string;
    targetId: string;
  },
  fix: ProposedImportFix,
) => {
  const targetMatches =
    fix.kind === "relink_product"
      ? finding.targetType === "expense" && finding.targetId === fix.expenseId
      : finding.targetType === "purchase" &&
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
    importRunId: string | null;
    targetType: string;
    targetId: string;
  },
) => {
  if (!finding.importRunId) return;
  const [mutation] = await tx
    .select({
      id: importRunMutation.id,
      createdAt: importRunMutation.createdAt,
    })
    .from(importRunMutation)
    .where(
      and(
        eq(importRunMutation.runId, finding.importRunId),
        eq(importRunMutation.targetType, finding.targetType),
        eq(importRunMutation.targetId, finding.targetId),
      ),
    )
    .limit(1);
  if (!mutation) {
    throw new Error(
      "The import run did not write this finding's target; refusing a stale automated fix.",
    );
  }
  const auditEntity = auditEntitySchema.parse(finding.targetType);
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
    const [existingRefund] = await tx
      .select({ id: expense.id })
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, purchaseId),
          eq(expense.cost, fix.amount),
          notDeleted(expense),
        ),
      )
      .limit(1);
    if (existingRefund) return;
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

export async function resolveImportFinding(
  db: Database,
  rawInput: ResolveImportFindingInput,
  actor: ActorContext,
) {
  const input = resolveImportFindingInput.parse(rawInput);
  return withTransaction(db, async (tx) => {
    const [finding] = await tx
      .select({
        id: importFinding.id,
        status: importFinding.status,
        proposedFix: importFinding.proposedFix,
        importRunId: importFinding.importRunId,
        targetType: importFinding.targetType,
        targetId: importFinding.targetId,
      })
      .from(importFinding)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, importFinding.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(eq(importFinding.id, input.id))
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
      return resolveImportFindingOut.parse({
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
      await applyFix(tx, fix, actor);
    }
    const status = input.action === "apply" ? "applied" : "dismissed";
    await tx
      .update(importFinding)
      .set({
        status,
        resolvedAt: new Date(),
        resolvedByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(importFinding.id, finding.id));
    return resolveImportFindingOut.parse({ id: finding.id, status });
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
      .select({ id: importFinding.id })
      .from(importFinding)
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, importFinding.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          eq(importFinding.targetType, "purchase"),
          eq(importFinding.targetId, input.purchaseId),
          eq(importFinding.kind, "arrived"),
          eq(importFinding.status, "open"),
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
      .update(importFinding)
      .set({
        status: "applied",
        resolvedAt: new Date(),
        resolvedByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .where(inArray(importFinding.id, ids));
    return { resolved: ids.length };
  });
}
