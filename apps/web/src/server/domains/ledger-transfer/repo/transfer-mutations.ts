import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  ledgerTransfer,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  expense,
} from "~/server/db/schema";
import { isTransferPairKind } from "~/server/domains/ledger-transfer/policy/transfer-kind";
import { createAppError } from "~/server/errors/app-error";
import { jsonSnapshot } from "~/server/lib/canonical-json";

async function admitTransferLegs(
  db: Database,
  ids: readonly string[],
  actor: ActorContext,
  transfer: Pick<
    typeof ledgerTransfer.$inferSelect,
    "fromPartyId" | "toPartyId" | "amount"
  >,
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
  const accounts = await q
    .select()
    .from(financialAccount)
    .where(
      inArray(
        financialAccount.id,
        rows.map((row) => row.accountId),
      ),
    );
  if (
    rows.some(
      (row) =>
        !["observed", "pending", "posted"].includes(row.status) ||
        (row.amount < 0n ? -row.amount : row.amount) !== transfer.amount,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Transfer evidence must have observed, pending, or posted status and match the transfer amount.",
    );
  if (
    rows.some((row) => {
      const account = accounts.find((value) => value.id === row.accountId);
      return (
        !account ||
        account.deletedAt ||
        account.ledgerPartyId !==
          (row.amount > 0n ? transfer.fromPartyId : transfer.toPartyId)
      );
    })
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Each evidence transaction account must map to its transfer endpoint party.",
    );
  if (rows.length === 2 && rows[0]!.amount > 0n === rows[1]!.amount > 0n)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Two-sided transfer evidence requires one positive and one negative transaction.",
    );
  if (rows.length === 2 && rows[0]!.accountId === rows[1]!.accountId)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Two-sided transfer evidence must use distinct financial accounts.",
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
      "Transfer evidence must be unallocated and have no live booked Expenses. Review recorded spending before using it as transfer evidence.",
    );
  const changed = rows.filter((row) => !isTransferPairKind(row.kind));
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
    await admitTransferLegs(database, transactionIds, actor, values);
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
    if (transactions) {
      const [current] = await repositoryQueries(database)
        .select()
        .from(ledgerTransfer)
        .where(eq(ledgerTransfer.id, parseEntityId("ledgerTransfer", id)));
      if (!current)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Transfer is no longer live.",
        );
      await admitTransferLegs(database, transactions, actor, {
        ...current,
        ...values,
      });
    }
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
