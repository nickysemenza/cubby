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
import { unsafeFundingTransferId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expenseSourceRef,
  fundingSource,
  fundingTransfer,
  fundingTransferEvidence,
  fundingTransferSourceRef,
  householdLedgerImport,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  applyHouseholdLedgerChange,
  type HouseholdMutationResult,
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
        FROM (SELECT id, "expenseId", source, "externalId", "updatedAt", "deletedAt" FROM "ExpenseSourceRef") x),
      'accounts', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, shortcode, "fundingSourceId", "updatedAt", "deletedAt" FROM "FinancialAccount") x),
      'accountPeople', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "accountId", "personId", role, "updatedAt", "deletedAt" FROM "FinancialAccountPerson") x),
      'transactions', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, shortcode, "accountId", status, amount, "updatedAt", "deletedAt" FROM "FinancialTransaction") x),
      'transfers', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "fromSourceId", "toSourceId", kind, amount, date, notes, "updatedAt", "deletedAt" FROM "FundingTransfer") x),
      'transferRefs', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "transferId", source, "externalId", "updatedAt", "deletedAt" FROM "FundingTransferSourceRef") x),
      'transferEvidence', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb)
        FROM (SELECT id, "transferId", "transactionId", side, "updatedAt", "deletedAt" FROM "FundingTransferEvidence") x)
    ) AS witness
  `);
  return result.rows[0]?.witness ?? {};
}

type PreviewRow = HouseholdLedgerChangePreviewOut["changes"][number];

const ready = (
  index: number,
  summary: string,
  affectedIds: string[],
): PreviewRow => ({ index, status: "ready", summary, affectedIds });

async function previewChange(
  db: Database | DrizzleTransaction,
  change: HouseholdLedgerChange,
  index: number,
): Promise<PreviewRow> {
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
      const [existing] = await unwrapDb(db)
        .select({
          expenseId: expenseSourceRef.expenseId,
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
      if (existing?.expenseId === expenseId && !existing.deletedAt) {
        return {
          index,
          status: "already_recorded",
          summary:
            "Expense source reference is already claimed by this Expense",
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
      const transferId = change.transferId
        ? unsafeFundingTransferId(change.transferId)
        : undefined;
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
      const transferId = unsafeFundingTransferId(change.transferId);
      const [existing] = await unwrapDb(db)
        .select({ id: fundingTransfer.id })
        .from(fundingTransfer)
        .where(
          and(eq(fundingTransfer.id, transferId), notDeleted(fundingTransfer)),
        )
        .limit(1);
      return existing
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
  const changes: PreviewRow[] = [];
  for (const [index, change] of input.changes.entries()) {
    changes.push(await previewChange(db, change, index));
  }
  const previewFingerprint = await fingerprint({
    changes: input.changes,
    state,
  });
  const conflict = changes.find((change) => change.status === "conflict");
  return householdLedgerChangePreviewOut.parse({
    previewFingerprint,
    changes,
    ...(conflict
      ? {
          refusal: {
            error: conflict.summary,
            code: "CONFLICT",
            reason: "HOUSEHOLD_LEDGER_EVIDENCE_CONFLICT",
            blockers: [],
          },
        }
      : {}),
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
  return withTransaction(db, async (tx) => {
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
        throw createAppError(
          "HOUSEHOLD_LEDGER_IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for a different household ledger request",
        );
      }
      const prior = applyHouseholdLedgerChangesOut.parse(existing.result);
      return { ...prior, status: "already_applied" };
    }

    const currentPreview = await previewHouseholdLedgerChangesOn(tx, {
      changes: input.changes,
    });
    if (currentPreview.previewFingerprint !== input.previewFingerprint) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_PREVIEW_STALE",
        "Household ledger state changed after preview; preview the batch again",
      );
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
      result,
    });
    return result;
  });
}
