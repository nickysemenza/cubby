import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import type { FinancialTransactionFilters } from "@cubby/schemas/financial-transaction";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createExpense } from "./expense";
import { createFinancialAccount } from "./financial-account";
import {
  createFinancialTransaction,
  listFinancialTransactions,
} from "./financial-transaction";
import { createPurchase } from "./purchase";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";
import { findOrCreateVendor, getVendorByID } from "./vendor";

// Failure modes this guards:
//  - a charge that is one of several on a purchase (installments, combined
//    orders) compared against the whole purchase's lines;
//  - a purchase booked as productless lump rows read as "itemized";
//  - a void sibling charge turning a solo charge into a shared one;
//  - a charge split across purchases losing its per-purchase comparison;
//  - the verdict filter compiling on the rows leg but not the count leg.
describe("financial transaction itemization verdict", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 100 };

  const seed = async () => {
    const accountId = (
      await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name: "Itemization Visa",
          identity: { kind: "credit_card", issuer: null, network: "visa" },
          cardNumbers: [],
          sourceAliases: [],
        }),
        ctx.actor,
      )
    ).output.id;
    const vendor = await getVendorByID(
      ctx.db,
      await findOrCreateVendor(ctx.db, "Itemization Vendor"),
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Itemization test good" }),
      ctx.actor,
    );

    const purchase = async (orderId: string) =>
      (
        await createPurchase(
          ctx.db,
          purchaseCreateInput.parse({
            date: "2024-01-15",
            vendorId: vendor.id,
            orderId,
          }),
          ctx.actor,
        )
      ).output.id;

    const line = (
      purchaseId: PurchaseShortcode,
      cost: number,
      itemized: boolean,
    ) =>
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: `line ${cost}`,
            cost,
            purchaseId,
            ...(itemized
              ? { productId: product.id, productQuantity: 1 }
              : { lineBasis: "allocation" }),
          }),
        ),
        ctx.actor,
      );

    const charge = async (
      amount: number,
      allocations: { purchaseId: PurchaseShortcode; amount: number }[],
      status: "posted" | "void" = "posted",
    ) =>
      (
        await createFinancialTransaction(
          ctx.db,
          financialTransactionCreateInput.parse({
            accountId,
            kind: "purchase",
            status,
            postedDate: status === "posted" ? "2026-01-01" : null,
            amount,
            merchant: `charge ${amount} ${allocations.length} ${status}`,
            allocations,
          }),
          ctx.actor,
        )
      ).output.id;

    return { purchase, line, charge };
  };

  const verdicts = async (filters: FinancialTransactionFilters = {}) => {
    const listed = await listFinancialTransactions(ctx.db, filters, [], page);
    return new Map(listed.data.map((row) => [row.merchant, row.itemization]));
  };

  it("classifies each charge and filters by verdict", async () => {
    const { purchase, line, charge } = await seed();

    const lump = await purchase("lump");
    await line(lump, 100, false);
    await charge(100, [{ purchaseId: lump, amount: 100 }]);

    const matched = await purchase("matched");
    await line(matched, 30, true);
    await line(matched, 20, true);
    await charge(50, [{ purchaseId: matched, amount: 50 }]);

    const short = await purchase("short");
    await line(short, 30, true);
    await charge(45, [{ purchaseId: short, amount: 45 }]);

    // Two installments against one itemized purchase: neither charge is
    // compared to the full set of lines on its own.
    const shared = await purchase("shared");
    await line(shared, 60, true);
    await line(shared, 40, true);
    await charge(60, [{ purchaseId: shared, amount: 60 }]);
    await charge(40, [{ purchaseId: shared, amount: 40 }]);

    // A voided sibling does not make the live charge shared.
    const voided = await purchase("voided");
    await line(voided, 21, true);
    await charge(21, [{ purchaseId: voided, amount: 21 }]);
    await charge(21, [{ purchaseId: voided, amount: 21 }], "void");

    // One charge split across two solo-charged purchases.
    const splitA = await purchase("split-a");
    const splitB = await purchase("split-b");
    await line(splitA, 10, true);
    await line(splitB, 15, true);
    await charge(25, [
      { purchaseId: splitA, amount: 10 },
      { purchaseId: splitB, amount: 15 },
    ]);

    await charge(7, []);

    const all = await verdicts();
    expect(all.get("charge 7 0 posted")).toBe("bare");
    expect(all.get("charge 100 1 posted")).toBe("lump");
    expect(all.get("charge 50 1 posted")).toBe("itemized_match");
    expect(all.get("charge 45 1 posted")).toBe("itemized_mismatch");
    expect(all.get("charge 60 1 posted")).toBe("shared");
    expect(all.get("charge 40 1 posted")).toBe("shared");
    expect(all.get("charge 21 1 posted")).toBe("itemized_match");
    expect(all.get("charge 25 2 posted")).toBe("itemized_match");

    const only = async (
      itemization: FinancialTransactionFilters["itemization"],
    ) =>
      [...(await verdicts({ itemization })).keys()]
        .filter((merchant) => merchant?.endsWith("posted"))
        .sort();
    expect(await only("shared")).toEqual([
      "charge 40 1 posted",
      "charge 60 1 posted",
    ]);
    expect(await only("bare")).toEqual(["charge 7 0 posted"]);
    expect(await only("itemized_mismatch")).toEqual(["charge 45 1 posted"]);
    expect(await only("lump")).toEqual(["charge 100 1 posted"]);
  });
});
