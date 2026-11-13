import type { ActorContext } from "@cubby/schemas/context";
import type { FinancialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { moneyToMinor } from "@cubby/shared";
import { inArray } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  financialAccount,
  financialTransaction,
  sourceOccurrence,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  append,
  householdWrite,
  decide,
  evidenceRow,
  reconcileNow,
  recordSubject,
  type DecisionInput,
} from "~/server/kernel/api";
import { jsonSnapshot } from "~/server/lib/canonical-json";

import { bankTransactionWrites } from "./bank-event";
import { manualTransactionEvidence } from "./manual-evidence";

type Create = {
  data: Omit<FinancialTransactionCreateInput, "accountId">;
  accountId: typeof financialAccount.$inferSelect.id;
};
type Change = {
  id: string;
  values: Partial<typeof financialTransaction.$inferInsert>;
};

/** All callers, including order intake, supply observations or decisions to bankEvent. */
export async function createBankTransactions(
  db: Database,
  inputs: readonly Create[],
  actor: ActorContext,
) {
  if (!inputs.length) return [];
  return householdWrite(db, async (db) => {
    const q = repositoryQueries(db);
    const [accounts, occurrences] = await Promise.all([
      q
        .select()
        .from(financialAccount)
        .where(
          inArray(
            financialAccount.id,
            inputs.map((item) => item.accountId),
          ),
        ),
      q
        .select()
        .from(sourceOccurrence)
        .where(
          inArray(
            sourceOccurrence.shortcode,
            inputs.flatMap((item) =>
              item.data.sourceRefs.map((ref) => ref.externalId),
            ),
          ),
        ),
    ]);
    const entries = inputs.map(({ data, accountId }) => {
      const account = accounts.find((row) => row.id === accountId);
      if (!account || account.deletedAt)
        throw createAppError(
          "REFERENCED_RECORD_MISSING",
          "The financial account is no longer live.",
        );
      const occurrence = occurrences.find((row) =>
        data.sourceRefs.some(
          (ref) =>
            ref.source === row.source && ref.externalId === row.shortcode,
        ),
      );
      const manualId = crypto.randomUUID();
      return {
        key: occurrence?.id ?? `manual:${manualId}`,
        manualId,
        account,
        occurrence,
        data,
      };
    });
    await append(
      db,
      entries.flatMap((entry) =>
        entry.occurrence
          ? []
          : [
              evidenceRow(manualTransactionEvidence, {
                id: entry.manualId,
                entity: "financialTransaction",
                userId: actor.userId,
                payload: jsonSnapshot.parse({
                  ...entry.data,
                  accountId: entry.account.shortcode,
                }),
              }),
            ],
      ),
    );
    const decisions: DecisionInput[] = entries.flatMap((entry) =>
      entry.occurrence
        ? Object.entries({
            accountId: entry.account.id,
            kind: entry.data.kind,
            status: entry.data.status,
            amount: moneyToMinor(entry.data.amount).toString(),
            transactionDate: entry.data.transactionDate,
            postedDate: entry.data.postedDate,
            merchant: entry.data.merchant,
            rawDescription: entry.data.rawDescription,
            sourceCategory: entry.data.sourceCategory,
            notes: entry.data.notes,
          })
            .filter(([, value]) => value !== undefined)
            .map(([field, value]) => ({
              channel: "assignment",
              kind: value === null ? "none" : "set",
              subject: `bank:${entry.key}`,
              field,
              value: jsonSnapshot.parse(value),
              scopes: [{ kind: "bankEvent", key: entry.key }],
            }))
        : [],
    );
    await decide(db, actor, decisions);
    const scopes = entries.map(({ key }) => ({ kind: "bankEvent", key }));
    const outcomes = await reconcileNow(db, scopes);
    const owned = await q
      .select()
      .from(recordKey)
      .where(
        inArray(
          recordKey.scopeKey,
          entries.map((entry) => entry.key),
        ),
      );
    const ids = entries.map(
      (entry) =>
        owned.find(
          (row) =>
            row.scopeKind === "bankEvent" &&
            row.scopeKey === entry.key &&
            row.entity === "financialTransaction",
        )?.entityId,
    );
    if (ids.some((id) => !id))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        outcomes
          .map(
            (outcome) =>
              outcome.error ?? outcome.gaps.map((gap) => gap.input).join("; "),
          )
          .join("; ") || "The bank event is waiting to reconcile.",
      );
    const saved = await q
      .select()
      .from(financialTransaction)
      .where(
        inArray(
          financialTransaction.id,
          ids.flatMap((id) =>
            id ? [parseEntityId("financialTransaction", id)] : [],
          ),
        ),
      );
    return ids.map((id) => saved.find((row) => row.id === id)!);
  });
}

/** Values are physical columns; exact minor units enter Decisions as strings. */
export async function updateBankTransactions(
  db: Database,
  changes: readonly Change[],
  actor: ActorContext,
): Promise<void> {
  if (!changes.length) return;
  return householdWrite(db, async (db) => {
    const q = repositoryQueries(db);
    const owners = await q
      .select()
      .from(recordKey)
      .where(
        inArray(
          recordKey.entityId,
          changes.map((change) => change.id),
        ),
      );
    const scopes = owners
      .filter(
        (owner) =>
          owner.scopeKind === "bankEvent" &&
          owner.entity === "financialTransaction",
      )
      .map((owner) => ({ kind: owner.scopeKind, key: owner.scopeKey }));
    if (
      changes.some(
        (change) =>
          !owners.some(
            (owner) =>
              owner.entity === "financialTransaction" &&
              owner.scopeKind === "bankEvent" &&
              owner.entityId === change.id,
          ),
      )
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The financial transaction has no bank-event ownership.",
      );
    await decide(
      db,
      actor,
      changes.flatMap((change) =>
        Object.entries(change.values)
          .filter(
            ([field, value]) =>
              value !== undefined &&
              bankTransactionWrites.columns.includes(field),
          )
          .map(([field, value]) => ({
            channel: "assignment",
            kind: value === null ? "none" : "set",
            subject: recordSubject("financialTransaction", change.id),
            field,
            value: jsonSnapshot.parse(
              typeof value === "bigint" ? value.toString() : value,
            ),
          })),
      ),
    );
    const outcomes = await reconcileNow(db, scopes);
    const failure = outcomes.find(
      (outcome) => outcome.status === "failed" || outcome.status === "conflict",
    );
    if (failure)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        failure.error ?? "The bank event changed while applying the decision.",
      );
  });
}
