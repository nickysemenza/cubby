import type { ActorContext } from "@cubby/schemas/context";
import type { ExpenseId, InventoryId } from "@cubby/schemas/identifiers";
import type { InventoryOwnershipSelection } from "@cubby/schemas/inventory-ownership";
import { and, asc, eq } from "drizzle-orm";

import { computeInventoryValuation } from "~/lib/price-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { expense, inventoryEntry } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { isSerializationFailure } from "~/server/errors/db-errors";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntry,
  logAuditEntries,
} from "~/server/repo/audit-log";
import {
  notDeleted,
  parseInventoryAmount,
  updateAndReturn,
  getDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { getExpenseByID } from "~/server/repo/expense";
import { replaceExpenseAttributionRole } from "~/server/repo/expense-attribution";
import { cascadeRemoval } from "~/server/repo/removal";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  assertIndividualOwner,
  loadEffectiveInventoryOwnership,
} from "./ownership";
import {
  assertValidRawInventoryOwnership,
  type InventoryRawOwnership,
} from "./slot";
import { loadValuationGraph } from "./valuation";

const assertValidIndividualOwner = async (
  tx: DrizzleTransaction,
  ownerId: NonNullable<InventoryRawOwnership["ownerLedgerPartyId"]>,
): Promise<void> => {
  try {
    await assertIndividualOwner(tx, ownerId);
  } catch {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Inventory can only be assigned to a live member or guest.",
    );
  }
};

const withSerializableConfirmation = async <Result>(
  db: Database,
  confirm: (tx: DrizzleTransaction) => Promise<Result>,
): Promise<Result> => {
  try {
    return await getDb(db).transaction(confirm, {
      isolationLevel: "serializable",
    });
  } catch (error) {
    if (isSerializationFailure(error)) {
      throw createAppError(
        "INVENTORY_STALE",
        "Ownership evidence changed during confirmation. Refresh and review it again.",
        error,
      );
    }
    throw error;
  }
};

const resolveRawOwnership = async (
  tx: DrizzleTransaction,
  selection: InventoryOwnershipSelection,
): Promise<InventoryRawOwnership> => {
  const ownerLedgerPartyId =
    selection.mode === "person"
      ? await resolveOrThrow(tx, "ledgerParty", selection.ownerId)
      : null;
  const ownership = {
    ownershipMode: selection.mode,
    ownerLedgerPartyId,
  };
  assertValidRawInventoryOwnership(ownership);
  if (ownerLedgerPartyId) {
    await assertValidIndividualOwner(tx, ownerLedgerPartyId);
  }
  return ownership;
};

