import type { ActorContext } from "@cubby/schemas/context";
import type {
  HouseholdLedgerChange,
  WeightedBeneficiaries,
  WeightedFunders,
} from "@cubby/schemas/household-contribution";
import {
  type FundingSourceId,
  type FundingTransferId,
  type FundingTransferShortcode,
  unsafeFundingTransferId,
  unsafeFundingTransferShortcode,
} from "@cubby/schemas/identifiers";
import { NON_ENTITY_SHORTCODE_PREFIX, SHORTCODE_CHARS } from "@cubby/shared";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  expenseAttribution,
  expenseSourceRef,
  financialAccount,
  financialAccountPerson,
  financialTransaction,
  fundingSource,
  fundingTransfer,
  fundingTransferEvidence,
  fundingTransferSourceRef,
  type person,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries, logAuditEntry } from "~/server/repo/audit-log";
import {
  notDeleted,
  unwrapDb,
  withTransactionOn,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { assertFinancialTransactionFundingEvidenceValid } from "./integrity";
import { lockFundingEvidenceMutationTargets } from "./locks";
import { resolveFundingPartyOrThrow } from "./party";

type SetExpenseAttributionChange = Extract<
  HouseholdLedgerChange,
  { type: "set_expense_attribution" }
>;
export type ClaimExpenseSourceChange = Extract<
  HouseholdLedgerChange,
  { type: "claim_expense_source" }
>;
type UpsertFundChange = Extract<
  HouseholdLedgerChange,
  { type: "upsert_funding_fund" }
>;
type SetAccountFundingChange = Extract<
  HouseholdLedgerChange,
  { type: "set_account_funding" }
>;
export type PutFundingTransferChange = Extract<
  HouseholdLedgerChange,
  { type: "put_funding_transfer" }
>;

export type HouseholdMutationResult = {
  changed: number;
  transferIds: FundingTransferShortcode[];
};

const toCents = (amount: number): bigint => BigInt(Math.round(amount * 100));

export function validateExpenseSourceClaim(
  expenseCost: number | null | undefined,
  change: ClaimExpenseSourceChange,
): { expenseCost: number; reconciliationNote: string | null } {
  if (expenseCost === null || expenseCost === undefined) {
    throw createAppError(
      "HOUSEHOLD_LEDGER_INVALID_ATTRIBUTION",
      "An Expense must have a priced cost before an external source row can be claimed",
    );
  }
  const amountsMatch = toCents(expenseCost) === toCents(change.sourceAmount);
  if (amountsMatch !== (change.reconciliation.decision === "amounts_match")) {
    throw createAppError(
      "HOUSEHOLD_LEDGER_INVALID_ATTRIBUTION",
      amountsMatch
        ? "Matching source and Expense amounts require the amounts_match decision"
        : "A source/Expense amount mismatch requires an explicit accept_existing_expense decision with a note",
    );
  }
  return {
    expenseCost,
    reconciliationNote:
      change.reconciliation.decision === "accept_existing_expense"
        ? change.reconciliation.note
        : null,
  };
}

function randomFundingTransferShortcode(): FundingTransferShortcode {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const body = [...bytes]
    .map((byte) => SHORTCODE_CHARS[byte % SHORTCODE_CHARS.length])
    .join("");
  return unsafeFundingTransferShortcode(
    `${NON_ENTITY_SHORTCODE_PREFIX.fundingTransfer}${body}`,
  );
}

async function mintFundingTransferShortcode(
  tx: DrizzleTransaction,
): Promise<FundingTransferShortcode> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const shortcode = randomFundingTransferShortcode();
    const [taken] = await tx
      .select({ id: fundingTransfer.id })
      .from(fundingTransfer)
      .where(eq(fundingTransfer.shortcode, shortcode))
      .limit(1);
    if (!taken) return shortcode;
  }
  throw new Error("Could not mint a unique FundingTransfer shortcode");
}

