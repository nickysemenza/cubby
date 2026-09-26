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
  financialTransactionRepository,
  updateFinancialTransaction,
} from "~/server/repo/financial-transaction";
import {
  createLedgerParty,
  deleteLedgerParties,
  mergeLedgerParties,
  updateLedgerParty,
} from "~/server/repo/ledger-party";
import {
  createLedgerTransfer,
  ledgerTransferRepository,
  getLedgerTransferByShortcode,
  updateLedgerTransfer,
} from "~/server/repo/ledger-transfer";
import { makeExpenseInput } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";

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
          cardNumbers: [],
          provisional: false,
          sourceAliases: [],
          ledgerPartyId: guest.output.id,
          providerVendorId: null,
          inventoryOwnerDefaultEnabled: false,
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
    expect(transfer.output).toMatchObject({
      fromPartyName: member.output.name,
      toPartyName: otherMember.output.name,
    });
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
    ).rejects.toThrow("Cannot delete ledger party:");
    await expect(
      financialTransactionRepository.delete(
        ctx.db,
        [parseShortcodeFor("financialTransaction", inflow.shortcode)],
        ctx.actor,
      ),
    ).rejects.toThrow("cannot be deleted until the transfer releases it");
    await ledgerTransferRepository.delete(
      ctx.db,
      [transfer.output!.id],
      ctx.actor,
    );
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
    ).resolves.toMatchObject({ deleted: 1 });
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

    await expect(
      mergeLedgerParties(
        ctx.db,
        { keepId: keep.output.id, mergeIds: [keep.output.id] },
        ctx.actor,
      ),
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
      reason: "CONSTRAINT_VIOLATION",
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
      reason: "CONSTRAINT_VIOLATION",
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

  it("keeps a non-null fromPartyName after the from-party is soft-deleted", async () => {
    const from = await party("Soft-deleted transfer party", "guest");
    const to = await party("Soft-deleted transfer counterpart", "guest");
    const created = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: from.output.id,
        toPartyId: to.output.id,
        amount: 5,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [],
        evidenceTransactionIds: [],
      },
      ctx.actor,
    );
    if (!created.output) throw new Error("expected transfer output");

    // Bypasses `deleteLedgerParties`'s live-transfer guard on purpose: this
    // simulates a party soft-deleted through some other path while its
    // transfer stays live — exactly the latent-NULL case `fromPartyName`'s
    // read query used to be exposed to (see `includes-deleted` comment on
    // its subquery in ledger-transfer.ts).
    await unwrapDb(ctx.db)
      .update(ledgerParty)
      .set({ deletedAt: new Date() })
      .where(eq(ledgerParty.id, from.entityId));

    const reread = await getLedgerTransferByShortcode(
      ctx.db,
      created.output.id,
    );
    expect(reread?.fromPartyName).toBe(from.output.name);
  });
});
