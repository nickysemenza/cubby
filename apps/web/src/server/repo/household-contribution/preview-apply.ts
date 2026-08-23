import type { ActorContext } from "@cubby/schemas/context";
import {
  type ApplyHouseholdLedgerChangesInput,
  type ApplyHouseholdLedgerChangesOut,
  applyHouseholdLedgerChangesOut,
  type HouseholdLedgerChange,
  type HouseholdLedgerChangePreviewOut,
  householdLedgerChangePreviewOut,
  type PreviewHouseholdLedgerChangesInput,
} from "@cubby/schemas/household-contribution";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  expenseSourceRef,
  fundingSource,
  fundingTransferEvidence,
  fundingTransferSourceRef,
  householdLedgerImport,
} from "~/server/db/schema";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import {
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  applyHouseholdLedgerChange,
  findFundingTransferByShortcode,
  type HouseholdMutationResult,
  validateExpenseSourceClaim,
  validateFundingTransferEvidence,
} from "./mutations";
import { resolveFundingPartyOrThrow } from "./party";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * One compact state witness. Cubby is one household, so hashing the complete
 * ledger-related state is cheap and guarantees apply cannot miss a dependency
 * that changed between review and execution.
 */
async function loadLedgerStateWitness(
  db: Database | DrizzleTransaction,
): Promise<unknown> {
  const result = await unwrapDb(db).execute<{ witness: unknown }>(sql`
    SELECT jsonb_build_object(
      'people', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, shortcode, kind, "updatedAt", "deletedAt" FROM "Person") x),
      'sources', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, kind, "personId", "fundKey", name, notes, "updatedAt", "deletedAt" FROM "FundingSource") x),
      'expenses', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, shortcode, cost, date, future, "projectId", "updatedAt", "deletedAt" FROM "Expense") x),
      'attributions', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "expenseId", role, "personId", "fundingSourceId", weight, "updatedAt", "deletedAt" FROM "ExpenseAttribution") x),
      'expenseRefs', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "expenseId", source, "externalId", "sourceAmount", "expenseAmountAtClaim", "reconciliationDecision", "reconciliationNote", "updatedAt", "deletedAt" FROM "ExpenseSourceRef") x),
      'accounts', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, shortcode, "fundingSourceId", "updatedAt", "deletedAt" FROM "FinancialAccount") x),
      'accountPeople', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "accountId", "personId", role, "updatedAt", "deletedAt" FROM "FinancialAccountPerson") x),
      'transactions', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, shortcode, "accountId", status, amount, "updatedAt", "deletedAt" FROM "FinancialTransaction") x),
      'transfers', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, shortcode, "fromSourceId", "toSourceId", kind, amount, date, notes, "updatedAt", "deletedAt" FROM "FundingTransfer") x),
      'transferRefs', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "transferId", source, "externalId", "updatedAt", "deletedAt" FROM "FundingTransferSourceRef") x),
      'transferEvidence', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "transferId", "transactionId", side, "updatedAt", "deletedAt" FROM "FundingTransferEvidence") x)
    ) AS witness
  `);
  return result.rows[0]?.witness ?? {};
}

type PreviewRow = HouseholdLedgerChangePreviewOut["changes"][number];
type Refusal = NonNullable<HouseholdLedgerChangePreviewOut["refusal"]>;

const ready = (
  index: number,
  summary: string,
  affectedIds: string[],
): PreviewRow => ({ index, status: "ready", summary, affectedIds });

function affectedIdsFor(change: HouseholdLedgerChange): string[] {
  switch (change.type) {
    case "set_expense_attribution":
      return [...change.expenseIds];
    case "claim_expense_source":
      return [change.expenseId];
    case "upsert_funding_fund":
      return [change.key];
    case "set_account_funding":
      return [change.accountId];
    case "put_funding_transfer":
    case "delete_funding_transfer":
      return change.transferId ? [change.transferId] : [];
  }
}

function expectedRefusal(error: unknown): Refusal | null {
  if (!(error instanceof TRPCError)) return null;
  if (
    !["NOT_FOUND", "BAD_REQUEST", "CONFLICT", "PRECONDITION_FAILED"].includes(
      error.code,
    )
  ) {
    return null;
  }
  const payload = toPublicErrorPayload(error);
  return {
    error: error.message,
    code: payload.code,
    reason: payload.reason,
    blockers: payload.blockers ?? [],
  };
}