export async function findFundingTransferByShortcode(
  db: Database | DrizzleTransaction,
  shortcode: FundingTransferShortcode,
): Promise<{
  id: FundingTransferId;
  shortcode: FundingTransferShortcode;
  deletedAt: Date | null;
} | null> {
  const [row] = await unwrapDb(db)
    .select({
      id: fundingTransfer.id,
      shortcode: fundingTransfer.shortcode,
      deletedAt: fundingTransfer.deletedAt,
    })
    .from(fundingTransfer)
    .where(eq(fundingTransfer.shortcode, shortcode))
    .limit(1);
  return row ?? null;
}

async function desiredBeneficiaries(
  tx: DrizzleTransaction,
  value: WeightedBeneficiaries | null,
) {
  if (value === null) return [];
  const people: Array<{
    personId: typeof person.$inferSelect.id;
    fundingSourceId: null;
    weight: number;
  }> = [];
  for (const row of value.people) {
    people.push({
      personId: await resolveOrThrow(tx, "person", row.personId),
      fundingSourceId: null,
      weight: row.weight,
    });
  }
  return [
    ...people,
    ...(value.unattributedWeight
      ? [
          {
            personId: null,
            fundingSourceId: null,
            weight: value.unattributedWeight,
          },
        ]
      : []),
  ];
}

async function desiredFunders(
  tx: DrizzleTransaction,
  value: WeightedFunders | null,
) {
  if (value === null) return [];
  const parties: Array<{
    personId: null;
    fundingSourceId: FundingSourceId;
    weight: number;
  }> = [];
  for (const row of value.parties) {
    parties.push({
      personId: null,
      fundingSourceId: (await resolveFundingPartyOrThrow(tx, row.party))
        .sourceId,
      weight: row.weight,
    });
  }
  return [
    ...parties,
    ...(value.unattributedWeight
      ? [
          {
            personId: null,
            fundingSourceId: null,
            weight: value.unattributedWeight,
          },
        ]
      : []),
  ];
}

const attributionKey = (row: {
  personId: string | null;
  fundingSourceId: string | null;
  weight: number;
}) => `${row.personId ?? ""}:${row.fundingSourceId ?? ""}:${row.weight}`;

async function replaceAttributionRole(
  tx: DrizzleTransaction,
  expenseId: typeof expense.$inferSelect.id,
  role: "beneficiary" | "funder",
  desired: Array<{
    personId: typeof person.$inferSelect.id | null;
    fundingSourceId: FundingSourceId | null;
    weight: number;
  }>,
): Promise<boolean> {
  const existing = await tx
    .select({
      personId: expenseAttribution.personId,
      fundingSourceId: expenseAttribution.fundingSourceId,
      weight: expenseAttribution.weight,
    })
    .from(expenseAttribution)
    .where(
      and(
        eq(expenseAttribution.expenseId, expenseId),
        eq(expenseAttribution.role, role),
        notDeleted(expenseAttribution),
      ),
    );
  const before = existing.map(attributionKey).sort();
  const after = desired.map(attributionKey).sort();
  if (JSON.stringify(before) === JSON.stringify(after)) return false;

  await tx
    .update(expenseAttribution)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(expenseAttribution.expenseId, expenseId),
        eq(expenseAttribution.role, role),
        notDeleted(expenseAttribution),
      ),
    );
  if (desired.length > 0) {
    await tx.insert(expenseAttribution).values(
      desired.map((row) => ({
        expenseId,
        role,
        personId: row.personId,
        fundingSourceId: row.fundingSourceId,
        weight: row.weight,
      })),
    );
  }
  return true;
}

