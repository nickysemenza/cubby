import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  auditLog,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
  ledgerSourceClaim,
  ledgerTransfer,
} from "~/server/db/schema";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import { unwrapDb } from "~/server/repo/database-helpers";
import { createExpense, updateExpense } from "~/server/repo/expense";
import {
  createFinancialAccount,
  updateFinancialAccount,
} from "~/server/repo/financial-account";
import {
  deleteFinancialTransactions,
  updateFinancialTransaction,
} from "~/server/repo/financial-transaction";
import {
  createLedgerParty,
  deleteLedgerParties,
  mergeLedgerParties,
  previewMergeLedgerParties,
  updateLedgerParty,
} from "~/server/repo/ledger-party";
import {
  createLedgerTransfer,
  deleteLedgerTransfers,
  updateLedgerTransfer,
} from "~/server/repo/ledger-transfer";
import { makeExpenseInput } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";

import {
  householdContributionLedger,
  projectContribution,
} from "./household-contribution";

describe("consolidated household ledger", () => {
  const ctx = withTestDb("mcp");

  const party = async (
    name: string,
    kind: "member" | "guest" | "household",
  ) => {
    const result = await createLedgerParty(
      ctx.db,
      { name, kind, notes: null },
      ctx.actor,
    );
    if (!result.output || !result.entityId)
      throw new Error("expected party output");
    return { output: result.output, entityId: result.entityId };
  };

  it("enforces household protection and validates account-mapped transfer evidence", async () => {
    const household = await party("Synthetic household", "household");
    const member = await party("Synthetic member", "member");
    const otherMember = await party("Synthetic other member", "member");
    const guest = await party("Synthetic guest", "guest");
    await expect(
      deleteLedgerParties(ctx.db, [household.output.id], ctx.actor),
    ).rejects.toThrow("singleton household");
    await expect(
      createFinancialAccount(
        ctx.db,
        {
          name: "Guest mapping placeholder",
          identity: { kind: "cash" },
          provisional: false,
          sourceAliases: [],
          ledgerPartyId: guest.output.id,
          notes: null,
        },
        ctx.actor,
      ),
    ).rejects.toThrow("member or the household");
    const [memberAccount, otherMemberAccount] = await Promise.all([
      insertWithShortcode(ctx.db, "financialAccount", {
        name: "Member placeholder",
        identity: { kind: "cash" },
        ledgerPartyId: member.entityId,
      }),
      insertWithShortcode(ctx.db, "financialAccount", {
        name: "Other member placeholder",
        identity: { kind: "cash" },
        ledgerPartyId: otherMember.entityId,
      }),
    ]);
    await expect(
      updateLedgerParty(ctx.db, member.output.id, { kind: "guest" }, ctx.actor),
    ).rejects.toThrow("cannot become a guest");
    const [outflow, inflow] = await Promise.all([
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: memberAccount.id,
        kind: "account_transfer",
        status: "posted",
        amount: 12,
        transactionDate: "2026-08-20",
        postedDate: "2026-08-20",
      }),
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: otherMemberAccount.id,
        kind: "account_transfer",
        status: "posted",
        amount: -12,
        transactionDate: "2026-08-20",
        postedDate: "2026-08-20",
      }),
    ]);
    const secondMemberAccount = await insertWithShortcode(
      ctx.db,
      "financialAccount",
      {
        name: "Second member account placeholder",
        identity: { kind: "cash" },
        ledgerPartyId: member.entityId,
      },
    );
    const [
      pending,
      wrongAmount,
      wrongParty,
      secondPositive,
      sameAccountInflow,
    ] = await Promise.all([
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: memberAccount.id,
        kind: "account_transfer",
        status: "pending",
        amount: 12,
        transactionDate: "2026-08-20",
      }),
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: memberAccount.id,
        kind: "account_transfer",
        status: "posted",
        amount: 11,
        transactionDate: "2026-08-20",
        postedDate: "2026-08-20",
      }),
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: memberAccount.id,
        kind: "account_transfer",
        status: "posted",
        amount: -12,
        transactionDate: "2026-08-20",
        postedDate: "2026-08-20",
      }),
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: secondMemberAccount.id,
        kind: "account_transfer",
        status: "posted",
        amount: 12,
        transactionDate: "2026-08-20",
        postedDate: "2026-08-20",
      }),
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: memberAccount.id,
        kind: "account_transfer",
        status: "posted",
        amount: -12,
        transactionDate: "2026-08-20",
        postedDate: "2026-08-20",
      }),
    ]);
    const vendorId = await findOrCreateVendor(
      ctx.db,
      "Synthetic evidence vendor",
    );
    const allocatedPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-08-20",
      displayLabel: "Synthetic evidence allocation",
    });
    const allocated = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: memberAccount.id,
        kind: "account_transfer",
        status: "posted",
        amount: 12,
        transactionDate: "2026-08-20",
        postedDate: "2026-08-20",
      },
    );
    await unwrapDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: allocated.id,
      purchaseId: allocatedPurchase.id,
      amount: 12,
    });
    const expectInvalidEvidence = async (
      rows: Array<{ shortcode: string }>,
      message: string,
      endpoints = {
        fromPartyId: member.output.id,
        toPartyId: otherMember.output.id,
      },
    ) =>
      expect(
        createLedgerTransfer(
          ctx.db,
          {
            ...endpoints,
            amount: 12,
            date: "2026-08-20",
            notes: null,
            sourceClaims: [],
            evidenceTransactionIds: rows.map((row) =>
              parseShortcodeFor("financialTransaction", row.shortcode),
            ),
          },
          ctx.actor,
        ),
      ).rejects.toThrow(message);
    await expectInvalidEvidence([pending], "posted, unallocated");
    await expectInvalidEvidence([wrongAmount], "match the transfer amount");
    await expectInvalidEvidence([wrongParty], "endpoint party");
    await expectInvalidEvidence([outflow, secondPositive], "one positive");
    await expectInvalidEvidence(
      [outflow, sameAccountInflow],
      "distinct financial accounts",
      { fromPartyId: member.output.id, toPartyId: member.output.id },
    );
    await expectInvalidEvidence([allocated], "posted, unallocated");
    const transfer = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: member.output.id,
        toPartyId: otherMember.output.id,
        amount: 12,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [],
        evidenceTransactionIds: [
          parseShortcodeFor("financialTransaction", outflow.shortcode),
          parseShortcodeFor("financialTransaction", inflow.shortcode),
        ],
      },
      ctx.actor,
    );
    expect(transfer.output?.classification).toBe("reimbursement");
    await expect(
      updateFinancialTransaction(
        ctx.db,
        parseShortcodeFor("financialTransaction", outflow.shortcode),
        { status: "pending" },
        ctx.actor,
      ),
    ).rejects.toThrow("cannot be changed");
    await expect(
      updateFinancialAccount(
        ctx.db,
        parseShortcodeFor("financialAccount", memberAccount.shortcode),
        { ledgerPartyId: household.output.id },
        ctx.actor,
      ),
    ).rejects.toThrow("while it evidences a ledger transfer");
    await expect(
      updateLedgerTransfer(
        ctx.db,
        transfer.output!.id,
        {
          evidenceTransactionIds: [
            parseShortcodeFor("financialTransaction", inflow.shortcode),
          ],
          sourceClaims: [
            {
              source: "synthetic-transfer",
              providerId: "synthetic-transfer-row",
              normalizedEvidence: {
                amount: 12,
                occurredOn: "2026-08-20",
                description: "Synthetic transfer evidence",
                context: null,
                disambiguator: null,
              },
              reconciliation: { decision: "amounts_match" },
            },
          ],
        },
        ctx.actor,
      ),
    ).resolves.toBeDefined();
    const transferAudits = await unwrapDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "ledgerTransfer"),
          eq(auditLog.entityId, transfer.entityId),
          eq(auditLog.action, "update"),
        ),
      );
    expect(
      transferAudits.some(
        ({ changes }) =>
          changes !== null &&
          "evidenceTransactionIds" in changes &&
          "sourceClaims" in changes,
      ),
    ).toBe(true);
    await expect(
      deleteLedgerParties(ctx.db, [member.output.id], ctx.actor),
    ).rejects.toThrow(
      "A ledger party with live attributions, accounts, or transfers cannot be deleted.",
    );
    await expect(
      deleteFinancialTransactions(
        ctx.db,
        [parseShortcodeFor("financialTransaction", inflow.shortcode)],
        ctx.actor,
      ),
    ).rejects.toThrow("cannot be deleted until the transfer releases it");
    await deleteLedgerTransfers(ctx.db, [transfer.output!.id], ctx.actor);
    const [cleared] = await unwrapDb(ctx.db)
      .select({ id: financialTransaction.id })
      .from(financialTransaction)
      .where(
        and(
          eq(financialTransaction.id, outflow.id),
          isNull(financialTransaction.ledgerTransferId),
        ),
      );
    expect(cleared?.id).toBe(outflow.id);

    // The transfer's OTHER declared disposition: `LedgerSourceClaim` rows are
    // soft-deleted, not detached. Unlike almost every other edge in the
    // lifecycle registry this one runs through a bespoke single-call-site
    // helper (`softDeleteLedgerSourceClaims` in ledger-source-claim.ts, a file
    // with no test of its own) rather than `removeEntity`'s shared children
    // mechanism — so nothing else in the suite covers it.
    const [claim] = await unwrapDb(ctx.db)
      .select({ deletedAt: ledgerSourceClaim.deletedAt })
      .from(ledgerSourceClaim)
      .where(eq(ledgerSourceClaim.ledgerTransferId, transfer.entityId));
    expect(claim).toBeDefined();
    expect(claim?.deletedAt).not.toBeNull();

    await expect(
      deleteLedgerParties(
        ctx.db,
        [guest.output.id, guest.output.id],
        ctx.actor,
      ),
    ).resolves.toEqual({ deleted: 1 });
  });

  it("merges same-kind parties by folding weights and repointing transfers", async () => {
    const keep = await party("Keep placeholder", "guest");
    const lose = await party("Lose placeholder", "guest");
    const other = await party("Other placeholder", "member");
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Placeholder expense",
      cost: 10,
      date: "2026-08-20",
      costType: "materials",
      trade: "other",
    });
    await unwrapDb(ctx.db)
      .insert(expenseAttribution)
      .values([
        {
          expenseId: expense.id,
          role: "funder",
          ledgerPartyId: keep.entityId,
          weight: 2,
        },
        {
          expenseId: expense.id,
          role: "funder",
          ledgerPartyId: lose.entityId,
          weight: 3,
        },
      ]);
    const largeExpense = await insertWithShortcode(ctx.db, "expense", {
      name: "Large-weight placeholder expense",
      cost: 10,
      date: "2026-08-20",
      costType: "materials",
      trade: "other",
    });
    await unwrapDb(ctx.db)
      .insert(expenseAttribution)
      .values([
        {
          expenseId: largeExpense.id,
          role: "funder",
          ledgerPartyId: keep.entityId,
          weight: 3_000_000_000,
        },
        {
          expenseId: largeExpense.id,
          role: "funder",
          ledgerPartyId: lose.entityId,
          weight: 4_000_000_000,
        },
      ]);
    const transfer = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: lose.output.id,
        toPartyId: other.output.id,
        amount: 1,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [],
        evidenceTransactionIds: [],
      },
      ctx.actor,
    );
    // The merge policy declares FOUR repoints; only `LedgerTransfer.fromPartyId`
    // (the transfer above) was exercised. These two cover the rest:
    // `FinancialAccount.ledgerPartyId` and the transfer's `toPartyId`.
    const loserAccount = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Lose-owned placeholder",
      identity: { kind: "cash" },
      ledgerPartyId: lose.entityId,
    });
    const inboundTransfer = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: other.output.id,
        toPartyId: lose.output.id,
        amount: 1,
        date: "2026-08-21",
        notes: null,
        sourceClaims: [],
        evidenceTransactionIds: [],
      },
      ctx.actor,
    );

    const preview = await previewMergeLedgerParties(ctx.db, {
      keepId: keep.entityId,
      mergeIds: [lose.entityId],
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "merge-attributions", total: 4 }),
        expect.objectContaining({
          code: "repoint-outgoing-transfers",
          total: 1,
        }),
      ]),
    );
    await expect(
      previewMergeLedgerParties(ctx.db, {
        keepId: keep.entityId,
        mergeIds: [lose.entityId, lose.entityId],
      }),
    ).resolves.toMatchObject({ blockers: [] });
    await expect(
      previewMergeLedgerParties(ctx.db, {
        keepId: keep.entityId,
        mergeIds: [keep.entityId],
      }),
    ).rejects.toThrow("into itself");
    const mergeResult = await mergeLedgerParties(
      ctx.db,
      { keepId: keep.output.id, mergeIds: [lose.output.id] },
      ctx.actor,
    );
    expect(mergeResult.mergeSummary.deletedIds).toEqual([lose.output.id]);
    expect(mergeResult.mergeSummary.deletedIds[0]).toMatch(/^LPY-/u);
    const [share] = await unwrapDb(ctx.db)
      .select({
        weight: expenseAttribution.weight,
        shortcode: ledgerParty.shortcode,
      })
      .from(expenseAttribution)
      .innerJoin(
        ledgerParty,
        eq(expenseAttribution.ledgerPartyId, ledgerParty.id),
      )
      .where(eq(expenseAttribution.expenseId, expense.id));
    expect(share).toEqual({ weight: 5, shortcode: keep.output.id });
    const [largeShare] = await unwrapDb(ctx.db)
      .select({ weight: expenseAttribution.weight })
      .from(expenseAttribution)
      .where(
        and(
          eq(expenseAttribution.expenseId, largeExpense.id),
          isNull(expenseAttribution.deletedAt),
        ),
      );
    expect(largeShare?.weight).toBe(7_000_000_000);
    // `toBeDefined()` would pass even if the repoint named the WRONG party — it
    // only proves the column is non-null. All three repoints assert the
    // survivor by id.
    const [repointed] = await unwrapDb(ctx.db)
      .select({ fromPartyId: ledgerTransfer.fromPartyId })
      .from(ledgerTransfer)
      .where(eq(ledgerTransfer.shortcode, transfer.output!.id));
    expect(repointed?.fromPartyId).toBe(keep.entityId);

    const [inbound] = await unwrapDb(ctx.db)
      .select({ toPartyId: ledgerTransfer.toPartyId })
      .from(ledgerTransfer)
      .where(eq(ledgerTransfer.shortcode, inboundTransfer.output!.id));
    expect(inbound?.toPartyId).toBe(keep.entityId);

    const [account] = await unwrapDb(ctx.db)
      .select({ ledgerPartyId: financialAccount.ledgerPartyId })
      .from(financialAccount)
      .where(eq(financialAccount.id, loserAccount.id));
    expect(account?.ledgerPartyId).toBe(keep.entityId);
  });

  it("owns nested Expense sets with omit, replace, and clear semantics", async () => {
    const member = await party("Nested member placeholder", "member");
    const household = await party("Nested household placeholder", "household");
    const claim = {
      source: "synthetic-provider",
      providerId: "synthetic-row-1",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-20",
        description: "Synthetic expense evidence",
        context: null,
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
    };
    const created = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Nested-set placeholder",
        cost: 10,
        beneficiaries: [{ partyId: member.output.id, weight: 2 }],
        funders: [{ partyId: household.output.id, weight: 1 }],
        sourceClaims: [claim],
      }),
      ctx.actor,
    );

    const omitted = await updateExpense(
      ctx.db,
      created.output.id,
      { notes: "Nested sets omitted" },
      ctx.actor,
    );
    expect(omitted.output).toMatchObject({
      beneficiaries: [{ partyId: member.output.id, weight: 2 }],
      funders: [{ partyId: household.output.id, weight: 1 }],
    });
    expect(omitted.output.sourceClaims).toHaveLength(1);

    const partiallyCleared = await updateExpense(
      ctx.db,
      created.output.id,
      { beneficiaries: null },
      ctx.actor,
    );
    expect(partiallyCleared.output.beneficiaries).toEqual([]);
    expect(partiallyCleared.output.funders).toEqual([
      { partyId: household.output.id, weight: 1 },
    ]);
    expect(partiallyCleared.output.sourceClaims).toHaveLength(1);

    const cleared = await updateExpense(
      ctx.db,
      created.output.id,
      { funders: [], sourceClaims: null },
      ctx.actor,
    );
    expect(cleared.output.funders).toEqual([]);
    expect(cleared.output.sourceClaims).toEqual([]);
    const nestedAudits = await unwrapDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "expense"),
          eq(auditLog.entityId, created.entityId),
          eq(auditLog.action, "update"),
        ),
      );
    for (const field of ["beneficiaries", "funders", "sourceClaims"]) {
      expect(
        nestedAudits.some(
          ({ changes }) => changes !== null && field in changes,
        ),
      ).toBe(true);
    }
  });

  it("requires source claims to be explicit when an Expense cost changes", async () => {
    const claim = {
      source: "synthetic-provider",
      providerId: "synthetic-expense-amount-row",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-20",
        description: "Synthetic expense amount evidence",
        context: null,
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
    };
    const created = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Expense amount guard placeholder",
        cost: 10,
        sourceClaims: [claim],
      }),
      ctx.actor,
    );

    await expect(
      updateExpense(ctx.db, created.output.id, { cost: 11 }, ctx.actor),
    ).rejects.toMatchObject({
      cause: { reason: "CONSTRAINT_VIOLATION" },
    });

    const nonMoneyUpdate = await updateExpense(
      ctx.db,
      created.output.id,
      { notes: "Source claims omitted intentionally" },
      ctx.actor,
    );
    expect(nonMoneyUpdate.output).toMatchObject({
      cost: 10,
      notes: "Source claims omitted intentionally",
      sourceClaims: [
        expect.objectContaining({
          targetAmountAtClaim: 10,
          reconciliation: { decision: "amounts_match" },
        }),
      ],
    });

    const replaced = await updateExpense(
      ctx.db,
      created.output.id,
      {
        cost: 11,
        sourceClaims: [
          {
            ...claim,
            reconciliation: {
              decision: "accept_target_amount" as const,
              note: "Reviewed after the Expense cost correction",
            },
          },
        ],
      },
      ctx.actor,
    );
    expect(replaced.output).toMatchObject({
      cost: 11,
      sourceClaims: [
        expect.objectContaining({
          targetAmountAtClaim: 11,
          reconciliation: {
            decision: "accept_target_amount",
            note: "Reviewed after the Expense cost correction",
          },
        }),
      ],
    });

    const cleared = await updateExpense(
      ctx.db,
      created.output.id,
      { cost: 12, sourceClaims: null },
      ctx.actor,
    );
    expect(cleared.output).toMatchObject({ cost: 12, sourceClaims: [] });
  });

  it("serializes concurrent claims of new and released source identities", async () => {
    const claim = {
      source: "synthetic-provider",
      providerId: "synthetic-concurrent-claim-row",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-20",
        description: "Synthetic concurrent claim evidence",
        context: null,
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
    };
    const race = (suffix: string) =>
      Promise.allSettled([
        createExpense(
          ctx.db,
          makeExpenseInput({
            name: `Concurrent claim ${suffix} A`,
            cost: 10,
            sourceClaims: [claim],
          }),
          ctx.actor,
        ),
        createExpense(
          ctx.db,
          makeExpenseInput({
            name: `Concurrent claim ${suffix} B`,
            cost: 10,
            sourceClaims: [claim],
          }),
          ctx.actor,
        ),
      ]);
    const expectOneOwnerAndOnePublicConflict = (
      results: Awaited<ReturnType<typeof race>>,
    ) => {
      const winner = results.find((result) => result.status === "fulfilled");
      const loser = results.find((result) => result.status === "rejected");
      expect(winner?.status).toBe("fulfilled");
      expect(loser?.status).toBe("rejected");
      if (winner?.status !== "fulfilled" || loser?.status !== "rejected")
        throw new Error("expected exactly one source-claim winner");
      expect(toPublicErrorPayload(loser.reason)).toMatchObject({
        code: "CONFLICT",
        reason: "LEDGER_SOURCE_CLAIM_CONFLICT",
        blockers: [
          {
            code: "source-claim-already-owned",
            byTargetId: { [winner.value.output.id]: 1 },
          },
        ],
      });
      expect(JSON.stringify(toPublicErrorPayload(loser.reason))).not.toContain(
        winner.value.entityId,
      );
      return winner.value;
    };

    const firstWinner = expectOneOwnerAndOnePublicConflict(await race("new"));
    await updateExpense(
      ctx.db,
      firstWinner.output.id,
      { sourceClaims: null },
      ctx.actor,
    );

    expectOneOwnerAndOnePublicConflict(await race("released"));
  });

  it("requires source claims to be explicit when a Ledger Transfer amount changes", async () => {
    const from = await party("Transfer amount member A", "member");
    const to = await party("Transfer amount member B", "member");
    const claim = {
      source: "synthetic-provider",
      providerId: "synthetic-transfer-amount-row",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-20",
        description: "Synthetic transfer amount evidence",
        context: null,
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
    };
    const created = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: from.output.id,
        toPartyId: to.output.id,
        amount: 10,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [claim],
        evidenceTransactionIds: [],
      },
      ctx.actor,
    );
    if (!created.output) throw new Error("expected transfer output");

    await expect(
      updateLedgerTransfer(
        ctx.db,
        created.output.id,
        { amount: 11 },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "CONSTRAINT_VIOLATION" },
    });

    const nonMoneyUpdate = await updateLedgerTransfer(
      ctx.db,
      created.output.id,
      { notes: "Source claims omitted intentionally" },
      ctx.actor,
    );
    expect(nonMoneyUpdate.output).toMatchObject({
      amount: 10,
      notes: "Source claims omitted intentionally",
      sourceClaims: [
        expect.objectContaining({
          targetAmountAtClaim: 10,
          reconciliation: { decision: "amounts_match" },
        }),
      ],
    });

    const replaced = await updateLedgerTransfer(
      ctx.db,
      created.output.id,
      {
        amount: 11,
        sourceClaims: [
          {
            ...claim,
            reconciliation: {
              decision: "accept_target_amount" as const,
              note: "Reviewed after the transfer amount correction",
            },
          },
        ],
      },
      ctx.actor,
    );
    expect(replaced.output).toMatchObject({
      amount: 11,
      sourceClaims: [
        expect.objectContaining({
          targetAmountAtClaim: 11,
          reconciliation: {
            decision: "accept_target_amount",
            note: "Reviewed after the transfer amount correction",
          },
        }),
      ],
    });

    const cleared = await updateLedgerTransfer(
      ctx.db,
      created.output.id,
      { amount: 12, sourceClaims: null },
      ctx.actor,
    );
    expect(cleared.output).toMatchObject({ amount: 12, sourceClaims: [] });
  });

  it("names a conflicting Ledger Transfer owner by public shortcode", async () => {
    const from = await party("Conflict owner member A", "member");
    const to = await party("Conflict owner member B", "member");
    const claim = {
      source: "synthetic-provider",
      providerId: "synthetic-transfer-conflict-row",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-20",
        description: "Synthetic transfer conflict evidence",
        context: null,
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
    };
    const transfer = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: from.output.id,
        toPartyId: to.output.id,
        amount: 10,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [claim],
        evidenceTransactionIds: [],
      },
      ctx.actor,
    );
    if (!transfer.output) throw new Error("expected transfer output");

    const conflict = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Cross-kind conflict placeholder",
        cost: 10,
        sourceClaims: [claim],
      }),
      ctx.actor,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(toPublicErrorPayload(conflict)).toMatchObject({
      code: "CONFLICT",
      reason: "LEDGER_SOURCE_CLAIM_CONFLICT",
      blockers: [
        {
          code: "source-claim-already-owned",
          byTargetId: { [transfer.output.id]: 1 },
        },
      ],
    });
    expect(JSON.stringify(toPublicErrorPayload(conflict))).not.toContain(
      transfer.entityId,
    );
  });

  it("retries, conflicts, releases, and disambiguates source claims", async () => {
    const providerClaim = {
      source: "synthetic-provider",
      providerId: "synthetic-row-2",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-20",
        description: "Synthetic provider evidence",
        context: null,
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
    };
    const first = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "First claim placeholder",
        cost: 10,
        sourceClaims: [providerClaim],
      }),
      ctx.actor,
    );
    const retried = await updateExpense(
      ctx.db,
      first.output.id,
      { sourceClaims: [providerClaim] },
      ctx.actor,
    );
    const firstKey = retried.output.sourceClaims[0]?.sourceKey;
    expect(firstKey).toMatch(/^v1:[a-f0-9]{64}$/u);
    expect(retried.output.sourceClaims[0]).not.toHaveProperty("providerId");
    const retryAudit = await unwrapDb(ctx.db)
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "expense"),
          eq(auditLog.entityId, first.entityId),
          eq(auditLog.action, "update"),
        ),
      );
    expect(retryAudit).toEqual([]);

    const conflict = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Ambiguous retry placeholder",
        cost: 10,
        sourceClaims: [providerClaim],
      }),
      ctx.actor,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(toPublicErrorPayload(conflict)).toMatchObject({
      code: "CONFLICT",
      reason: "LEDGER_SOURCE_CLAIM_CONFLICT",
      blockers: [
        {
          code: "source-claim-already-owned",
          effect: "block",
          total: 1,
          byTargetId: { [first.output.id]: 1 },
        },
      ],
    });
    expect(JSON.stringify(toPublicErrorPayload(conflict))).not.toContain(
      first.entityId,
    );

    const second = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "Second claim placeholder", cost: 10 }),
      ctx.actor,
    );
    await expect(
      updateExpense(
        ctx.db,
        second.output.id,
        { sourceClaims: [providerClaim] },
        ctx.actor,
      ),
    ).rejects.toThrow("different ledger record");

    await updateExpense(
      ctx.db,
      first.output.id,
      { sourceClaims: [] },
      ctx.actor,
    );
    const corrected = await updateExpense(
      ctx.db,
      second.output.id,
      { sourceClaims: [providerClaim] },
      ctx.actor,
    );
    expect(corrected.output.sourceClaims[0]?.sourceKey).toBe(firstKey);

    const canonical = {
      source: "synthetic-export",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-21",
        description: "Indistinguishable synthetic row",
        context: "Synthetic context",
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
    };
    const third = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Canonical claim placeholder",
        cost: 10,
        sourceClaims: [canonical],
      }),
      ctx.actor,
    );
    const fourth = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "Duplicate claim placeholder", cost: 10 }),
      ctx.actor,
    );
    await expect(
      updateExpense(
        ctx.db,
        fourth.output.id,
        { sourceClaims: [canonical] },
        ctx.actor,
      ),
    ).rejects.toThrow("different ledger record");
    await expect(
      updateExpense(
        ctx.db,
        fourth.output.id,
        {
          sourceClaims: [
            {
              ...canonical,
              normalizedEvidence: {
                ...canonical.normalizedEvidence,
                disambiguator: "reviewed duplicate 2",
              },
            },
          ],
        },
        ctx.actor,
      ),
    ).resolves.toBeDefined();

    await expect(
      updateExpense(
        ctx.db,
        third.output.id,
        {
          sourceClaims: [
            {
              ...canonical,
              normalizedEvidence: {
                ...canonical.normalizedEvidence,
                amount: 9,
              },
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("requires accept_target_amount");
    await expect(
      updateExpense(
        ctx.db,
        third.output.id,
        {
          sourceClaims: [
            {
              ...canonical,
              normalizedEvidence: {
                ...canonical.normalizedEvidence,
                amount: 9,
              },
              reconciliation: {
                decision: "accept_target_amount",
                note: "Reviewed synthetic mismatch",
              },
            },
          ],
        },
        ctx.actor,
      ),
    ).resolves.toBeDefined();

    await expect(
      unwrapDb(ctx.db)
        .insert(ledgerSourceClaim)
        .values({
          expenseId: third.entityId,
          source: "synthetic-check",
          sourceKey: "synthetic-invalid-reconciliation",
          sourceKeyVersion: 1,
          normalizedEvidence: {
            amount: 9,
            occurredOn: "2026-08-21",
            description: "Synthetic invalid direct row",
            context: null,
            disambiguator: null,
          },
          targetAmountAtClaim: 10,
          reconciliationDecision: "amounts_match",
          reconciliationNote: null,
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("reports renovation, solo and shared trips, guests, transfers, and unknowns", async () => {
    const household = await party("Report household", "household");
    const first = await party("Report member A", "member");
    const second = await party("Report member B", "member");
    const guest = await party("Report guest", "guest");
    const [renovation, solo, trip, unknown] = await Promise.all([
      insertWithShortcode(ctx.db, "project", {
        name: "Synthetic renovation",
        kind: "renovation",
      }),
      insertWithShortcode(ctx.db, "project", {
        name: "Synthetic solo project",
      }),
      insertWithShortcode(ctx.db, "project", {
        name: "Synthetic shared trip",
      }),
      insertWithShortcode(ctx.db, "project", {
        name: "Synthetic unknown-attribution project",
      }),
    ]);
    const [
      renovationCost,
      futureRenovationCost,
      soloCost,
      tripCost,
      guestCost,
    ] = await Promise.all([
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic renovation cost",
        cost: 100,
        date: "2026-08-20",
        costType: "materials",
        trade: "other",
        future: false,
        projectId: renovation.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic planned renovation cost",
        cost: 25,
        date: "2026-09-20",
        costType: "materials",
        trade: "other",
        future: true,
        projectId: renovation.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic solo cost",
        cost: 40,
        date: "2026-08-20",
        costType: "services",
        trade: "other",
        future: false,
        projectId: solo.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic shared-trip cost",
        cost: 60,
        date: "2026-08-20",
        costType: "services",
        trade: "other",
        future: false,
        projectId: trip.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic guest-trip cost",
        cost: 30,
        date: "2026-08-20",
        costType: "services",
        trade: "other",
        future: false,
        projectId: trip.id,
      }),
    ]);
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic unknown cost",
      cost: 10,
      date: "2026-08-20",
      costType: "materials",
      trade: "other",
      future: false,
      projectId: unknown.id,
    });
    const explicitUnknown = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic explicitly unknown cost",
      cost: 8,
      date: "2026-08-20",
      costType: "materials",
      trade: "other",
      future: false,
      projectId: unknown.id,
    });
    await unwrapDb(ctx.db)
      .insert(expenseAttribution)
      .values([
        ...[renovationCost, futureRenovationCost].flatMap((expense) => [
          {
            expenseId: expense.id,
            role: "beneficiary" as const,
            ledgerPartyId: household.entityId,
            weight: 1,
          },
          {
            expenseId: expense.id,
            role: "funder" as const,
            ledgerPartyId: household.entityId,
            weight: 1,
          },
        ]),
        {
          expenseId: soloCost.id,
          role: "beneficiary",
          ledgerPartyId: first.entityId,
          weight: 1,
        },
        {
          expenseId: soloCost.id,
          role: "funder",
          ledgerPartyId: first.entityId,
          weight: 1,
        },
        {
          expenseId: tripCost.id,
          role: "beneficiary",
          ledgerPartyId: first.entityId,
          weight: 1,
        },
        {
          expenseId: tripCost.id,
          role: "beneficiary",
          ledgerPartyId: second.entityId,
          weight: 1,
        },
        {
          expenseId: tripCost.id,
          role: "funder",
          ledgerPartyId: household.entityId,
          weight: 1,
        },
        {
          expenseId: guestCost.id,
          role: "beneficiary",
          ledgerPartyId: guest.entityId,
          weight: 1,
        },
        {
          expenseId: guestCost.id,
          role: "funder",
          ledgerPartyId: guest.entityId,
          weight: 1,
        },
        {
          expenseId: explicitUnknown.id,
          role: "beneficiary",
          ledgerPartyId: null,
          weight: 1,
        },
        {
          expenseId: explicitUnknown.id,
          role: "funder",
          ledgerPartyId: null,
          weight: 1,
        },
      ]);

    for (const [fromPartyId, toPartyId, amount] of [
      [first.output.id, household.output.id, 20],
      [household.output.id, first.output.id, 5],
      [household.output.id, household.output.id, 12],
      [first.output.id, second.output.id, 3],
    ] as const) {
      await createLedgerTransfer(
        ctx.db,
        {
          fromPartyId,
          toPartyId,
          amount,
          date: "2026-08-20",
          notes: null,
          sourceClaims: [],
          evidenceTransactionIds: [],
        },
        ctx.actor,
      );
    }

    const renovationReport = await projectContribution(ctx.db, {
      projectId: parseShortcodeFor("project", renovation.shortcode),
      includeSubprojects: true,
    });
    expect(renovationReport).toMatchObject({
      wholeGroupCost: 125,
      householdInitialExposure: 125,
      householdConsumed: 125,
      guestInitialFunding: 0,
      unattributedInitialFunding: 0,
      gaps: [],
    });
    expect(renovationReport.parties).toEqual([
      expect.objectContaining({
        party: expect.objectContaining({ kind: "household" }),
        consumed: 125,
      }),
    ]);

    const soloReport = await projectContribution(ctx.db, {
      projectId: parseShortcodeFor("project", solo.shortcode),
      includeSubprojects: true,
    });
    expect(soloReport.parties).toEqual([
      expect.objectContaining({
        party: expect.objectContaining({ id: first.output.id }),
        consumed: 40,
      }),
    ]);

    const tripReport = await projectContribution(ctx.db, {
      projectId: parseShortcodeFor("project", trip.shortcode),
      includeSubprojects: true,
    });
    expect(tripReport).toMatchObject({
      wholeGroupCost: 90,
      householdInitialExposure: 60,
      guestInitialFunding: 30,
      householdConsumed: 0,
      gaps: [],
    });
    expect(tripReport.parties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          party: expect.objectContaining({ id: first.output.id }),
          consumed: 30,
        }),
        expect.objectContaining({
          party: expect.objectContaining({ id: second.output.id }),
          consumed: 30,
        }),
        expect.objectContaining({
          party: expect.objectContaining({ id: guest.output.id }),
          consumed: 30,
        }),
      ]),
    );

    const unknownReport = await projectContribution(ctx.db, {
      projectId: parseShortcodeFor("project", unknown.shortcode),
      includeSubprojects: true,
    });
    expect(unknownReport).toMatchObject({
      wholeGroupCost: 18,
      householdInitialExposure: 0,
      guestInitialFunding: 0,
      unattributedConsumption: 18,
      unattributedInitialFunding: 18,
      householdConsumed: 0,
      parties: [],
      funders: [],
    });
    expect(unknownReport.gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining([
        "missing_beneficiaries",
        "missing_funders",
        "partial_beneficiaries",
        "partial_funders",
      ]),
    );

    const ledger = await householdContributionLedger(ctx.db, {
      asOf: "2026-08-20",
    });
    expect(ledger.unattributed).toEqual({ consumption: 18, funding: 18 });
    expect(ledger.checks).toMatchObject({
      expenseTotal: 248,
      transferNet: 0,
    });
    expect(
      ledger.parties.find((row) => row.party.id === household.output.id),
    ).toMatchObject({
      consumed: 100,
      initiallyOutlaid: 160,
      transfersSent: 17,
      transfersReceived: 32,
      netContribution: 145,
      position: 45,
    });
    expect(
      ledger.parties.find((row) => row.party.id === first.output.id),
    ).toMatchObject({
      consumed: 70,
      initiallyOutlaid: 40,
      transfersSent: 23,
      transfersReceived: 5,
      netContribution: 58,
      position: -12,
    });
    expect(
      ledger.parties.find((row) => row.party.id === second.output.id),
    ).toMatchObject({ consumed: 30, netContribution: -3, position: -33 });
    expect(
      ledger.parties.find((row) => row.party.id === guest.output.id),
    ).toMatchObject({ consumed: 30, netContribution: 30, position: 0 });
    expect(ledger.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_beneficiaries", amount: 10 }),
        expect.objectContaining({ code: "missing_funders", amount: 10 }),
        expect.objectContaining({ code: "partial_beneficiaries", amount: 8 }),
        expect.objectContaining({ code: "partial_funders", amount: 8 }),
      ]),
    );
  });
});