function referencedFundKeys(change: HouseholdLedgerChange): string[] {
  switch (change.type) {
    case "set_expense_attribution":
      return (change.funders?.parties ?? []).flatMap((row) =>
        row.party.kind === "fund" ? [row.party.key] : [],
      );
    case "set_account_funding":
      return change.fundingParty?.kind === "fund"
        ? [change.fundingParty.key]
        : [];
    case "put_funding_transfer":
      return [change.from, change.to].flatMap((party) =>
        party.kind === "fund" ? [party.key] : [],
      );
    default:
      return [];
  }
}

async function missingBootstrapFundKeys(
  db: Database | DrizzleTransaction,
  changes: readonly HouseholdLedgerChange[],
): Promise<Set<string>> {
  const keys = [
    ...new Set(
      changes.flatMap((change) =>
        change.type === "upsert_funding_fund" ? [change.key] : [],
      ),
    ),
  ];
  if (keys.length === 0) return new Set();
  const existing = await unwrapDb(db)
    .select({ key: fundingSource.fundKey })
    .from(fundingSource)
    .where(
      and(
        eq(fundingSource.kind, "shared_fund"),
        inArray(fundingSource.fundKey, keys),
        notDeleted(fundingSource),
      ),
    );
  return new Set(
    keys.filter((key) => !existing.some((row) => row.key === key)),
  );
}