export async function setExpenseAttribution(
  db: Database | DrizzleTransaction,
  change: SetExpenseAttributionChange,
  actor: ActorContext,
): Promise<HouseholdMutationResult> {
  return withTransactionOn(db, async (tx) => {
    const expenseIds: Array<typeof expense.$inferSelect.id> = [];
    for (const code of change.expenseIds) {
      expenseIds.push(await resolveOrThrow(tx, "expense", code));
    }
    await tx.execute(sql`
      SELECT id FROM ${expense}
      WHERE ${inArray(expense.id, expenseIds)}
      ORDER BY id FOR UPDATE
    `);
    const beneficiaries =
      change.beneficiaries === undefined
        ? undefined
        : await desiredBeneficiaries(tx, change.beneficiaries);
    const funders =
      change.funders === undefined
        ? undefined
        : await desiredFunders(tx, change.funders);
    const changedExpenseIds: typeof expenseIds = [];
    for (const expenseId of expenseIds) {
      let changed = false;
      if (beneficiaries !== undefined) {
        changed =
          (await replaceAttributionRole(
            tx,
            expenseId,
            "beneficiary",
            beneficiaries,
          )) || changed;
      }
      if (funders !== undefined) {
        changed =
          (await replaceAttributionRole(tx, expenseId, "funder", funders)) ||
          changed;
      }
      if (changed) changedExpenseIds.push(expenseId);
    }
    await logAuditEntries(
      tx,
      actor,
      changedExpenseIds.map((entityId) => ({
        entityType: "expense" as const,
        entityId,
        action: "update" as const,
        changes: {
          contributionAttribution: {
            from: "previous",
            to: "replaced",
          },
        },
      })),
    );
    return { changed: changedExpenseIds.length, transferIds: [] };
  });
}

export async function claimExpenseSource(
  db: Database | DrizzleTransaction,
  change: ClaimExpenseSourceChange,
  actor: ActorContext,
): Promise<HouseholdMutationResult> {
  return withTransactionOn(db, async (tx) => {
    const expenseId = await resolveOrThrow(tx, "expense", change.expenseId);
    const [expenseRow] = await tx
      .select({ cost: expense.cost })
      .from(expense)
      .where(and(eq(expense.id, expenseId), notDeleted(expense)))
      .for("update")
      .limit(1);
    const { expenseCost, reconciliationNote } = validateExpenseSourceClaim(
      expenseRow?.cost,
      change,
    );
    await lockTransferKeys(tx, [
      `expense-ref:${change.sourceRef.source}:${change.sourceRef.externalId}`,
    ]);
    const [existing] = await tx
      .select({
        id: expenseSourceRef.id,
        expenseId: expenseSourceRef.expenseId,
        sourceAmount: expenseSourceRef.sourceAmount,
        expenseAmountAtClaim: expenseSourceRef.expenseAmountAtClaim,
        reconciliationDecision: expenseSourceRef.reconciliationDecision,
        reconciliationNote: expenseSourceRef.reconciliationNote,
        deletedAt: expenseSourceRef.deletedAt,
      })
      .from(expenseSourceRef)
      .where(
        and(
          eq(expenseSourceRef.source, change.sourceRef.source),
          eq(expenseSourceRef.externalId, change.sourceRef.externalId),
        ),
      )
      .limit(1);
    if (existing?.expenseId === expenseId) {
      const sameDecision =
        toCents(existing.sourceAmount) === toCents(change.sourceAmount) &&
        toCents(existing.expenseAmountAtClaim) === toCents(expenseCost) &&
        existing.reconciliationDecision === change.reconciliation.decision &&
        existing.reconciliationNote === reconciliationNote;
      if (!sameDecision) {
        throw createAppError(
          "HOUSEHOLD_LEDGER_EVIDENCE_CONFLICT",
          "This Expense source identity already has a different reconciliation decision",
        );
      }
      if (existing.deletedAt === null) {
        return { changed: 0, transferIds: [] };
      }
      await tx
        .update(expenseSourceRef)
        .set({ deletedAt: null })
        .where(eq(expenseSourceRef.id, existing.id));
      await logAuditEntry(tx, actor, {
        entityType: "expense",
        entityId: expenseId,
        action: "update",
        changes: {
          sourceRef: {
            from: "retired",
            to: {
              ...change.sourceRef,
              sourceAmount: change.sourceAmount,
              reconciliation: change.reconciliation,
            },
          },
        },
      });
      return { changed: 1, transferIds: [] };
    }
    if (existing) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_EVIDENCE_CONFLICT",
        `Expense source reference ${change.sourceRef.source}/${change.sourceRef.externalId} is permanently claimed by another Expense`,
      );
    }
    await tx.insert(expenseSourceRef).values({
      expenseId,
      ...change.sourceRef,
      sourceAmount: change.sourceAmount,
      expenseAmountAtClaim: expenseCost,
      reconciliationDecision: change.reconciliation.decision,
      reconciliationNote,
    });
    await logAuditEntry(tx, actor, {
      entityType: "expense",
      entityId: expenseId,
      action: "update",
      changes: {
        sourceRef: {
          from: null,
          to: {
            ...change.sourceRef,
            sourceAmount: change.sourceAmount,
            reconciliation: change.reconciliation,
          },
        },
      },
    });
    return { changed: 1, transferIds: [] };
  });
}

