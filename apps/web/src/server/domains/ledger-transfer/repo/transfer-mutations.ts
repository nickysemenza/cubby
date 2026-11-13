import type { ActorContext } from "@cubby/schemas/context";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { ledgerTransfer } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { jsonSnapshot } from "~/server/lib/canonical-json";

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
      outcomes.some((outcome) =>
        ["drift", "failed", "conflict"].includes(outcome.status),
      )
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        outcomes[0]?.gaps[0]?.input ??
          outcomes[0]?.error ??
          "Transfer evidence cannot be changed.",
      );
  });
}