export const applyInventoryOwnershipInTransaction = async (
  tx: DrizzleTransaction,
  id: InventoryId,
  ownership: InventoryRawOwnership,
  quantity: number | undefined,
  actor: ActorContext,
): Promise<InventoryId[]> => {
  const [sourceSlot] = await tx
    .select({
      productId: inventoryEntry.productId,
      locationId: inventoryEntry.locationId,
      placement: inventoryEntry.placement,
    })
    .from(inventoryEntry)
    .where(and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)))
    .limit(1);
  if (!sourceSlot) {
    throw createAppError("INVENTORY_NOT_FOUND", "Inventory entry not found");
  }

  // Lock the complete physical slot in ID order. Opposite-direction transfers
  // therefore acquire the same rows in the same order, and every amount used
  // below reflects mutations that committed before this transfer acquired them.
  const lockedSlotRows = await tx
    .select()
    .from(inventoryEntry)
    .where(
      and(
        eq(inventoryEntry.productId, sourceSlot.productId),
        eq(inventoryEntry.locationId, sourceSlot.locationId),
        eq(inventoryEntry.placement, sourceSlot.placement),
        notDeleted(inventoryEntry),
      ),
    )
    .orderBy(asc(inventoryEntry.id))
    .for("update");
  const source = lockedSlotRows.find((row) => row.id === id);
  if (!source) {
    throw createAppError(
      "INVENTORY_STALE",
      "Inventory changed during ownership reassignment. Refresh and try again.",
    );
  }
  const sourceAmount = parseInventoryAmount(source.amount, source.id);
  const transferValue = quantity ?? sourceAmount.value;
  if (transferValue > sourceAmount.value) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Cannot reassign ${transferValue}; only ${sourceAmount.value} is available.`,
    );
  }
  if (
    source.ownershipMode === ownership.ownershipMode &&
    source.ownerLedgerPartyId === ownership.ownerLedgerPartyId
  ) {
    return [source.id];
  }

  const target = lockedSlotRows.find(
    (row) =>
      row.ownershipMode === ownership.ownershipMode &&
      row.ownerLedgerPartyId === ownership.ownerLedgerPartyId,
  );
  const graph = await loadValuationGraph(tx, source.productId);
  const movedAmount = { value: transferValue, unit: sourceAmount.unit };
  const audit: AuditEntryInput[] = [];
  const resultIds: InventoryId[] = [];

  if (target) {
    const targetAmount = parseInventoryAmount(target.amount, target.id);
    if (targetAmount.unit !== sourceAmount.unit) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Cannot combine ${sourceAmount.unit} with ${targetAmount.unit}; reconcile the units first.`,
      );
    }
    const nextTargetAmount = {
      value: targetAmount.value + transferValue,
      unit: targetAmount.unit,
    };
    const updatedTarget = await updateAndReturn(
      tx,
      inventoryEntry,
      {
        amount: nextTargetAmount,
        valuation: computeInventoryValuation(nextTargetAmount, graph),
      },
      eq(inventoryEntry.id, target.id),
    );
    const changes = computeChanges(target, updatedTarget, ["amount"]);
    const targetAudit: AuditEntryInput = {
      entityType: "inventory",
      entityId: target.id,
      action: "update",
    };
    if (changes) targetAudit.changes = changes;
    audit.push(targetAudit);
    resultIds.push(target.id);
  } else if (transferValue === sourceAmount.value) {
    const updated = await updateAndReturn(
      tx,
      inventoryEntry,
      ownership,
      eq(inventoryEntry.id, source.id),
    );
    const changes = computeChanges(source, updated, [
      "ownershipMode",
      "ownerLedgerPartyId",
    ]);
    const ownershipAudit: AuditEntryInput = {
      entityType: "inventory",
      entityId: source.id,
      action: "update",
    };
    if (changes) ownershipAudit.changes = changes;
    audit.push(ownershipAudit);
    resultIds.push(source.id);
  } else {
    const created = await insertWithShortcode(tx, "inventory", {
      productId: source.productId,
      locationId: source.locationId,
      placement: source.placement,
      ...ownership,
      amount: movedAmount,
      valuation: computeInventoryValuation(movedAmount, graph),
    });
    audit.push({
      entityType: "inventory",
      entityId: created.id,
      action: "create",
    });
    resultIds.push(created.id);
  }

  if (transferValue === sourceAmount.value && target) {
    await tx.delete(inventoryEntry).where(eq(inventoryEntry.id, source.id));
    await cascadeRemoval(tx, {
      entity: "inventory",
      ids: [source.id],
      audit: { into: audit },
    });
  } else if (transferValue < sourceAmount.value) {
    const remaining = {
      value: sourceAmount.value - transferValue,
      unit: sourceAmount.unit,
    };
    const updatedSource = await updateAndReturn(
      tx,
      inventoryEntry,
      {
        amount: remaining,
        valuation: computeInventoryValuation(remaining, graph),
      },
      eq(inventoryEntry.id, source.id),
    );
    const changes = computeChanges(source, updatedSource, ["amount"]);
    const sourceAudit: AuditEntryInput = {
      entityType: "inventory",
      entityId: source.id,
      action: "update",
    };
    if (changes) sourceAudit.changes = changes;
    audit.push(sourceAudit);
    resultIds.unshift(source.id);
  }
  await logAuditEntries(tx, actor, audit);
  return resultIds;
};

