import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { eq } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { financialTransaction, purchase } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { createFinancialAccount } from "./financial-account";
import { previewFinancialStatementImport } from "./financial-statement-preview";
import {
  createFinancialTransaction,
  listFinancialTransactions,
} from "./financial-transaction";
import {
  merchantVendorInferenceFor,
  normalizeMerchant,
} from "./merchant-vendor-inference";
import { createPurchase } from "./purchase";
import { listStatementRows, recordStatementRows } from "./statement-row";
import { statementRowExternalId } from "./statement-row-identity";
import { createVendor } from "./vendor";

describe("merchant Vendor inference", () => {
  const ctx = withTestDb();

  const seedAccount = async (name: string, withAlias = false) =>
    (
      await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name,
          identity: {
            kind: "credit_card",
            issuer: null,
            network: "visa",
            last4: "4242",
          },
          sourceAliases: withAlias
            ? [
                {
                  source: "merchant-inference-test",
                  alias: "Test Visa (...4242)",
                  externalAccountId: null,
                },
              ]
            : [],
        }),
        ctx.actor,
      )
    ).output;

  const seedVendor = async (name: string) =>
    (await createVendor(ctx.db, vendorCreateInput.parse({ name }), ctx.actor))
      .output;

  const seedPurchase = async (
    vendorId: Awaited<ReturnType<typeof seedVendor>>["id"],
    orderId: string,
  ) =>
    (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          vendorId,
          orderId,
          date: "2026-08-01",
        }),
        ctx.actor,
      )
    ).output;

  it("normalizes conservatively and requires two unanimous transactions", async () => {
    const account = await seedAccount("Inference threshold Visa");
    const vendor = await seedVendor("Threshold Supply");
    const vendorPurchase = await seedPurchase(vendor.id, "THRESHOLD-1");

    expect(normalizeMerchant("\t  ACME   Market\r\n")).toBe("acme market");
    expect(normalizeMerchant("ACME-Market, Inc.")).toBe("acme-market, inc.");
    expect(await merchantVendorInferenceFor(ctx.db, "Acme Market")).toEqual({
      status: "none",
      candidates: [],
    });

    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        purchaseId: vendorPurchase.id,
        kind: "purchase",
        status: "posted",
        amount: 25,
        postedDate: "2026-08-02",
        merchant: "\t  ACME   Market\r\n",
      }),
      ctx.actor,
    );
    expect(await merchantVendorInferenceFor(ctx.db, "acme market")).toEqual({
      status: "insufficient_history",
      candidates: [
        {
          vendorId: vendor.id,
          vendorName: vendor.name,
          supportingTransactionCount: 1,
          lastSeenDate: "2026-08-02",
        },
      ],
    });

    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        purchaseId: vendorPurchase.id,
        kind: "purchase",
        status: "posted",
        amount: 30,
        postedDate: "2026-08-03",
        merchant: "Acme Market",
      }),
      ctx.actor,
    );
    expect(await merchantVendorInferenceFor(ctx.db, " ACME MARKET ")).toEqual({
      status: "suggested",
      candidates: [
        {
          vendorId: vendor.id,
          vendorName: vendor.name,
          supportingTransactionCount: 2,
          lastSeenDate: "2026-08-03",
        },
      ],
    });
    expect(
      await merchantVendorInferenceFor(ctx.db, "Acme-Market"),
    ).toMatchObject({ status: "none" });

    const unallocated = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        kind: "purchase",
        status: "pending",
        amount: 40,
        merchant: "acme market",
      }),
      ctx.actor,
    );
    expect(unallocated.output.vendorInference?.status).toBe("suggested");

    const allocated = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        purchaseId: vendorPurchase.id,
        kind: "purchase",
        status: "pending",
        amount: 45,
        merchant: "acme market",
      }),
      ctx.actor,
    );
    expect(allocated.output.vendorInference).toBeNull();

    const transfer = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        kind: "account_transfer",
        status: "posted",
        amount: 50,
        postedDate: "2026-08-04",
        merchant: "acme market",
      }),
      ctx.actor,
    );
    expect(transfer.output.vendorInference).toBeNull();
  });

  it("counts distinct transactions, excludes cross-Vendor splits, and sorts ambiguity", async () => {
    const account = await seedAccount("Inference voting Visa");
    const alpha = await seedVendor("Alpha Hardware");
    const beta = await seedVendor("Beta Marketplace");
    const alphaOne = await seedPurchase(alpha.id, "ALPHA-1");
    const alphaTwo = await seedPurchase(alpha.id, "ALPHA-2");
    const betaOne = await seedPurchase(beta.id, "BETA-1");

    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 30,
        postedDate: "2026-08-05",
        merchant: "Shared Processor",
        allocations: [
          { purchaseId: alphaOne.id, amount: 10 },
          { purchaseId: alphaTwo.id, amount: 20 },
        ],
      }),
      ctx.actor,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        purchaseId: alphaOne.id,
        kind: "purchase",
        status: "posted",
        amount: 15,
        postedDate: "2026-08-06",
        merchant: "Shared Processor",
      }),
      ctx.actor,
    );
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 20,
        postedDate: "2026-08-07",
        merchant: "Shared Processor",
        allocations: [
          { purchaseId: alphaOne.id, amount: 10 },
          { purchaseId: betaOne.id, amount: 10 },
        ],
      }),
      ctx.actor,
    );
    expect(
      await merchantVendorInferenceFor(ctx.db, "Shared Processor"),
    ).toMatchObject({
      status: "suggested",
      candidates: [{ vendorId: alpha.id, supportingTransactionCount: 2 }],
    });

    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        purchaseId: betaOne.id,
        kind: "purchase",
        status: "posted",
        amount: 12,
        postedDate: "2026-08-08",
        merchant: "Shared Processor",
      }),
      ctx.actor,
    );
    expect(
      await merchantVendorInferenceFor(ctx.db, "Shared Processor"),
    ).toMatchObject({
      status: "ambiguous",
      candidates: [
        { vendorId: alpha.id, supportingTransactionCount: 2 },
        { vendorId: beta.id, supportingTransactionCount: 1 },
      ],
    });

    const refunds = [];
    for (const [index, postedDate] of ["2026-08-09", "2026-08-10"].entries())
      refunds.push(
        await createFinancialTransaction(
          ctx.db,
          financialTransactionCreateInput.parse({
            accountId: account.id,
            purchaseId: alphaOne.id,
            kind: "refund",
            status: "posted",
            amount: -(index + 1) * 5,
            postedDate,
            merchant: "Refund Processor",
          }),
          ctx.actor,
        ),
      );
    expect(
      await merchantVendorInferenceFor(ctx.db, "Refund Processor"),
    ).toMatchObject({ status: "suggested" });

    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransaction.id, refunds[0]!.entityId));
    expect(
      await merchantVendorInferenceFor(ctx.db, "Refund Processor"),
    ).toMatchObject({ status: "insufficient_history" });

    for (const amount of [7, 8])
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.id,
          purchaseId: alphaOne.id,
          kind: "purchase",
          status: "void",
          amount,
          merchant: "Voided Processor",
        }),
        ctx.actor,
      );
    expect(
      await merchantVendorInferenceFor(ctx.db, "Voided Processor"),
    ).toMatchObject({ status: "none" });

    const deletedPurchase = await seedPurchase(alpha.id, "DELETED-1");
    for (const amount of [9, 10])
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.id,
          purchaseId: deletedPurchase.id,
          kind: "purchase",
          status: "posted",
          amount,
          postedDate: "2026-08-11",
          merchant: "Deleted Purchase Processor",
        }),
        ctx.actor,
      );
    await getDb(ctx.db)
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(eq(purchase.shortcode, deletedPurchase.id));
    expect(
      await merchantVendorInferenceFor(ctx.db, "Deleted Purchase Processor"),
    ).toMatchObject({ status: "none" });
  });

  it("enriches transaction, Statement Row, and preview pages with one batched query", async () => {
    const account = await seedAccount("Inference output Visa", true);
    const vendor = await seedVendor("Output Supply");
    const vendorPurchase = await seedPurchase(vendor.id, "OUTPUT-1");
    for (const [amount, date] of [
      [21, "2026-08-12"],
      [22, "2026-08-13"],
    ] as const)
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.id,
          purchaseId: vendorPurchase.id,
          kind: "purchase",
          status: "posted",
          amount,
          postedDate: date,
          merchant: "Output Merchant",
        }),
        ctx.actor,
      );

    const usesPglite = process.env.CUBBY_TEST_DB_PROVIDER === "pglite";
    const listTransactions = () =>
      listFinancialTransactions(ctx.db, {}, [], {
        pageIndex: 0,
        pageSize: 100,
      });
    const withoutEligible = usesPglite
      ? null
      : await countTestDbQueries(listTransactions);
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        kind: "purchase",
        status: "pending",
        amount: 23,
        merchant: "Output Merchant",
      }),
      ctx.actor,
    );
    const withEligible = usesPglite
      ? { result: await listTransactions(), queryCount: null }
      : await countTestDbQueries(listTransactions);
    expect(withEligible.queryCount).toBe(
      usesPglite ? null : (withoutEligible?.queryCount ?? 0) + 1,
    );
    expect(
      withEligible.result.data.find((row) => row.allocations.length === 0)
        ?.vendorInference,
    ).toMatchObject({ status: "suggested" });

    const statementInput = {
      accountDescriptor: "Test Visa (...4242)",
      statementDate: "2026-08-14",
      providerAmount: -23,
      merchant: "Output Merchant",
      rawDescription: "OUTPUT MERCHANT PAYMENT",
      sourceCategory: "Household",
      providerStatus: "posted" as const,
      providerNotes: null,
    };
    await recordStatementRows(
      ctx.db,
      recordStatementRowsInput.parse({
        import: {
          source: "merchant-inference-test",
          label: "merchant-inference.csv",
          fingerprint: "merchant-inference-output",
          dateKind: "posted",
          rowCountDeclared: 1,
          notes: null,
        },
        rows: [statementInput],
      }),
      ctx.actor,
    );
    const statementPage = usesPglite
      ? {
          result: await listStatementRows(ctx.db, { matchState: "unmatched" }),
          queryCount: null,
        }
      : await countTestDbQueries(() =>
          listStatementRows(ctx.db, { matchState: "unmatched" }),
        );
    expect(statementPage.queryCount).toBe(usesPglite ? null : 3);
    expect(statementPage.result.data[0]?.vendorInference).toMatchObject({
      status: "suggested",
    });

    const preview = await previewFinancialStatementImport(ctx.db, {
      rows: [
        {
          key: "ready",
          source: "merchant-inference-test",
          account: "Test Visa (...4242)",
          date: "2026-08-15",
          amount: -24,
          merchant: "Output Merchant",
          originalStatement: "OUTPUT MERCHANT NEW PAYMENT",
          category: null,
          notes: null,
        },
      ],
    });
    expect(preview.rows[0]).toMatchObject({
      status: "ready_to_create",
      vendorInference: { status: "suggested" },
    });

    const externalId = await statementRowExternalId({
      source: "merchant-inference-test",
      account: statementInput.accountDescriptor,
      date: statementInput.statementDate,
      amount: statementInput.providerAmount,
      originalStatement: statementInput.rawDescription,
    });
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 23,
        postedDate: "2026-08-14",
        merchant: "Output Merchant",
        sourceRefs: [{ source: "merchant-inference-test", externalId }],
      }),
      ctx.actor,
    );
    expect(
      (await listStatementRows(ctx.db, { matchState: "matched" })).data[0],
    ).toMatchObject({ matchState: "matched", vendorInference: null });
  });
});
