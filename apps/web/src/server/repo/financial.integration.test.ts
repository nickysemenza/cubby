import type { FinancialAccountFilters } from "@cubby/schemas/financial-account";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import type { FinancialTransactionFilters } from "@cubby/schemas/financial-transaction";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import {
  unsafeFinancialAccountShortcode,
  unsafePurchaseId,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { relatedViewRegistry } from "@cubby/schemas/related-view";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "./expense";
import {
  createFinancialAccount,
  deleteFinancialAccounts,
  listFinancialAccounts,
  updateFinancialAccount,
} from "./financial-account";
import { previewFinancialStatementImport } from "./financial-statement-preview";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "./financial-transaction";
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
import { findOrCreateVendor, getVendorByID, vendorList } from "./vendor";

const account = (
  name: string,
  aliases = [] as {
    source: string;
    alias: string;
    externalAccountId: string | null;
  }[],
) =>
  financialAccountCreateInput.parse({
    name,
    identity: {
      kind: "credit_card",
      issuer: null,
      network: "visa",
      last4: "1234",
    },
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
        cause: { reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT" },
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
        cause: { reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT" },
      },
    });
  });

  // Regression: these enum filters were built as sql`col = ANY(${array})`.
  // Drizzle expands a JS array in a template into a row constructor, so the
  // query went out as `= ANY(($1))` and postgres rejected it — every filtered
  // list 500'd, in both the single-value and the multi-value form.
  it("filters transactions and accounts by enum sets in single and array form", async () => {
    const createdAccount = (
      await createFinancialAccount(
        ctx.db,
        account("Enum filter Visa"),
        ctx.actor,
      )
    ).output;
    const page = { pageIndex: 0, pageSize: 100 };
    for (const [kind, amount] of [
      ["purchase", 42],
      ["refund", -7],
    ] as const) {
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: createdAccount.id,
          kind,
          status: "pending",
          amount,
        }),
        ctx.actor,
      );
    }

    const kindForms: FinancialTransactionFilters["kind"][] = [
      "purchase",
      ["purchase"],
    ];
    for (const kind of kindForms) {
      const filtered = await listFinancialTransactions(
        ctx.db,
        { accountId: createdAccount.id, kind },
        [],
        page,
      );
      expect(filtered.count).toBe(1);
      expect(filtered.data.map((row) => row.kind)).toEqual(["purchase"]);
    }

    const bothKinds = await listFinancialTransactions(
      ctx.db,
      { accountId: createdAccount.id, kind: ["purchase", "refund"] },
      [],
      page,
    );
    expect(bothKinds.count).toBe(2);

    const statusForms: FinancialTransactionFilters["status"][] = [
      "pending",
      ["pending", "posted"],
    ];
    for (const status of statusForms) {
      const filtered = await listFinancialTransactions(
        ctx.db,
        { accountId: createdAccount.id, status },
        [],
        page,
      );
      expect(filtered.count).toBe(2);
    }
    const posted = await listFinancialTransactions(
      ctx.db,
      { accountId: createdAccount.id, status: "posted" },
      [],
      page,
    );
    expect(posted).toMatchObject({ data: [], count: 0 });

    // Same trap on the account list, where the filter is a jsonb expression.
    const identityKindForms: FinancialAccountFilters["identityKind"][] = [
      "credit_card",
      ["credit_card", "bank_account"],
    ];
    for (const identityKind of identityKindForms) {
      const accounts = await listFinancialAccounts(
        ctx.db,
        { identityKind, search: "Enum filter Visa" },
        [],
        page,
      );
      expect(accounts.data.map((row) => row.id)).toEqual([createdAccount.id]);
    }
    const otherKind = await listFinancialAccounts(
      ctx.db,
      { identityKind: ["bank_account"], search: "Enum filter Visa" },
      [],
      page,
    );
    expect(otherKind).toMatchObject({ data: [], count: 0 });
  });

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
        ]),
        ctx.actor,
      )
    ).output;
    const row = {
      key: "row-1",
      source: "monarch" as const,
      account: "Citi Double Cash (...1702)",
      date: "2026-07-31",
      amount: -54.29,
      merchant: "Amazon",
      originalStatement: "AMZN Mktp",
      category: "Shopping",
      notes: null,
    };
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

    const proposed = first.rows[0]!.proposed;
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
          identity: {
            kind: "credit_card",
            issuer: null,
            network: "visa",
            last4: "9999",
          },
        }),
        ctx.actor,
      )
    ).output;
    const identityResolved = await previewFinancialStatementImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "identity-only-account",
          account: "Unmapped Visa (...9999)",
          originalStatement: "IDENTITY-ONLY LINE",
        },
      ],
    });
    expect(identityResolved.rows[0]).toMatchObject({
      status: "ready_to_create",
      accountId: identityAccount.id,
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
        identity: { kind: "credit_card", network: "visa", last4: "9998" },
      },
    });
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
      { expenseId: expenses[0]!.id },
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

  it("keeps every curated preview path executable", async () => {
    for (const source of new Set(
      relatedViewRegistry.map((view) => view.source),
    )) {
      const groups = await loadRelatedPreviews(ctx.db, {
        source,
        sourceIds: ["NO-SUCH-SHORTCODE"],
        relationKeys: relatedViewRegistry
          .filter((view) => view.source === source)
          .map((view) => view.key),
      });
      expect(groups).toEqual([]);
    }
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
      cause: { reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT" },
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
      deleteFinancialAccounts(ctx.db, [a.id], ctx.actor),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_ACCOUNT_HAS_TRANSACTIONS" },
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
      cause: { reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT" },
    });
    await expect(
      updateFinancialTransaction(
        ctx.db,
        tx.id,
        { status: "posted" },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED" },
    });
    const updated = await updateFinancialTransaction(
      ctx.db,
      tx.id,
      { purchaseId: null },
      ctx.actor,
    );
    expect(updated.output.purchaseId).toBeNull();

    for (const filters of [
      { accountId: unsafeFinancialAccountShortcode("FAC-2222") },
      { purchaseId: unsafePurchaseShortcode("PUR-2222") },
    ]) {
      const filtered = await listFinancialTransactions(ctx.db, filters, [], {
        pageIndex: 0,
        pageSize: 100,
      });
      expect(filtered).toMatchObject({ data: [], count: 0 });
    }
  });

  it("rejects source-evidence collisions introduced through either update path", async () => {
    const accountA = (
      await createFinancialAccount(
        ctx.db,
        account("Update alias source", [
          {
            source: "update-test",
            alias: "Primary card",
            externalAccountId: "account-shared",
          },
        ]),
        ctx.actor,
      )
    ).output;
    const accountB = (
      await createFinancialAccount(
        ctx.db,
        account("Update alias target"),
        ctx.actor,
      )
    ).output;
    await expect(
      updateFinancialAccount(
        ctx.db,
        accountB.id,
        {
          sourceAliases: [
            {
              source: "update-test",
              alias: "Duplicate card",
              externalAccountId: "account-shared",
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT" },
    });

    const transactionA = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: accountA.id,
          kind: "purchase",
          status: "pending",
          amount: 10,
          sourceRefs: [
            { source: "update-test", externalId: "transaction-shared" },
          ],
        }),
        ctx.actor,
      )
    ).output;
    const transactionB = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: accountB.id,
          kind: "purchase",
          status: "pending",
          amount: 20,
        }),
        ctx.actor,
      )
    ).output;
    await expect(
      updateFinancialTransaction(
        ctx.db,
        transactionB.id,
        {
          sourceRefs: [
            { source: "update-test", externalId: "transaction-shared" },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT" },
    });

    expect(transactionA.sourceRefs).toEqual([
      { source: "update-test", externalId: "transaction-shared" },
    ]);

    const accountsByExternalId = await listFinancialAccounts(
      ctx.db,
      { externalAccountId: "account-shared" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(accountsByExternalId.data.map((entry) => entry.id)).toEqual([
      accountA.id,
    ]);
    const transactionsByExternalId = await listFinancialTransactions(
      ctx.db,
      { externalId: "transaction-shared" },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(transactionsByExternalId.data.map((entry) => entry.id)).toEqual([
      transactionA.id,
    ]);
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
    const p1Uuid = unsafePurchaseId(
      (await resolveLiveShortcode(ctx.db, p1.id, "purchase"))!,
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
      const uuid = unsafePurchaseId(
        (await resolveLiveShortcode(ctx.db, purchase.id, "purchase"))!,
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
    for (const [postedDate, amount] of [
      ["2026-01-04", -100],
      ["2026-01-05", -27.1],
    ] as const) {
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
    await deleteFinancialTransactions(ctx.db, [deletedRefund.id], ctx.actor);
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
    await deleteFinancialTransactions(ctx.db, [deleted.id], ctx.actor);
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
});