/** Lifecycle hook for the owning Expense delete path. */
export async function softDeleteExpenseSourceRefs(
  tx: DrizzleTransaction,
  expenseIds: readonly (typeof expense.$inferSelect.id)[],
): Promise<number> {
  if (expenseIds.length === 0) return 0;
  const removed = await tx
    .update(expenseSourceRef)
    .set({ deletedAt: new Date() })
    .where(
      and(
        inArray(expenseSourceRef.expenseId, [...expenseIds]),
        notDeleted(expenseSourceRef),
      ),
    )
    .returning({ id: expenseSourceRef.id });
  return removed.length;
}

export async function upsertFundingFund(
  db: Database | DrizzleTransaction,
  change: UpsertFundChange,
): Promise<HouseholdMutationResult> {
  return withTransactionOn(db, async (tx) => {
    const [existing] = await tx
      .select()
      .from(fundingSource)
      .where(
        and(
          eq(fundingSource.kind, "shared_fund"),
          eq(fundingSource.fundKey, change.key),
          notDeleted(fundingSource),
        ),
      )
      .limit(1);
    if (existing) {
      const notes = change.notes === undefined ? existing.notes : change.notes;
      if (existing.name === change.name && existing.notes === notes) {
        return { changed: 0, transferIds: [] };
      }
      await tx
        .update(fundingSource)
        .set({ name: change.name, notes })
        .where(eq(fundingSource.id, existing.id));
    } else {
      await tx.insert(fundingSource).values({
        kind: "shared_fund",
        fundKey: change.key,
        name: change.name,
        notes: change.notes,
      });
    }
    return { changed: 1, transferIds: [] };
  });
}

export async function setAccountFunding(
  db: Database | DrizzleTransaction,
  change: SetAccountFundingChange,
  actor: ActorContext,
): Promise<HouseholdMutationResult> {
  return withTransactionOn(db, async (tx) => {
    const accountId = await resolveOrThrow(
      tx,
      "financialAccount",
      change.accountId,
    );
    await lockFundingEvidenceMutationTargets(tx, { accountIds: [accountId] });
    const fundingSourceId = change.fundingParty
      ? (await resolveFundingPartyOrThrow(tx, change.fundingParty)).sourceId
      : null;
    const people: Array<{
      personId: typeof person.$inferSelect.id;
      role: (typeof change.people)[number]["role"];
    }> = [];
    for (const row of change.people) {
      people.push({
        personId: await resolveOrThrow(tx, "person", row.personId),
        role: row.role,
      });
    }
    const [before] = await tx
      .select({ fundingSourceId: financialAccount.fundingSourceId })
      .from(financialAccount)
      .where(
        and(eq(financialAccount.id, accountId), notDeleted(financialAccount)),
      )
      .limit(1);
    const beforePeople = await tx
      .select({
        personId: financialAccountPerson.personId,
        role: financialAccountPerson.role,
      })
      .from(financialAccountPerson)
      .where(
        and(
          eq(financialAccountPerson.accountId, accountId),
          notDeleted(financialAccountPerson),
        ),
      );
    const oldShape = JSON.stringify({
      fundingSourceId: before?.fundingSourceId ?? null,
      people: beforePeople.map((row) => `${row.personId}:${row.role}`).sort(),
    });
    const newShape = JSON.stringify({
      fundingSourceId,
      people: people.map((row) => `${row.personId}:${row.role}`).sort(),
    });
    if (oldShape === newShape) return { changed: 0, transferIds: [] };

    await tx
      .update(financialAccount)
      .set({ fundingSourceId })
      .where(eq(financialAccount.id, accountId));
    const evidencedTransactions = await tx
      .selectDistinct({ id: financialTransaction.id })
      .from(financialTransaction)
      .innerJoin(
        fundingTransferEvidence,
        and(
          eq(fundingTransferEvidence.transactionId, financialTransaction.id),
          notDeleted(fundingTransferEvidence),
        ),
      )
      .where(
        and(
          eq(financialTransaction.accountId, accountId),
          notDeleted(financialTransaction),
        ),
      );
    for (const row of evidencedTransactions) {
      await assertFinancialTransactionFundingEvidenceValid(tx, row.id);
    }
    await tx
      .update(financialAccountPerson)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(financialAccountPerson.accountId, accountId),
          notDeleted(financialAccountPerson),
        ),
      );
    if (people.length > 0) {
      await tx
        .insert(financialAccountPerson)
        .values(people.map((row) => ({ accountId, ...row })));
    }
    await logAuditEntry(tx, actor, {
      entityType: "financialAccount",
      entityId: accountId,
      action: "update",
      changes: {
        householdFunding: { from: oldShape, to: newShape },
      },
    });
    return { changed: 1, transferIds: [] };
  });
}