export const setInventoryOwnership = async (
  db: Database,
  id: InventoryId,
  selection: InventoryOwnershipSelection,
  quantity: number | undefined,
  actor: ActorContext,
): Promise<InventoryId[]> =>
  await withTransaction(db, async (tx) =>
    applyInventoryOwnershipInTransaction(
      tx,
      id,
      await resolveRawOwnership(tx, selection),
      quantity,
      actor,
    ),
  );

export const confirmInventoryOwnership = async (
  db: Database,
  id: InventoryId,
  expectedEvidenceFingerprint: string,
  quantity: number | undefined,
  actor: ActorContext,
): Promise<InventoryId[]> =>
  await withSerializableConfirmation(db, async (tx) => {
    const row = await tx.query.inventoryEntry.findFirst({
      where: and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)),
    });
    if (!row) {
      throw createAppError("INVENTORY_NOT_FOUND", "Inventory entry not found");
    }
    const effective = (await loadEffectiveInventoryOwnership(tx, [row])).get(
      id,
    );
    if (
      !effective ||
      effective.evidenceFingerprint !== expectedEvidenceFingerprint
    ) {
      throw createAppError(
        "INVENTORY_STALE",
        "Ownership evidence changed before confirmation. Refresh and review it again.",
      );
    }
    if (!effective.effectiveOwner) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "There is no individual owner to confirm.",
      );
    }
    const ownerId = await resolveOrThrow(
      tx,
      "ledgerParty",
      effective.effectiveOwner.id,
    );
    await assertValidIndividualOwner(tx, ownerId);
    return await applyInventoryOwnershipInTransaction(
      tx,
      id,
      {
        ownershipMode: "person",
        ownerLedgerPartyId: ownerId,
      },
      quantity,
      actor,
    );
  });

export const confirmInventoryExpenseBeneficiary = async (
  db: Database,
  inventoryId: InventoryId,
  expenseId: ExpenseId,
  expectedEvidenceFingerprint: string,
  actor: ActorContext,
) =>
  await withSerializableConfirmation(db, async (tx) => {
    const inventory = await tx.query.inventoryEntry.findFirst({
      where: and(
        eq(inventoryEntry.id, inventoryId),
        notDeleted(inventoryEntry),
      ),
    });
    if (!inventory) {
      throw createAppError("INVENTORY_NOT_FOUND", "Inventory entry not found");
    }
    const targetExpense = await tx.query.expense.findFirst({
      where: and(eq(expense.id, expenseId), notDeleted(expense)),
      columns: { productId: true },
    });
    if (!targetExpense) {
      throw createAppError("EXPENSE_NOT_FOUND", "Expense not found");
    }
    if (targetExpense.productId !== inventory.productId) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The selected expense must reference the inventory entry's product.",
      );
    }
    const effective = (
      await loadEffectiveInventoryOwnership(tx, [inventory])
    ).get(inventoryId);
    if (
      !effective ||
      effective.evidenceFingerprint !== expectedEvidenceFingerprint
    ) {
      throw createAppError(
        "INVENTORY_STALE",
        "Ownership evidence changed before confirmation. Refresh and review it again.",
      );
    }
    if (!effective.effectiveOwner) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "There is no individual inventory owner to record as the beneficiary.",
      );
    }
    const ownerId = await resolveOrThrow(
      tx,
      "ledgerParty",
      effective.effectiveOwner.id,
    );
    await assertValidIndividualOwner(tx, ownerId);

    const before = await getExpenseByID(tx, expenseId);
    const beneficiaries = [
      { partyId: effective.effectiveOwner.id, weight: 1 },
    ] as const;
    await replaceExpenseAttributionRole(
      tx,
      expenseId,
      "beneficiary",
      beneficiaries,
    );
    const after = await getExpenseByID(tx, expenseId);
    const changes = computeChanges(before, after, ["beneficiaries"]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "expense",
        entityId: expenseId,
        action: "update",
        changes,
      });
    }
    return { beneficiaries: [...beneficiaries] };
  });
