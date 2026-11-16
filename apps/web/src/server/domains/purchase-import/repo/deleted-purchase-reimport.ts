import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { evidenceBinding, recordKey } from "~/server/db/kernel-schema";
import type {
  expense as expenseRow,
  sourceOrderObservation,
} from "~/server/db/retained-tables";
import { expense, purchase } from "~/server/db/schema";
import { orderBookingInput } from "~/server/domains/purchase-import/policy/order-booking";
import { orderEventKey } from "~/server/domains/purchase-import/policy/payment-keys";
import {
  recordIdentity,
  recordSubject,
  type DecisionInput,
} from "~/server/kernel/api";

type SavedExpense = typeof expenseRow.$inferSelect;
const preservedExpense = (row: SavedExpense): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).filter(
        ([field]) => field !== "purchaseId" && field !== "updatedAt",
      ),
    ),
    (_field, value) => (typeof value === "bigint" ? value.toString() : value),
  );

type Proof = {
  scopeKey: string;
  purchaseId: string;
  expenses: { id: SavedExpense["id"]; cost: bigint | null; snapshot: string }[];
};

/** Runs inside the import commit's member money gate; replaces only the rejected header. */
export async function prepareDeletedPurchaseReimport(
  db: Database,
  observations: readonly (typeof sourceOrderObservation.$inferSelect)[],
): Promise<{ decisions: DecisionInput[]; proofs: Proof[] }> {
  const decisions: DecisionInput[] = [];
  const proofs: Proof[] = [];
  if (!observations.length) return { decisions, proofs };
  const q = getDb(db);
  const bindings = await q
    .select()
    .from(evidenceBinding)
    .where(
      and(
        eq(evidenceBinding.factKind, "orderObservation"),
        inArray(
          evidenceBinding.factId,
          observations.map((row) => row.id),
        ),
      ),
    );
  const scopeOf = (binding: (typeof bindings)[number]) => {
    const key =
      binding.basis === "baseline" && binding.scopeKind === "purchaseEvent"
        ? binding.scopeKey
        : binding.eventKey;
    return key.startsWith("bank:") ? key.slice(5) : key;
  };
  const scopes = [
    ...new Set([...bindings.map(scopeOf), ...observations.map(orderEventKey)]),
  ];
  if (!scopes.length) return { decisions, proofs };
  const owners = await q
    .select({ key: recordKey, row: purchase })
    .from(recordKey)
    .innerJoin(purchase, eq(purchase.id, recordKey.entityId))
    .where(
      and(
        eq(recordKey.scopeKind, "purchaseEvent"),
        eq(recordKey.entity, "purchase"),
        inArray(recordKey.scopeKey, scopes),
        isNull(recordKey.mergedAt),
        isNotNull(purchase.deletedAt),
      ),
    );
  if (!owners.length) return { decisions, proofs };
  const items = await q
    .select({ key: recordKey, row: expense })
    .from(recordKey)
    .innerJoin(expense, eq(expense.id, recordKey.entityId))
    .where(
      and(
        eq(recordKey.scopeKind, "purchaseEvent"),
        eq(recordKey.entity, "expense"),
        inArray(
          recordKey.scopeKey,
          owners.map(({ key }) => key.scopeKey),
        ),
        isNull(recordKey.rejectedAt),
        isNull(recordKey.mergedAt),
        notDeleted(expense),
      ),
    );
  for (const observation of observations) {
    const bound = [
      ...new Set(
        bindings.filter((row) => row.factId === observation.id).map(scopeOf),
      ),
    ];
    const scopeKey =
      bound.length === 1 ? bound[0]! : orderEventKey(observation);
    if (proofs.some((row) => row.scopeKey === scopeKey)) continue;
    const owner = owners
      .filter(({ key }) => key.scopeKey === scopeKey)
      .sort((a, b) => b.key.createdAt.getTime() - a.key.createdAt.getTime())[0];
    if (!owner) continue;
    const scope = { kind: "purchaseEvent", key: scopeKey };
    decisions.push({
      channel: "rejection",
      kind: "reject",
      subject: recordSubject("purchase", owner.row.id),
      scopes: [scope],
    });
    decisions.push({
      channel: "assignment",
      kind: "set",
      subject: `purchaseEvent:${scopeKey}`,
      field: "reimport",
      value: { priorPurchaseId: owner.row.id, observationId: observation.id },
      scopes: [scope],
    });
    if (bound.length !== 1 || bound[0] !== scopeKey) continue;
    const booking = orderBookingInput(observation, {
      purchaseDate: owner.row.date,
      receivedAt: null,
    });
    if (!booking.policy.writesLines || booking.refund) continue;
    const rows = items.filter(({ key }) => key.scopeKey === scopeKey);
    const matched = booking.lines.map((line) =>
      rows.find(
        ({ key }) =>
          key.naturalKey ===
          `line:${line.binding?.stableLineId ?? line.lineIndex}`,
      ),
    );
    // Missing, independently owned, rejected, moved or surplus item identities
    // need review; an amount/name match cannot authorize replacement spending.
    if (
      matched.some(
        (item) => !item || !item.key.minted || item.row.purchaseId !== null,
      ) ||
      new Set(matched.map((item) => item?.row.id)).size !==
        booking.lines.length ||
      rows.length !== booking.lines.length
    )
      continue;
    const naturalKey = `reimport:${owner.row.id}`;
    const purchaseId = recordIdentity(scope, "Purchase", naturalKey);
    decisions.push({
      channel: "assignment",
      kind: "set",
      subject: `purchaseEvent:${scopeKey}`,
      field: "record:Purchase:purchase",
      value: { table: "Purchase", naturalKey, values: {} },
      scopes: [scope],
    });
    const saved: Proof["expenses"] = [];
    for (const [index, item] of matched.entries()) {
      if (!item) throw new Error("Proven source item disappeared");
      const line = booking.lines[index]!;
      decisions.push(
        {
          channel: "assignment",
          kind: "set",
          subject: `purchaseEvent:${scopeKey}`,
          field: `line-record:${line.binding?.stableLineId ?? line.lineIndex}`,
          value: item.row.id,
          scopes: [scope],
        },
        {
          channel: "assignment",
          kind: "set",
          subject: recordSubject("expense", item.row.id),
          field: "purchaseId",
          value: purchaseId,
          scopes: [scope],
        },
      );
      saved.push({
        id: item.row.id,
        cost: item.row.cost,
        snapshot: preservedExpense(item.row),
      });
    }
    proofs.push({ scopeKey, purchaseId, expenses: saved });
  }
  return { decisions, proofs };
}