async function lockTransferKeys(
  tx: DrizzleTransaction,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`household-transfer:${key}`}, 0))`,
    );
  }
}

export async function validateFundingTransferEvidence(
  db: Database | DrizzleTransaction,
  change: PutFundingTransferChange,
  fromSourceId: FundingSourceId,
  toSourceId: FundingSourceId,
) {
  const client = unwrapDb(db);
  const result = [] as Array<{
    transactionId: typeof financialTransaction.$inferSelect.id;
    side: "outflow" | "inflow";
  }>;
  const accountIds = new Set<string>();
  for (const evidence of change.evidence) {
    const transactionId = await resolveOrThrow(
      db,
      "financialTransaction",
      evidence.transactionId,
    );
    const [row] = await client
      .select({
        status: financialTransaction.status,
        amount: financialTransaction.amount,
        accountId: financialTransaction.accountId,
        fundingSourceId: financialAccount.fundingSourceId,
      })
      .from(financialTransaction)
      .innerJoin(
        financialAccount,
        eq(financialTransaction.accountId, financialAccount.id),
      )
      .where(
        and(
          eq(financialTransaction.id, transactionId),
          notDeleted(financialTransaction),
          notDeleted(financialAccount),
        ),
      )
      .limit(1);
    if (!row) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_INVALID_TRANSFER",
        `Evidence ${evidence.transactionId} is missing its live transaction or account`,
      );
    }
    const endpoint = evidence.side === "outflow" ? fromSourceId : toSourceId;
    const signMatches =
      evidence.side === "outflow" ? row.amount > 0 : row.amount < 0;
    if (
      row.status !== "posted" ||
      !signMatches ||
      toCents(Math.abs(row.amount)) !== toCents(change.amount) ||
      row.fundingSourceId !== endpoint
    ) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_INVALID_TRANSFER",
        `Evidence ${evidence.transactionId} does not prove the ${evidence.side} endpoint and amount`,
      );
    }
    accountIds.add(row.accountId);
    result.push({ transactionId, side: evidence.side });
  }
  if (result.length === 2 && accountIds.size !== 2) {
    throw createAppError(
      "HOUSEHOLD_LEDGER_INVALID_TRANSFER",
      "Two-sided transfer evidence must use two distinct financial accounts",
    );
  }
  return result;
}

export async function putFundingTransfer(
  db: Database | DrizzleTransaction,
  change: PutFundingTransferChange,
): Promise<HouseholdMutationResult> {
  return withTransactionOn(db, async (tx) => {
    const from = await resolveFundingPartyOrThrow(tx, change.from);
    const to = await resolveFundingPartyOrThrow(tx, change.to);
    const sameParty = from.sourceId === to.sourceId;
    if (sameParty !== (change.kind === "internal_account_move")) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_INVALID_TRANSFER",
        "Only internal account moves may have the same funding party at both endpoints",
      );
    }
    if (
      change.kind === "fund_contribution" &&
      !(from.party.kind === "person" && to.party.kind === "shared_fund")
    ) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_INVALID_TRANSFER",
        "Fund contributions must move from a person to a shared fund",
      );
    }

    const existingTransfer = change.transferId
      ? await findFundingTransferByShortcode(tx, change.transferId)
      : null;
    if (change.transferId && !existingTransfer) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_INVALID_TRANSFER",
        `Funding transfer not found: ${change.transferId}`,
      );
    }
    const transferId =
      existingTransfer?.id ?? unsafeFundingTransferId(crypto.randomUUID());
    let transferShortcode =
      existingTransfer?.shortcode ?? (await mintFundingTransferShortcode(tx));
    const evidenceTransactionIds = [] as Array<
      typeof financialTransaction.$inferSelect.id
    >;
    for (const row of change.evidence) {
      evidenceTransactionIds.push(
        await resolveOrThrow(tx, "financialTransaction", row.transactionId),
      );
    }
    await lockFundingEvidenceMutationTargets(tx, {
      transactionIds: evidenceTransactionIds,
    });
    if (evidenceTransactionIds.length > 0) {
      const evidenceAccounts = await tx
        .selectDistinct({ accountId: financialTransaction.accountId })
        .from(financialTransaction)
        .where(
          and(
            inArray(financialTransaction.id, evidenceTransactionIds),
            notDeleted(financialTransaction),
          ),
        );
      await lockFundingEvidenceMutationTargets(tx, {
        accountIds: evidenceAccounts.map((row) => row.accountId),
      });
    }
    const keys = [
      `transfer:${transferId}`,
      ...change.sourceRefs.map((row) => `ref:${row.source}:${row.externalId}`),
    ];
    await lockTransferKeys(tx, keys);
    const evidence = await validateFundingTransferEvidence(
      tx,
      change,
      from.sourceId,
      to.sourceId,
    );

    for (const ref of change.sourceRefs) {
      const [conflict] = await tx
        .select({ transferId: fundingTransferSourceRef.transferId })
        .from(fundingTransferSourceRef)
        .where(
          and(
            eq(fundingTransferSourceRef.source, ref.source),
            eq(fundingTransferSourceRef.externalId, ref.externalId),
            ne(fundingTransferSourceRef.transferId, transferId),
          ),
        )
        .limit(1);
      if (conflict) {
        throw createAppError(
          "HOUSEHOLD_LEDGER_EVIDENCE_CONFLICT",
          `Transfer source reference ${ref.source}/${ref.externalId} is already recorded`,
        );
      }
    }
    for (const row of evidence) {
      const [conflict] = await tx
        .select({ transferId: fundingTransferEvidence.transferId })
        .from(fundingTransferEvidence)
        .where(
          and(
            eq(fundingTransferEvidence.transactionId, row.transactionId),
            ne(fundingTransferEvidence.transferId, transferId),
            notDeleted(fundingTransferEvidence),
          ),
        )
        .limit(1);
      if (conflict) {
        throw createAppError(
          "HOUSEHOLD_LEDGER_EVIDENCE_CONFLICT",
          "A financial transaction may prove only one funding transfer",
        );
      }
    }

    const [existing] = await tx
      .select({ id: fundingTransfer.id, deletedAt: fundingTransfer.deletedAt })
      .from(fundingTransfer)
      .where(eq(fundingTransfer.id, transferId))
      .limit(1);
    const transferValues = {
      fromSourceId: from.sourceId,
      toSourceId: to.sourceId,
      kind: change.kind,
      amount: change.amount,
      date: change.date,
      notes: change.notes,
      deletedAt: null,
    };
    if (existing) {
      await tx
        .update(fundingTransfer)
        .set(transferValues)
        .where(eq(fundingTransfer.id, transferId));
    } else {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await tx.transaction(async (savepoint) => {
            await savepoint.insert(fundingTransfer).values({
              id: transferId,
              shortcode: transferShortcode,
              ...transferValues,
            });
          });
          break;
        } catch (error) {
          let cause: unknown = error;
          let shortcodeCollision = false;
          while (cause && typeof cause === "object") {
            const row = cause as {
              code?: unknown;
              constraint?: unknown;
              cause?: unknown;
            };
            if (
              row.code === "23505" &&
              row.constraint === "FundingTransfer_shortcode_unique"
            ) {
              shortcodeCollision = true;
              break;
            }
            cause = row.cause;
          }
          if (!shortcodeCollision || attempt >= 9) throw error;
          transferShortcode = await mintFundingTransferShortcode(tx);
        }
      }
    }
    await tx
      .update(fundingTransferSourceRef)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(fundingTransferSourceRef.transferId, transferId),
          notDeleted(fundingTransferSourceRef),
        ),
      );
    await tx
      .update(fundingTransferEvidence)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(fundingTransferEvidence.transferId, transferId),
          notDeleted(fundingTransferEvidence),
        ),
      );
    if (change.sourceRefs.length > 0) {
      for (const ref of change.sourceRefs) {
        const revived = await tx
          .update(fundingTransferSourceRef)
          .set({ deletedAt: null })
          .where(
            and(
              eq(fundingTransferSourceRef.transferId, transferId),
              eq(fundingTransferSourceRef.source, ref.source),
              eq(fundingTransferSourceRef.externalId, ref.externalId),
            ),
          )
          .returning({ id: fundingTransferSourceRef.id });
        if (revived.length === 0) {
          await tx
            .insert(fundingTransferSourceRef)
            .values({ transferId, ...ref });
        }
      }
    }
    if (evidence.length > 0) {
      await tx
        .insert(fundingTransferEvidence)
        .values(evidence.map((row) => ({ transferId, ...row })));
    }
    return { changed: 1, transferIds: [transferShortcode] };
  });
}

export async function deleteFundingTransfer(
  db: Database | DrizzleTransaction,
  transferShortcode: FundingTransferShortcode,
): Promise<HouseholdMutationResult> {
  return withTransactionOn(db, async (tx) => {
    const transfer = await findFundingTransferByShortcode(
      tx,
      transferShortcode,
    );
    if (!transfer || transfer.deletedAt) {
      return { changed: 0, transferIds: [] };
    }
    const transferId = transfer.id;
    const now = new Date();
    const removed = await tx
      .update(fundingTransfer)
      .set({ deletedAt: now })
      .where(
        and(eq(fundingTransfer.id, transferId), notDeleted(fundingTransfer)),
      )
      .returning({ id: fundingTransfer.id });
    if (removed.length === 0) return { changed: 0, transferIds: [] };
    await tx
      .update(fundingTransferSourceRef)
      .set({ deletedAt: now })
      .where(
        and(
          eq(fundingTransferSourceRef.transferId, transferId),
          notDeleted(fundingTransferSourceRef),
        ),
      );
    await tx
      .update(fundingTransferEvidence)
      .set({ deletedAt: now })
      .where(
        and(
          eq(fundingTransferEvidence.transferId, transferId),
          notDeleted(fundingTransferEvidence),
        ),
      );
    return { changed: 1, transferIds: [transferShortcode] };
  });
}

export async function applyHouseholdLedgerChange(
  db: Database | DrizzleTransaction,
  change: HouseholdLedgerChange,
  actor: ActorContext,
): Promise<HouseholdMutationResult> {
  switch (change.type) {
    case "set_expense_attribution":
      return setExpenseAttribution(db, change, actor);
    case "claim_expense_source":
      return claimExpenseSource(db, change, actor);
    case "upsert_funding_fund":
      return upsertFundingFund(db, change);
    case "set_account_funding":
      return setAccountFunding(db, change, actor);
    case "put_funding_transfer":
      return putFundingTransfer(db, change);
    case "delete_funding_transfer":
      return deleteFundingTransfer(db, change.transferId);
  }
}

export async function foldPersonFundingSourceForMerge(
  tx: DrizzleTransaction,
  input: {
    keeperSourceId: FundingSourceId;
    loserSourceId: FundingSourceId;
  },
): Promise<{
  fundingEdgesRepointed: number;
  transferEdgesRepointed: number;
}> {
  if (input.keeperSourceId === input.loserSourceId) {
    return { fundingEdgesRepointed: 0, transferEdgesRepointed: 0 };
  }
  const loserRows = await tx
    .select()
    .from(expenseAttribution)
    .where(
      and(
        eq(expenseAttribution.fundingSourceId, input.loserSourceId),
        notDeleted(expenseAttribution),
      ),
    );
  let fundingEdgesRepointed = 0;
  for (const loserRow of loserRows) {
    const [keeperRow] = await tx
      .select()
      .from(expenseAttribution)
      .where(
        and(
          eq(expenseAttribution.expenseId, loserRow.expenseId),
          eq(expenseAttribution.role, "funder"),
          eq(expenseAttribution.fundingSourceId, input.keeperSourceId),
          notDeleted(expenseAttribution),
        ),
      )
      .limit(1);
    if (keeperRow) {
      await tx
        .update(expenseAttribution)
        .set({ weight: keeperRow.weight + loserRow.weight })
        .where(eq(expenseAttribution.id, keeperRow.id));
      await tx
        .update(expenseAttribution)
        .set({ deletedAt: new Date() })
        .where(eq(expenseAttribution.id, loserRow.id));
    } else {
      await tx
        .update(expenseAttribution)
        .set({ fundingSourceId: input.keeperSourceId })
        .where(eq(expenseAttribution.id, loserRow.id));
    }
    fundingEdgesRepointed += 1;
  }
  const accountsToMove = await tx
    .select({ id: financialAccount.id })
    .from(financialAccount)
    .where(
      and(
        eq(financialAccount.fundingSourceId, input.loserSourceId),
        notDeleted(financialAccount),
      ),
    );
  await lockFundingEvidenceMutationTargets(tx, {
    accountIds: accountsToMove.map((row) => row.id),
  });
  const movedAccounts = await tx
    .update(financialAccount)
    .set({ fundingSourceId: input.keeperSourceId })
    .where(
      and(
        eq(financialAccount.fundingSourceId, input.loserSourceId),
        notDeleted(financialAccount),
      ),
    )
    .returning({ id: financialAccount.id });
  fundingEdgesRepointed += movedAccounts.length;

  const affectedTransfers = await tx
    .select({
      id: fundingTransfer.id,
      fromSourceId: fundingTransfer.fromSourceId,
      toSourceId: fundingTransfer.toSourceId,
    })
    .from(fundingTransfer)
    .where(
      and(
        or(
          eq(fundingTransfer.fromSourceId, input.loserSourceId),
          eq(fundingTransfer.toSourceId, input.loserSourceId),
        ),
        notDeleted(fundingTransfer),
      ),
    );
  for (const transfer of affectedTransfers) {
    const fromSourceId =
      transfer.fromSourceId === input.loserSourceId
        ? input.keeperSourceId
        : transfer.fromSourceId;
    const toSourceId =
      transfer.toSourceId === input.loserSourceId
        ? input.keeperSourceId
        : transfer.toSourceId;
    await tx
      .update(fundingTransfer)
      .set({
        fromSourceId,
        toSourceId,
        ...(fromSourceId === toSourceId
          ? { kind: "internal_account_move" as const }
          : {}),
      })
      .where(eq(fundingTransfer.id, transfer.id));
  }
  await tx
    .update(fundingSource)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(fundingSource.id, input.loserSourceId), notDeleted(fundingSource)),
    );
  return {
    fundingEdgesRepointed,
    transferEdgesRepointed: affectedTransfers.length,
  };
}
