import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  ledgerTransfer,
  financialTransaction,
  financialTransactionAllocation,
  expense,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { jsonSnapshot } from "~/server/lib/canonical-json";

async function admitTransferLegs(
  db: Database,
  ids: readonly string[],
  actor: ActorContext,
) {
  if (!ids.length) return;
  const q = repositoryQueries(db);
  const rows = await q
    .select()
    .from(financialTransaction)
    .where(
      inArray(
        financialTransaction.id,
        ids.map((id) => parseEntityId("financialTransaction", id)),
      ),
    );
  if (rows.length !== new Set(ids).size || rows.some((row) => row.deletedAt))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Transfer evidence must name live bank events.",
    );
  const [slices, lines] = await Promise.all([
    q
      .select({ id: financialTransactionAllocation.id })
      .from(financialTransactionAllocation)
      .where(
        and(
          inArray(
            financialTransactionAllocation.transactionId,
            rows.map((row) => row.id),
          ),
          isNull(financialTransactionAllocation.deletedAt),
        ),
      ),
    q
      .select({ id: expense.id })
      .from(expense)
      .where(
        and(
          inArray(
            expense.bookingTransactionCode,
            rows.map((row) => row.shortcode),
          ),
          isNull(expense.deletedAt),
        ),
      ),
  ]);
  if (slices.length || lines.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Recorded spending must be reviewed before its bank event can evidence a transfer.",
    );
  const changed = rows.filter(
    (row) =>
      !["account_transfer", "credit_card_payment", "loan_payment"].includes(
        row.kind,
      ),
  );
  if (changed.length) {
    const { updateBankTransactions } =
      await import("~/server/domains/financial-transaction/repo/bank-mutations");
    await updateBankTransactions(
      db,
      changed.map((row) => ({
        id: row.id,
        values: { kind: "account_transfer" },
      })),
      actor,
    );
  }
}

export async function createTransferEvent(
  db: Database,
  values: Pick<
    typeof ledgerTransfer.$inferInsert,
    "fromPartyId" | "toPartyId" | "amount" | "date" | "notes"
  >,
  transactionIds: readonly string[],
  actor: ActorContext,
) {
  const { append, evidenceRow, householdWrite, reconcileNow } =
    await import("~/server/kernel/api");
  const { manualTransactionEvidence } =
    await import("~/server/domains/financial-transaction/repo/manual-evidence");
  return householdWrite(db, async (database) => {
    await admitTransferLegs(database, transactionIds, actor);
    const id = crypto.randomUUID();
    const key = `manual:${id}`;
    await append(database, [
      evidenceRow(manualTransactionEvidence, {
        id,
        entity: "ledgerTransfer",
        userId: actor.userId,
        payload: jsonSnapshot.parse({
          transferPair: key,
          values: {
            ...values,
            amount: values.amount.toString(),
            notes: values.notes ?? null,
          },
          transactionIds,
        }),
      }),
    ]);
    const outcomes = await reconcileNow(database, [
      { kind: "transferPair", key },
    ]);
    const [owner] = await repositoryQueries(database)
      .select()
      .from(recordKey)
      .where(
        and(
          eq(recordKey.entity, "ledgerTransfer"),
          eq(recordKey.scopeKind, "transferPair"),
          eq(recordKey.scopeKey, key),
        ),
      );
    if (!owner)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        outcomes[0]?.gaps[0]?.input ??
          outcomes[0]?.error ??
          "Transfer evidence cannot be booked.",
      );
    return owner.entityId;
  });
}

export async function updateTransferEvent(
  db: Database,
  id: string,
  values: Partial<typeof ledgerTransfer.$inferInsert>,
  transactions: readonly string[] | undefined,
  actor: ActorContext,
) {
  const { householdWrite, decide, reconcileNow, recordSubject } =
    await import("~/server/kernel/api");
  return householdWrite(db, async (database) => {
    const [owner] = await repositoryQueries(database)
      .select()
      .from(recordKey)
      .where(
        and(eq(recordKey.entity, "ledgerTransfer"), eq(recordKey.entityId, id)),
      );
    if (!owner)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Transfer has no reconciliation scope.",
      );
    if (transactions) await admitTransferLegs(database, transactions, actor);
    const scopes = [{ kind: owner.scopeKind, key: owner.scopeKey }];
    await decide(database, actor, [
      ...Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([field, value]) => ({
          channel: "assignment" as const,
          kind: value === null ? ("none" as const) : ("set" as const),
          subject: recordSubject("ledgerTransfer", id),
          field,
          value: jsonSnapshot.parse(
            typeof value === "bigint" ? value.toString() : value,
          ),
          scopes,
        })),
      ...(transactions === undefined
        ? []
        : [
            {
              channel: "assignment" as const,
              kind: "set" as const,
              subject: `transferPair:${owner.scopeKey}`,
              field: "transactions",
              value: [...transactions],
              scopes,
            },
          ]),
    ]);
    const outcomes = await reconcileNow(database, scopes);
    if (
      outcomes.some((outcome) => !["applied", "clean"].includes(outcome.status))
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        outcomes[0]?.gaps[0]?.input ??
          outcomes[0]?.error ??
          "Transfer evidence cannot be changed.",
      );
  });
}