async function previewChange(
  db: Database | DrizzleTransaction,
  change: HouseholdLedgerChange,
  index: number,
  bootstrapFundKeys: ReadonlySet<string>,
): Promise<PreviewRow> {
  const bootstrapFund = referencedFundKeys(change).find((key) =>
    bootstrapFundKeys.has(key),
  );
  if (bootstrapFund) {
    return {
      index,
      status: "needs_decision",
      summary: `Bootstrap shared fund ${bootstrapFund} in its own reviewed batch before referencing it here.`,
      affectedIds: affectedIdsFor(change),
    };
  }
  switch (change.type) {
    case "set_expense_attribution": {
      for (const code of change.expenseIds) {
        await resolveOrThrow(db, "expense", code);
      }
      if (change.beneficiaries) {
        for (const row of change.beneficiaries.people) {
          await resolveOrThrow(db, "person", row.personId);
        }
      }
      if (change.funders) {
        for (const row of change.funders.parties) {
          await resolveFundingPartyOrThrow(db, row.party);
        }
      }
      return ready(
        index,
        `Set weighted attribution on ${change.expenseIds.length} Expense(s)`,
        [...change.expenseIds],
      );
    }
    case "claim_expense_source": {
      const expenseId = await resolveOrThrow(db, "expense", change.expenseId);
      const [expenseRow] = await unwrapDb(db)
        .select({ cost: expense.cost })
        .from(expense)
        .where(and(eq(expense.id, expenseId), notDeleted(expense)))
        .limit(1);
      const { expenseCost, reconciliationNote } = validateExpenseSourceClaim(
        expenseRow?.cost,
        change,
      );
      const [existing] = await unwrapDb(db)
        .select({
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
      const sameDecision =
        existing?.expenseId === expenseId &&
        Math.round(existing.sourceAmount * 100) ===
          Math.round(change.sourceAmount * 100) &&
        Math.round(existing.expenseAmountAtClaim * 100) ===
          Math.round(expenseCost * 100) &&
        existing.reconciliationDecision === change.reconciliation.decision &&
        existing.reconciliationNote === reconciliationNote;
      if (existing && sameDecision && !existing.deletedAt) {
        return {
          index,
          status: "already_recorded",
          summary:
            "Expense source reference is already claimed by this Expense",
          affectedIds: [change.expenseId],
        };
      }
      if (existing?.expenseId === expenseId && !sameDecision) {
        return {
          index,
          status: "conflict",
          summary:
            "This Expense source identity already has a different reconciliation decision",
          affectedIds: [change.expenseId],
        };
      }
      if (existing && existing.expenseId !== expenseId) {
        return {
          index,
          status: "conflict",
          summary:
            "Expense source reference is permanently claimed by another Expense",
          affectedIds: [change.expenseId],
        };
      }
      return ready(
        index,
        existing
          ? "Revive source identity for Expense"
          : "Claim source identity for Expense",
        [change.expenseId],
      );
    }
    case "upsert_funding_fund": {
      const [existing] = await unwrapDb(db)
        .select({ name: fundingSource.name, notes: fundingSource.notes })
        .from(fundingSource)
        .where(
          and(
            eq(fundingSource.kind, "shared_fund"),
            eq(fundingSource.fundKey, change.key),
            notDeleted(fundingSource),
          ),
        )
        .limit(1);
      const notes = change.notes === undefined ? existing?.notes : change.notes;
      if (existing?.name === change.name && existing.notes === notes) {
        return {
          index,
          status: "already_recorded",
          summary: `Funding fund ${change.key} already matches`,
          affectedIds: [change.key],
        };
      }
      return ready(index, `Upsert funding fund ${change.key}`, [change.key]);
    }
    case "set_account_funding":
      await resolveOrThrow(db, "financialAccount", change.accountId);
      if (change.fundingParty)
        await resolveFundingPartyOrThrow(db, change.fundingParty);
      for (const row of change.people) {
        await resolveOrThrow(db, "person", row.personId);
      }
      return ready(index, "Set account funding and descriptive people", [
        change.accountId,
      ]);
    case "put_funding_transfer": {
      const from = await resolveFundingPartyOrThrow(db, change.from);
      const to = await resolveFundingPartyOrThrow(db, change.to);
      if (
        change.kind === "fund_contribution" &&
        !(from.party.kind === "person" && to.party.kind === "shared_fund")
      ) {
        return {
          index,
          status: "conflict",
          summary:
            "Fund contributions must move from a person to a shared fund",
          affectedIds: change.transferId ? [change.transferId] : [],
        };
      }
      try {
        await validateFundingTransferEvidence(
          db,
          change,
          from.sourceId,
          to.sourceId,
        );
      } catch (error) {
        return {
          index,
          status: "conflict",
          summary:
            error instanceof Error
              ? error.message
              : "Transfer evidence is invalid",
          affectedIds: change.transferId ? [change.transferId] : [],
        };
      }
      const transfer = change.transferId
        ? await findFundingTransferByShortcode(db, change.transferId)
        : null;
      if (change.transferId && !transfer) {
        return {
          index,
          status: "conflict",
          summary: `Funding transfer not found: ${change.transferId}`,
          affectedIds: [change.transferId],
        };
      }
      const transferId = transfer?.id;
      for (const ref of change.sourceRefs) {
        const [conflict] = await unwrapDb(db)
          .select({ transferId: fundingTransferSourceRef.transferId })
          .from(fundingTransferSourceRef)
          .where(
            and(
              eq(fundingTransferSourceRef.source, ref.source),
              eq(fundingTransferSourceRef.externalId, ref.externalId),
            ),
          )
          .limit(1);
        if (conflict && conflict.transferId !== transferId) {
          return {
            index,
            status: "conflict",
            summary: `Transfer source reference ${ref.source}/${ref.externalId} is already recorded`,
            affectedIds: change.transferId ? [change.transferId] : [],
          };
        }
      }
      for (const evidence of change.evidence) {
        const transactionId = await resolveOrThrow(
          db,
          "financialTransaction",
          evidence.transactionId,
        );
        const [conflict] = await unwrapDb(db)
          .select({ transferId: fundingTransferEvidence.transferId })
          .from(fundingTransferEvidence)
          .where(
            and(
              eq(fundingTransferEvidence.transactionId, transactionId),
              notDeleted(fundingTransferEvidence),
            ),
          )
          .limit(1);
        if (conflict && conflict.transferId !== transferId) {
          return {
            index,
            status: "conflict",
            summary: `Evidence ${evidence.transactionId} already proves another transfer`,
            affectedIds: change.transferId ? [change.transferId] : [],
          };
        }
      }
      return ready(
        index,
        `Record ${change.kind.replaceAll("_", " ")}`,
        change.transferId ? [change.transferId] : [],
      );
    }
    case "delete_funding_transfer": {
      const existing = await findFundingTransferByShortcode(
        db,
        change.transferId,
      );
      return existing?.deletedAt === null
        ? ready(index, "Delete funding transfer", [change.transferId])
        : {
            index,
            status: "already_recorded",
            summary: "Funding transfer is already absent",
            affectedIds: [change.transferId],
          };
    }
  }
}

async function previewHouseholdLedgerChangesOn(
  db: Database | DrizzleTransaction,
  input: PreviewHouseholdLedgerChangesInput,
): Promise<HouseholdLedgerChangePreviewOut> {
  const state = await loadLedgerStateWitness(db);
  const bootstrapFundKeys = await missingBootstrapFundKeys(db, input.changes);
  const changes: PreviewRow[] = [];
  const refusals = new Map<number, Refusal>();
  for (const [index, change] of input.changes.entries()) {
    try {
      changes.push(await previewChange(db, change, index, bootstrapFundKeys));
    } catch (error) {
      const refusal = expectedRefusal(error);
      if (!refusal) throw error;
      refusals.set(index, refusal);
      changes.push({
        index,
        status: "conflict",
        summary: refusal.error,
        affectedIds: affectedIdsFor(change),
      });
    }
  }
  const previewFingerprint = await fingerprint({
    changes: input.changes,
    state,
  });
  const conflict = changes.find(
    (change) =>
      change.status === "conflict" || change.status === "needs_decision",
  );
  const refusal = conflict
    ? (refusals.get(conflict.index) ?? {
        error: conflict.summary,
        code:
          conflict.status === "needs_decision"
            ? "PRECONDITION_FAILED"
            : "CONFLICT",
        reason:
          conflict.status === "needs_decision"
            ? "HOUSEHOLD_LEDGER_BOOTSTRAP_REQUIRED"
            : "HOUSEHOLD_LEDGER_EVIDENCE_CONFLICT",
        blockers: [],
      })
    : undefined;
  return householdLedgerChangePreviewOut.parse({
    previewFingerprint,
    changes,
    ...(refusal ? { refusal } : {}),
  });
}

export async function previewHouseholdLedgerChanges(
  db: Database,
  input: PreviewHouseholdLedgerChangesInput,
): Promise<HouseholdLedgerChangePreviewOut> {
  return previewHouseholdLedgerChangesOn(db, input);
}

export async function applyHouseholdLedgerChanges(
  db: Database,
  input: ApplyHouseholdLedgerChangesInput,
  actor: ActorContext,
): Promise<ApplyHouseholdLedgerChangesOut> {
  const requestHash = await fingerprint(input.changes);
  try {
    return await withTransaction(db, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`household-import:${input.idempotencyKey}`}, 0))`,
      );
      const [existing] = await tx
        .select({
          requestHash: householdLedgerImport.requestHash,
          result: householdLedgerImport.result,
        })
        .from(householdLedgerImport)
        .where(eq(householdLedgerImport.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return applyHouseholdLedgerChangesOut.parse({
            status: "refused",
            previewFingerprint: input.previewFingerprint,
            changed: 0,
            transferIds: [],
            refusal: {
              error:
                "This idempotency key was already used for a different household ledger request",
              code: "CONFLICT",
              reason: "HOUSEHOLD_LEDGER_IDEMPOTENCY_CONFLICT",
              blockers: [],
            },
          });
        }
        const prior = applyHouseholdLedgerChangesOut.parse(existing.result);
        return { ...prior, status: "already_applied" };
      }

      const currentPreview = await previewHouseholdLedgerChangesOn(tx, {
        changes: input.changes,
      });
      if (currentPreview.previewFingerprint !== input.previewFingerprint) {
        return applyHouseholdLedgerChangesOut.parse({
          status: "refused",
          previewFingerprint: input.previewFingerprint,
          changed: 0,
          transferIds: [],
          refusal: {
            error:
              "Household ledger state changed after preview; preview the batch again",
            code: "CONFLICT",
            reason: "HOUSEHOLD_LEDGER_PREVIEW_STALE",
            blockers: [],
          },
        });
      }
      if (currentPreview.refusal) {
        return applyHouseholdLedgerChangesOut.parse({
          status: "refused",
          previewFingerprint: input.previewFingerprint,
          changed: 0,
          transferIds: [],
          refusal: currentPreview.refusal,
        });
      }

      const applied: HouseholdMutationResult[] = [];
      for (const change of input.changes) {
        applied.push(await applyHouseholdLedgerChange(tx, change, actor));
      }
      const result = applyHouseholdLedgerChangesOut.parse({
        status: "applied",
        previewFingerprint: input.previewFingerprint,
        changed: applied.reduce((count, row) => count + row.changed, 0),
        transferIds: applied.flatMap((row) => row.transferIds),
      });
      await tx.insert(householdLedgerImport).values({
        idempotencyKey: input.idempotencyKey,
        previewFingerprint: input.previewFingerprint,
        requestHash,
        changes: input.changes,
        actorUserId: actor.userId,
        actorSource: actor.source,
        result,
      });
      return result;
    });
  } catch (error) {
    const refusal = expectedRefusal(error);
    if (!refusal) throw error;
    return applyHouseholdLedgerChangesOut.parse({
      status: "refused",
      previewFingerprint: input.previewFingerprint,
      changed: 0,
      transferIds: [],
      refusal,
    });
  }
}