/** Refuse publication unless the replacement retained every proven Expense and cent. */
export async function verifyDeletedPurchaseReimport(
  db: Database,
  proofs: readonly Proof[],
): Promise<void> {
  if (!proofs.length) return;
  const q = getDb(db);
  const rows = await q
    .select()
    .from(expense)
    .where(
      inArray(
        expense.id,
        proofs.flatMap((proof) => proof.expenses.map((item) => item.id)),
      ),
    );
  const owners = await q
    .select()
    .from(recordKey)
    .where(
      and(
        eq(recordKey.scopeKind, "purchaseEvent"),
        eq(recordKey.entity, "expense"),
        inArray(
          recordKey.scopeKey,
          proofs.map((proof) => proof.scopeKey),
        ),
        isNull(recordKey.rejectedAt),
        isNull(recordKey.mergedAt),
      ),
    );
  for (const proof of proofs) {
    if (
      owners.filter((row) => row.scopeKey === proof.scopeKey).length !==
        proof.expenses.length ||
      proof.expenses.some(
        (item) =>
          !rows.some(
            (row) =>
              row.id === item.id &&
              row.cost === item.cost &&
              preservedExpense(row) === item.snapshot &&
              row.purchaseId === proof.purchaseId &&
              row.deletedAt === null,
          ),
      )
    )
      throw new Error(
        "Reimport must preserve the proven Expense identities and spending",
      );
  }
}
