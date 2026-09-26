import {
  type FinancialAccountSourceAlias,
  financialAccountCreateInput,
} from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { testShortcode } from "@cubby/schemas/testing";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "./database-helpers";
import { createExpense } from "./expense";
import { getFilterOptions } from "./filter-options";
import {
  createFinancialAccount,
  financialAccountRepository,
  listFinancialAccounts,
  updateFinancialAccount,
} from "./financial-account";
import { previewFinancialStatementImport } from "./financial-statement-preview";
import {
  createFinancialTransaction,
  financialTransactionRepository,
  financialTransactionSourceOptions,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "./financial-transaction";
import { createLedgerParty } from "./ledger-party";
import { findFinancialTransactionAllocationDefects } from "./problems/detectors-financial";
import {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  linkExpensesToPurchase,
  mergePurchases,
  purchaseList,
} from "./purchase";
import { loadRelatedPreviews } from "./related-view";
import { resolveLiveShortcode } from "./shortcode-resolver";
import {
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "./statement-row";
import { findOrCreateVendor, getVendorByID, vendorList } from "./vendor";

function requireTestValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

const account = (name: string, aliases: FinancialAccountSourceAlias[] = []) =>
  financialAccountCreateInput.parse({
    name,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    cardNumbers: [
      {
        last4: "1234",
        kind: "primary",
        validFrom: null,
        validTo: null,
        note: null,
      },
    ],
    sourceAliases: aliases,
  });

describe("financial repositories — critical invariants", () => {
  const ctx = withTestDb();

  it("serializes concurrent account alias claims", async () => {
    const results = await Promise.allSettled([
      createFinancialAccount(
        ctx.db,
        account("Concurrent Visa A", [
          {
            source: "concurrency-test",
            alias: "Visa A",
            externalAccountId: "shared-account",
          },
        ]),
        ctx.actor,
      ),
      createFinancialAccount(
        ctx.db,
        account("Concurrent Visa B", [
          {
            source: "concurrency-test",
            alias: "Visa B",
            externalAccountId: "shared-account",
          },
        ]),
        ctx.actor,
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT",
      },
    });
  });

  it("serializes concurrent transaction source-reference claims", async () => {
    const createdAccount = (
      await createFinancialAccount(
        ctx.db,
        account("Concurrent transaction Visa"),
        ctx.actor,
      )
    ).output;
    const input = (amount: number) =>
      financialTransactionCreateInput.parse({
        accountId: createdAccount.id,
        kind: "purchase",
        status: "pending",
        amount,
        sourceRefs: [
          { source: "concurrency-test", externalId: "shared-transaction" },
        ],
      });

    const results = await Promise.allSettled([
      createFinancialTransaction(ctx.db, input(10), ctx.actor),
      createFinancialTransaction(ctx.db, input(20), ctx.actor),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT",
      },
    });
  });

  // Regression: these enum filters were built as sql`col = ANY(${array})`.
  // Drizzle expands a JS array in a template into a row constructor, so the
  // query went out as `= ANY(($1))` and postgres rejected it — every filtered
  // list 500'd, in both the single-value and the multi-value form.

  // Regression: `accountId`/`purchaseId` are `oneOrMany`, so a mixed batch of
  // real and bogus codes is reachable from the list API and MCP. This must
  // narrow to what resolves (matching every other list filter's
  // `resolveAllPresent` convention — locationList, productList) rather than
  // silently drop the bogus code AND rather than widen to an unfiltered
  // query. An all-bogus batch still yields nothing, same as before.

  // The two header-filter rosters. Both are load-bearing in a way a shape test
  // wouldn't catch: the account filter-option roster must emit SHORTCODES, because the
  // manifest's `accountId` spec brands option values with
  // Internal shortcode strings are parsed at the server boundary with
  // `oneOrMany(financialAccountShortcode)` — a uuid here would brand into a lie
  // and resolve to nothing. And `financialTransactionSourceOptions` is raw SQL
  // over a LATERAL unnest of `sourceRefs`, so its grouping, its per-row fan-out,
  // and its soft-delete predicate are only ever exercised against a real DB.
  it("builds the account and source rosters with live counts and shortcode ids", async () => {
    const busy = (
      await createFinancialAccount(
        ctx.db,
        account("Roster Busy Visa"),
        ctx.actor,
      )
    ).output;
    const quiet = (
      await createFinancialAccount(
        ctx.db,
        account("Roster Quiet Visa"),
        ctx.actor,
      )
    ).output;
    // Never linked to a transaction, then retired: proves a soft-deleted account
    // leaves the roster entirely rather than showing up with a zero count.
    const retired = (
      await createFinancialAccount(
        ctx.db,
        account("Roster Retired Visa"),
        ctx.actor,
      )
    ).output;
    await financialAccountRepository.delete(ctx.db, [retired.id], ctx.actor);

    const txn = (accountId: string, sources: string[], amount: number) =>
      createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId,
          kind: "purchase",
          status: "pending",
          amount,
          sourceRefs: sources.map((source, index) => ({
            source,
            externalId: `${source}-${accountId}-${amount}-${index}`,
          })),
        }),
        ctx.actor,
      );

    await txn(busy.id, ["monarch"], 10);
    // Two refs on ONE row — the count is per reference, not per transaction, so
    // this row contributes to both `monarch` and `amazon-order-export`.
    await txn(busy.id, ["monarch", "amazon-order-export"], 20);
    await txn(quiet.id, ["monarch"], 30);
    const doomed = (await txn(quiet.id, ["copilot"], 40)).output;

    const beforeDelete = await financialTransactionSourceOptions(ctx.db);
    expect(beforeDelete).toEqual([
      { source: "monarch", count: 3 },
      { source: "amazon-order-export", count: 1 },
      { source: "copilot", count: 1 },
    ]);

    // Busy leads on count; `quiet` and the zero-transaction accounts fall back to
    // name order. An account with no transactions still appears — a provisional
    // account minted by a statement import is exactly the one you want to filter
    // for before anything is linked to it.
    const accountRoster = async () =>
      (
        await getFilterOptions(ctx.db, {
          source: "entity",
          entity: "financialAccount",
          search: "",
          selectedIds: [],
          limit: 1000,
          include: ["count"],
        })
      ).items;
    const accounts = await accountRoster();
    expect(accounts).toEqual([
      { id: busy.id, label: "Roster Busy Visa", count: 2 },
      { id: quiet.id, label: "Roster Quiet Visa", count: 2 },
    ]);
    // The id is the shortcode the filter brands, not the uuid.
    expect(accounts[0]?.id).toMatch(/^FAC-/);

    await financialTransactionRepository.delete(ctx.db, [doomed.id], ctx.actor);
    expect(await financialTransactionSourceOptions(ctx.db)).toEqual([
      { source: "monarch", count: 3 },
      { source: "amazon-order-export", count: 1 },
    ]);
    expect(await accountRoster()).toEqual([
      { id: busy.id, label: "Roster Busy Visa", count: 2 },
      { id: quiet.id, label: "Roster Quiet Visa", count: 1 },
    ]);
  });

  // `oneOrMany`'s array branch has no `.min(1)`, so `[]` is valid filter input
  // and reaches the repo. It must mean "no constraint on that field" — never
  // "no constraint at all", which is what an empty cross-product silently
  // produced when it collapsed `or()` to undefined.

  it("previews client-parsed Monarch snapshots idempotently without writing", async () => {
    const createdAccount = (
      await createFinancialAccount(
        ctx.db,
        account("Monarch Visa", [
          {
            source: "monarch",
            alias: "Citi Double Cash (...1702)",
            externalAccountId: null,
          },
          // The same card as a second provider labels it. Alias resolution is
          // per-source, so without this a copilot row for this account resolves
          // to nothing.
          {
            source: "copilot",
            alias: "Citi Double Cash (...1702)",
            externalAccountId: null,
          },
        ]),
        ctx.actor,
      )
    ).output;
    const row = {
      key: "row-1",
      source: "monarch",
      account: "Citi Double Cash (...1702)",
      date: "2026-07-31",
      amount: -54.29,
      merchant: "Amazon",
      originalStatement: "AMZN Mktp",
      category: "Shopping",
      notes: null,
    } satisfies Parameters<
      typeof previewFinancialStatementImport
    >[1]["rows"][number];
    const first = await previewFinancialStatementImport(ctx.db, {
      rows: [row],
    });
    expect(first.rows[0]).toMatchObject({
      status: "ready_to_create",
      accountId: createdAccount.id,
      provisionalAccount: null,
      proposed: { amount: 54.29, kind: "purchase", status: "posted" },
    });
    expect(first.rows[0]?.existingTransactionIds).toEqual([]);

    const proposed = requireTestValue(
      first.rows[0],
      "Expected the first Monarch preview row.",
    ).proposed;
    const createdEvidence = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: createdAccount.id,
        purchaseId: null,
        kind: proposed.kind,
        status: proposed.status,
        amount: proposed.amount,
        transactionDate: proposed.transactionDate,
        postedDate: proposed.postedDate,
        merchant: proposed.merchant,
        rawDescription: proposed.rawDescription,
        sourceCategory: proposed.sourceCategory,
        sourceRefs: [proposed.sourceRef],
        notes: proposed.notes,
      }),
      ctx.actor,
    );
    const laterExport = await previewFinancialStatementImport(ctx.db, {
      rows: [{ ...row, merchant: "Amazon.com", category: "Other" }],
    });
    expect(laterExport.rows[0]?.status).toBe("already_recorded");

    const changedIdentity = await previewFinancialStatementImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "corrected-statement",
          originalStatement: "AMZN MKTP CORRECTED",
        },
      ],
    });
    expect(changedIdentity.rows[0]).toMatchObject({
      status: "possible_existing",
    });

    await updateFinancialTransaction(
      ctx.db,
      createdEvidence.output.id,
      { postedDate: "2026-07-29" },
      ctx.actor,
    );
    const correctedDateExport = await previewFinancialStatementImport(ctx.db, {
      rows: [{ ...row, key: "corrected-date" }],
    });
    expect(correctedDateExport.rows[0]?.status).toBe("already_recorded");

    const manualEvidence = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: createdAccount.id,
          kind: "purchase",
          status: "posted",
          amount: 12.34,
          postedDate: "2026-07-30",
          rawDescription: "MANUAL STATEMENT LINE",
        }),
        ctx.actor,
      )
    ).output;
    const possibleExisting = await previewFinancialStatementImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "possible-existing",
          date: "2026-07-30",
          amount: -12.34,
          originalStatement: "MANUAL STATEMENT LINE",
        },
      ],
    });
    expect(possibleExisting.rows[0]).toMatchObject({
      status: "possible_existing",
      existingTransactionIds: [manualEvidence.id],
    });

    const identityAccount = (
      await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name: "Identity-only Visa",
          identity: { kind: "credit_card", issuer: null, network: "visa" },
          // A reissued card: the provider may still label the account with
          // the retired digits, so both must resolve here.
          cardNumbers: [
            {
              last4: "9999",
              kind: "primary",
              validFrom: null,
              validTo: "2024-06-30",
              note: null,
            },
            {
              last4: "9997",
              kind: "primary",
              validFrom: "2024-07-01",
              validTo: null,
              note: null,
            },
          ],
        }),
        ctx.actor,
      )
    ).output;
    for (const digits of ["9999", "9997"]) {
      const identityResolved = await previewFinancialStatementImport(ctx.db, {
        rows: [
          {
            ...row,
            key: `identity-only-account-${digits}`,
            account: `Unmapped Visa (...${digits})`,
            originalStatement: "IDENTITY-ONLY LINE",
          },
        ],
      });
      expect(identityResolved.rows[0]).toMatchObject({
        status: "ready_to_create",
        accountId: identityAccount.id,
      });
    }

    // Two live accounts carrying the same digits: last four alone is not
    // unique, so the row stays unresolved rather than guessing.
    await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "Sibling Visa",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        cardNumbers: [
          {
            last4: "9997",
            kind: "supplementary",
            validFrom: null,
            validTo: null,
            note: null,
          },
        ],
      }),
      ctx.actor,
    );
    const ambiguous = await previewFinancialStatementImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "ambiguous-digits",
          account: "Unmapped Visa (...9997)",
          originalStatement: "AMBIGUOUS LINE",
        },
      ],
    });
    expect(ambiguous.rows[0]).toMatchObject({
      status: "unresolved_account",
      accountId: null,
    });

    const duplicates = await previewFinancialStatementImport(ctx.db, {
      rows: [row, { ...row, key: "row-2" }],
    });
    expect(duplicates.rows.map((item) => item.status)).toEqual([
      "indistinguishable_duplicate",
      "indistinguishable_duplicate",
    ]);

    const unresolved = await previewFinancialStatementImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "unknown-account",
          account: "Unmapped Visa (...9998)",
          originalStatement: "OTHER MERCHANT",
        },
      ],
    });
    expect(unresolved.rows[0]).toMatchObject({
      status: "unresolved_account",
      accountId: null,
      provisionalAccount: {
        name: "Unmapped Visa (...9998)",
        provisional: true,
        identity: { kind: "credit_card", network: "visa" },
        cardNumbers: [{ last4: "9998", kind: "primary" }],
      },
    });

    // The identical charge as a *second* provider sees it. The ref is namespaced
    // by source, so this is a distinguishable row rather than a false
    // `already_recorded` — 19% of charges present in two exports carry different
    // dates, so collapsing them would destroy the cross-corroboration that makes
    // "absent from both" usable evidence.
    const otherProvider = await previewFinancialStatementImport(ctx.db, {
      rows: [{ ...row, key: "copilot-view", source: "copilot" }],
    });
    expect(otherProvider.rows[0]?.status).toBe("ready_to_create");
    expect(otherProvider.rows[0]?.proposed.sourceRef).toMatchObject({
      source: "copilot",
    });
    expect(otherProvider.rows[0]?.proposed.sourceRef.externalId).not.toBe(
      proposed.sourceRef.externalId,
    );

    // Both providers' refs can live on one transaction: uniqueness is per
    // (source, externalId) pair, not per externalId.
    const merged = await updateFinancialTransaction(
      ctx.db,
      createdEvidence.output.id,
      {
        sourceRefs: [
          proposed.sourceRef,
          requireTestValue(
            otherProvider.rows[0],
            "Expected the Copilot preview row.",
          ).proposed.sourceRef,
        ],
      },
      ctx.actor,
    );
    expect(merged.output.sourceRefs).toHaveLength(2);

    const bothRecorded = await previewFinancialStatementImport(ctx.db, {
      rows: [
        { ...row, key: "monarch-again" },
        { ...row, key: "copilot-again", source: "copilot" },
      ],
    });
    expect(bothRecorded.rows.map((item) => item.status)).toEqual([
      "already_recorded",
      "already_recorded",
    ]);
    // One transaction carrying two matching refs must still be reported once.
    expect(bothRecorded.rows[0]?.existingTransactionIds).toEqual([
      createdEvidence.output.id,
    ]);
  });

  it("batches distinct purchase previews and filters linked finance data", async () => {
    const createdAccount = (
      await createFinancialAccount(ctx.db, account("Preview Visa"), ctx.actor)
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Preview Vendor");
    const previewVendor = await getVendorByID(ctx.db, vendorId);
    const previewPurchase = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: previewVendor.id,
          orderId: "PREVIEW-1",
        }),
        ctx.actor,
      )
    ).output;
    const expenses = [];
    for (let index = 0; index < 4; index += 1) {
      expenses.push(
        (
          await createExpense(
            ctx.db,
            expenseCreateInput.parse({
              date: "2024-01-15",
              name: `preview line ${index}`,
              trade: "other",
              costType: "materials",
              cost: index + 1,
              purchaseId: previewPurchase.id,
              future: false,
            }),
            ctx.actor,
          )
        ).output,
      );
    }
    const activeTransaction = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: createdAccount.id,
          purchaseId: previewPurchase.id,
          kind: "purchase",
          status: "posted",
          postedDate: "2026-02-01",
          merchant: "Preview merchant",
          amount: 10,
        }),
        ctx.actor,
      )
    ).output;
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: createdAccount.id,
        purchaseId: previewPurchase.id,
        kind: "adjustment",
        status: "void",
        merchant: "Voided preview evidence",
        amount: 1,
      }),
      ctx.actor,
    );

    const previews = await loadRelatedPreviews(ctx.db, {
      source: "purchase",
      sourceIds: [previewPurchase.id],
      relationKeys: ["purchase.expenses", "purchase.transactions"],
    });
    expect(
      previews.find((group) => group.relationKey === "purchase.expenses"),
    ).toMatchObject({ totalCount: 4, items: expect.any(Array) });
    expect(
      previews.find((group) => group.relationKey === "purchase.expenses")
        ?.items,
    ).toHaveLength(3);
    expect(
      previews.find((group) => group.relationKey === "purchase.transactions")
        ?.totalCount,
    ).toBe(2);

    const byExpense = await purchaseList(
      ctx.db,
      {
        expenseId: requireTestValue(
          expenses[0],
          "Expected a seeded preview expense.",
        ).id,
      },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(byExpense.data.map((row) => row.id)).toContain(previewPurchase.id);
    const byTransactionSearch = await purchaseList(
      ctx.db,
      { financialTransactionSearch: "Preview merchant" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(byTransactionSearch.data.map((row) => row.id)).toContain(
      previewPurchase.id,
    );
    const byTransactionId = await purchaseList(
      ctx.db,
      { financialTransactionId: activeTransaction.id },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(byTransactionId.data.map((row) => row.id)).toContain(
      previewPurchase.id,
    );

    const vendorsByExpense = await vendorList(
      ctx.db,
      { expenseSearch: "preview line 2" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(vendorsByExpense.data.map((row) => row.id)).toContain(
      previewVendor.id,
    );
    const accountsByTransaction = await listFinancialAccounts(
      ctx.db,
      { financialTransactionSearch: "Preview merchant" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(accountsByTransaction.data.map((row) => row.id)).toContain(
      createdAccount.id,
    );
    const transactionsByExpense = await listFinancialTransactions(
      ctx.db,
      { expenseSearch: "preview line 3" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(transactionsByExpense.data.map((row) => row.id)).toContain(
      activeTransaction.id,
    );
  });

  /**
   * `StatementRow.accountId` is declared `block` in
   * FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY, and it is the one edge in the
   * lifecycle registry that fails OPEN. The FK is nullable, so a missing guard
   * does not throw — the account simply vanishes while live triaged rows keep
   * pointing at it, silently discarding the triage judgment that put them
   * there. The comment on the guard records that this check was declared with
   * nothing enforcing it once already ("neither this guard nor the preview
   * queried the table") and was fixed with no regression test. Zero accounts
   * have ever been deleted in production, so the path has never run for real.
   *
   * Deliberately a separate account from the transactions test below: reusing
   * that one would trip `FINANCIAL_ACCOUNT_HAS_TRANSACTIONS` first and leave
   * this policy unexercised.
   */
  it("blocks account deletion while a live statement row still points at it", async () => {
    const acct = (
      await createFinancialAccount(
        ctx.db,
        account("Statement-blocked"),
        ctx.actor,
      )
    ).output;
    await recordStatementRows(
      ctx.db,
      recordStatementRowsInput.parse({
        import: {
          source: "monarch",
          label: "block-guard.csv",
          fingerprint: "fp-block-guard",
          dateKind: "transaction",
          rowCountDeclared: 1,
          notes: null,
        },
        rows: [
          {
            accountDescriptor: "Blocked Card",
            statementDate: "2026-05-04",
            providerAmount: -10,
            merchant: "Acme",
            rawDescription: "ACME",
            sourceCategory: null,
            providerStatus: "posted",
            providerNotes: null,
          },
        ],
        dryRun: false,
      }),
      ctx.actor,
    );
    const row = (await listStatementRows(ctx.db, {})).data[0];
    expect(row).toBeDefined();
    await updateStatementRows(
      ctx.db,
      {
        selector: { source: "monarch", externalIds: [row!.externalId] },
        data: { accountId: acct.id },
      },
      ctx.actor,
    );

    await expect(
      financialAccountRepository.delete(ctx.db, [acct.id], ctx.actor),
    ).rejects.toMatchObject({
      reason: "ENTITY_DELETE_BLOCKED",
    });
    // The child survives with its triage intact — the half a fail-open guard
    // would destroy.
    const stillThere = (await listStatementRows(ctx.db, {})).data[0];
    expect(stillThere?.accountId).toBe(acct.id);

    // Clearing the blocker lets the same delete through, so the guard is
    // narrow rather than a blanket refusal.
    await updateStatementRows(
      ctx.db,
      {
        selector: { source: "monarch", externalIds: [row!.externalId] },
        data: { accountId: null },
      },
      ctx.actor,
    );
    await expect(
      financialAccountRepository.delete(ctx.db, [acct.id], ctx.actor),
    ).resolves.toBeDefined();
  });

  it("blocks account deletion, rejects cross-row source collisions, and preserves purchase-only updates", async () => {
    const a = (
      await createFinancialAccount(
        ctx.db,
        account("Visa", [
          { source: "statement", alias: "Visa", externalAccountId: "acct-1" },
        ]),
        ctx.actor,
      )
    ).output;
    await expect(
      createFinancialAccount(
        ctx.db,
        account("Duplicate", [
          { source: "statement", alias: "Other", externalAccountId: "acct-1" },
        ]),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT",
    });
    const vendorId = await findOrCreateVendor(ctx.db, "Finance test vendor");
    const purchase = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: (await getVendorByID(ctx.db, vendorId)).id,
          orderId: "finance-1",
        }),
        ctx.actor,
      )
    ).output;
    const tx = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: purchase.id,
          kind: "purchase",
          status: "pending",
          amount: 10,
          sourceRefs: [{ source: "statement", externalId: "tx-1" }],
        }),
        ctx.actor,
      )
    ).output;
    await expect(
      financialAccountRepository.delete(ctx.db, [a.id], ctx.actor),
    ).rejects.toMatchObject({
      reason: "ENTITY_DELETE_BLOCKED",
    });
    await expect(
      createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          kind: "purchase",
          status: "pending",
          amount: 10,
          sourceRefs: [{ source: "statement", externalId: "tx-1" }],
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT",
    });
    await expect(
      updateFinancialTransaction(
        ctx.db,
        tx.id,
        { status: "posted" },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED",
    });
    const updated = await updateFinancialTransaction(
      ctx.db,
      tx.id,
      { purchaseId: null },
      ctx.actor,
    );
    expect(updated.output.purchaseId).toBeNull();

    for (const filters of [
      { accountId: testShortcode("financialAccount", "FAC-2222") },
      { purchaseId: testShortcode("purchase", "PUR-2222") },
    ]) {
      const filtered = await listFinancialTransactions(ctx.db, filters, [], {
        pageIndex: 0,
        pageSize: 100,
      });
      expect(filtered).toMatchObject({ data: [], count: 0 });
    }
  });

  it("reconciles settlement separately from Expense spend and re-points/detaches transactions", async () => {
    const a = (
      await createFinancialAccount(ctx.db, account("Reconcile Visa"), ctx.actor)
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Reconcile Vendor");
    const { getVendorByID } = await import("./vendor");
    const vendor = await getVendorByID(ctx.db, vendorId);
    const p1 = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendor.id,
          orderId: null,
        }),
        ctx.actor,
      )
    ).output;
    const p2 = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendor.id,
          orderId: "settle-2",
        }),
        ctx.actor,
      )
    ).output;
    const expense = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        name: "settlement line",
        trade: "other",
        costType: "materials",
        cost: 10,
        vendor: "Reconcile Vendor",
        orderId: null,
        future: false,
      }),
      ctx.actor,
    );
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: p1.id, expenseIds: [expense.output.id] },
      ctx.actor,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: p1.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-01",
        amount: 10,
      }),
      ctx.actor,
    );
    const p1Uuid = parseEntityId(
      "purchase",
      requireTestValue(
        await resolveLiveShortcode(ctx.db, p1.id, "purchase"),
        "Expected the first purchase shortcode to resolve.",
      ),
    );
    expect(
      (await getPurchaseByID(ctx.db, p1Uuid)).financialReconciliation.status,
    ).toBe("match");
    await mergePurchases(
      ctx.db,
      { keepId: p1.id, mergeIds: [p2.id] },
      ctx.actor,
    );
    await deletePurchases(ctx.db, [p1.id], ctx.actor);
    const txs = await (
      await import("./financial-transaction")
    ).listFinancialTransactions(
      ctx.db,
      { purchasePresenceFilter: "none" },
      [],
      {
        pageIndex: 0,
        pageSize: 100,
      },
    );
    expect(txs.data.some((row) => row.purchaseId === null)).toBe(true);
  });

  it("reports unknown, pending, and mismatch in cents while excluding void and deleted evidence", async () => {
    const a = (
      await createFinancialAccount(ctx.db, account("Status Visa"), ctx.actor)
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Status Vendor");
    const vendor = await getVendorByID(ctx.db, vendorId);

    const makePurchaseWithExpense = async (
      orderId: string,
      cost: number | null,
    ) => {
      const purchase = (
        await createPurchase(
          ctx.db,
          purchaseCreateInput.parse({
            date: "2024-01-15",
            vendorId: vendor.id,
            orderId,
          }),
          ctx.actor,
        )
      ).output;
      const line = await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          name: `line ${orderId}`,
          trade: "other",
          costType: "materials",
          cost,
          vendor: vendor.name,
          orderId,
          future: false,
        }),
        ctx.actor,
      );
      await linkExpensesToPurchase(
        ctx.db,
        { purchaseId: purchase.id, expenseIds: [line.output.id] },
        ctx.actor,
      );
      const uuid = parseEntityId(
        "purchase",
        requireTestValue(
          await resolveLiveShortcode(ctx.db, purchase.id, "purchase"),
          "Expected the purchase shortcode to resolve.",
        ),
      );
      return { purchase, uuid };
    };

    const unknown = await makePurchaseWithExpense("status-unknown", 10);
    expect(
      (await getPurchaseByID(ctx.db, unknown.uuid)).financialReconciliation,
    ).toMatchObject({ status: "unknown", delta: null, transactionCount: 0 });

    const unpriced = await makePurchaseWithExpense("status-unpriced", null);
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: unpriced.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-01",
        amount: 5,
      }),
      ctx.actor,
    );
    expect(
      (await getPurchaseByID(ctx.db, unpriced.uuid)).financialReconciliation,
    ).toMatchObject({ status: "unknown", delta: null, transactionCount: 1 });

    // A payment schedule part-way through: one payment posted, one still
    // planned. Settlement must compare against the INCURRED expense only —
    // a `future: true` row cannot have settled, so counting it would report a
    // mismatch for a purchase behaving exactly as intended.
    const schedule = await makePurchaseWithExpense("status-schedule", 100);
    const plannedLine = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2027-01-15",
        name: "status-schedule planned payment",
        trade: "other",
        costType: "materials",
        cost: 400,
        future: true,
      }),
      ctx.actor,
    );
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: schedule.purchase.id, expenseIds: [plannedLine.output.id] },
      ctx.actor,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: schedule.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-01",
        amount: 100,
      }),
      ctx.actor,
    );
    const scheduled = await getPurchaseByID(ctx.db, schedule.uuid);
    // The displayed total still carries the whole commitment...
    expect(scheduled.expenseTotal).toBe(500);
    // ...but settlement only answers for the $100 actually incurred.
    expect(scheduled.financialReconciliation).toMatchObject({
      status: "match",
      delta: 0,
      postedTotal: 100,
    });

    const pending = await makePurchaseWithExpense("status-pending", 51.49);
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: pending.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-01",
        amount: 60.56,
      }),
      ctx.actor,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: pending.purchase.id,
        kind: "refund",
        status: "expected",
        transactionDate: "2026-01-02",
        amount: -9.07,
      }),
      ctx.actor,
    );
    expect(
      (await getPurchaseByID(ctx.db, pending.uuid)).financialReconciliation,
    ).toMatchObject({
      status: "pending",
      postedTotal: 60.56,
      projectedTotal: 51.49,
      postedRefundTotal: 0,
      outstandingTransactionCount: 1,
    });

    const adjusted = await makePurchaseWithExpense(
      "status-refund-adjusted",
      199.26,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: adjusted.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-03",
        amount: 326.36,
      }),
      ctx.actor,
    );
    const refunds = [
      { postedDate: "2026-01-04", amount: -100 },
      { postedDate: "2026-01-05", amount: -27.1 },
    ];
    for (const { postedDate, amount } of refunds) {
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: adjusted.purchase.id,
          kind: "refund",
          status: "posted",
          postedDate,
          amount,
        }),
        ctx.actor,
      );
    }
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: adjusted.purchase.id,
        kind: "refund",
        status: "void",
        amount: -999,
      }),
      ctx.actor,
    );
    const deletedRefund = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: adjusted.purchase.id,
          kind: "refund",
          status: "posted",
          postedDate: "2026-01-06",
          amount: -999,
        }),
        ctx.actor,
      )
    ).output;
    await financialTransactionRepository.delete(
      ctx.db,
      [deletedRefund.id],
      ctx.actor,
    );
    const adjustedReconciliation = (
      await getPurchaseByID(ctx.db, adjusted.uuid)
    ).financialReconciliation;
    expect(adjustedReconciliation).toMatchObject({
      status: "match",
      postedRefundTotal: -127.1,
      transactionCount: 3,
    });
    expect(adjustedReconciliation.postedTotal).toBeCloseTo(199.26);
    expect(adjustedReconciliation.projectedTotal).toBeCloseTo(199.26);

    const mismatch = await makePurchaseWithExpense("status-mismatch", 10);
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: a.id,
        purchaseId: mismatch.purchase.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-01-03",
        amount: 12,
      }),
      ctx.actor,
    );
    const voided = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: mismatch.purchase.id,
          kind: "adjustment",
          status: "void",
          amount: 999,
        }),
        ctx.actor,
      )
    ).output;
    const deleted = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: mismatch.purchase.id,
          kind: "adjustment",
          status: "posted",
          postedDate: "2026-01-04",
          amount: -2,
        }),
        ctx.actor,
      )
    ).output;
    await financialTransactionRepository.delete(
      ctx.db,
      [deleted.id],
      ctx.actor,
    );
    const result = await getPurchaseByID(ctx.db, mismatch.uuid);
    expect(result.expenseTotal).toBe(10);
    expect(result.financialReconciliation).toMatchObject({
      status: "mismatch",
      transactionCount: 1,
      postedTotal: 12,
      projectedTotal: 12,
      delta: 2,
    });
    expect(voided.status).toBe("void");
  });

  it("settles a disposal with an income payout and holds the sign rule on every path", async () => {
    const a = (
      await createFinancialAccount(
        ctx.db,
        account("Payout Checking"),
        ctx.actor,
      )
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Payout Marketplace");
    const vendor = await getVendorByID(ctx.db, vendorId);

    // A disposal: a Purchase whose Expense is negative, settled net of fees.
    const sale = (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2026-07-13",
          vendorId: vendor.id,
          orderId: "payout-sale-1",
          statedTotal: -140.22,
        }),
        ctx.actor,
      )
    ).output;
    const proceeds = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2026-07-13",
        name: "nailer selling",
        trade: "other",
        costType: "tools",
        cost: -140.22,
        vendor: vendor.name,
        orderId: "payout-sale-1",
        future: false,
      }),
      ctx.actor,
    );
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: sale.id, expenseIds: [proceeds.output.id] },
      ctx.actor,
    );
    const saleUuid = parseEntityId(
      "purchase",
      requireTestValue(
        await resolveLiveShortcode(ctx.db, sale.id, "purchase"),
        "Expected the sale purchase shortcode to resolve.",
      ),
    );

    // The payout is an inflow recorded as income, and it may link.
    const payout = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: a.id,
          purchaseId: sale.id,
          kind: "income",
          status: "posted",
          postedDate: "2026-07-16",
          amount: -140.22,
          sourceRefs: [{ source: "statement", externalId: "payout-1" }],
        }),
        ctx.actor,
      )
    ).output;
    expect(payout.purchaseId).toBe(sale.id);

    const settled = await getPurchaseByID(ctx.db, saleUuid);
    expect(settled.financialReconciliation).toMatchObject({
      status: "match",
      delta: 0,
      postedTotal: -140.22,
      transactionCount: 1,
      // income is settlement evidence but never a refund — keeping these apart
      // is why the payout is not filed as kind "refund".
      postedRefundTotal: 0,
    });
    expect(settled.reconciliation).toBe("match");

    // Update path: a linked payout may not flip to an outflow. This path is
    // guarded only by the repo check — the update schema carries no refinement.
    await expect(
      updateFinancialTransaction(
        ctx.db,
        payout.id,
        { amount: 140.22 },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    // Update path: a kind outside the allowlist may not stay linked.
    await expect(
      updateFinancialTransaction(ctx.db, payout.id, { kind: "fee" }, ctx.actor),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    // The last line of defence when app validation is bypassed used to be a DB
    // CHECK. It was dropped with the `purchaseId` column it read: once "is this
    // linked" became a question about another table, a row-level CHECK could no
    // longer ask it. So a raw UPDATE now SUCCEEDS — and the detector is what
    // catches it. That is a real reduction in enforcement, and this asserts the
    // replacement actually fires rather than quietly assuming it does.
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "amount" = 140.22 WHERE "shortcode" = ${payout.id}`,
    );
    const defects = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(
      defects.find((defect) => defect.id === payout.id)?.reasons,
    ).toContain("kind-sign-violation");
  });

  // Two members can each hold their own store credit at one vendor; settlement
  // resolves a gift-card leg by (provider vendor, owner), so that pair must
  // stay unique among live accounts and the provider must mean stored value.
  it("keys stored-value accounts by provider vendor and owner", async () => {
    const vendor = await getVendorByID(
      ctx.db,
      await findOrCreateVendor(ctx.db, "Stored Value Vendor"),
    );
    const member = async (name: string) =>
      requireTestValue(
        (
          await createLedgerParty(
            ctx.db,
            { name, kind: "member", notes: null },
            ctx.actor,
          )
        ).output,
        "expected member",
      ).id;
    const [memberA, memberB] = [
      await member("Stored Value Member A"),
      await member("Stored Value Member B"),
    ];
    const storedValue = (name: string, owner: string | null) =>
      createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name,
          identity: { kind: "stored_value", provider: "Synthetic store" },
          providerVendorId: vendor.id,
          ledgerPartyId: owner,
        }),
        ctx.actor,
      );

    const a = (await storedValue("Credit A", memberA)).output;
    const b = (await storedValue("Credit B", memberB)).output;
    const shared = (await storedValue("Shared card", null)).output;
    expect(a.providerVendorId).toBe(vendor.id);
    expect(a.providerVendorName).toBe("Stored Value Vendor");

    await expect(storedValue("Credit A again", memberA)).rejects.toMatchObject({
      cause: { constraint: "FinancialAccount_provider_owner_key" },
    });
    // Null owners stay distinct, so a second household card is allowed.
    await expect(storedValue("Shared card 2", null)).resolves.toBeDefined();

    await expect(
      createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          ...account("Provider on a credit card"),
          providerVendorId: vendor.id,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/stored-value account/);
    await expect(
      updateFinancialAccount(
        ctx.db,
        b.id,
        { identity: { kind: "cash" } },
        ctx.actor,
      ),
    ).rejects.toThrow(/stored-value account/);

    for (const [owner, expected] of [
      [memberA, [a.id]],
      [memberB, [b.id]],
    ] as const) {
      const resolved = await listFinancialAccounts(
        ctx.db,
        { providerVendorId: [vendor.id], ledgerPartyId: [owner] },
        [],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(resolved.data.map((row) => row.id)).toEqual(expected);
    }

    // Soft-deleting frees the pair for a replacement account.
    await financialAccountRepository.delete(ctx.db, [a.id], ctx.actor);
    await expect(storedValue("Credit A new", memberA)).resolves.toBeDefined();
    expect(shared.ledgerPartyId).toBeNull();
  });
});
