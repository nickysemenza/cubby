import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import {
  financialTransactionCreateInput,
  financialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import type { FinancialTransactionShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createFinancialAccount } from "./financial-account";
import {
  createFinancialTransaction,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "./financial-transaction";
import { findFinancialTransactionAllocationDefects } from "./problems/detectors-financial";
import {
  createPurchase,
  deleteEmptyPurchases,
  deletePurchases,
  mergePurchases,
} from "./purchase";
import { findOrCreateVendor, getVendorByID } from "./vendor";

/**
 * The write path for one card line settling several Purchases.
 *
 * The case throughout is the real one: a single -$16.76 Home Depot card credit
 * covering a return receipt that spanned two orders.
 */

const page = { pageIndex: 0, pageSize: 100 };
type TransactionOverrides = Partial<
  z.input<typeof financialTransactionCreateInput>
>;
type TransactionUpdateInput = z.input<typeof financialTransactionUpdateData>;

describe("settlement allocations — write path", () => {
  const ctx = withTestDb();

  const mkAccount = async (name = "Visa") =>
    (
      await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name,
          identity: {
            kind: "credit_card",
            issuer: null,
            network: "visa",
          },
          cardNumbers: [
            {
              last4: "2125",
              kind: "primary",
              validFrom: null,
              validTo: null,
              note: null,
            },
          ],
        }),
        ctx.actor,
      )
    ).output;

  const mkPurchase = async (orderId: string | null = null) => {
    const vendorId = await findOrCreateVendor(ctx.db, "Home Depot");
    const vendor = await getVendorByID(ctx.db, vendorId);
    return (
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          vendorId: vendor.id,
          date: "2026-08-10",
          orderId,
        }),
        ctx.actor,
      )
    ).output;
  };

  const mkTransaction = async (
    accountId: string,
    overrides: TransactionOverrides = {},
  ) =>
    (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId,
          kind: "refund",
          status: "posted",
          postedDate: "2026-08-10",
          amount: -16.76,
          ...overrides,
        }),
        ctx.actor,
      )
    ).output;

  const update = (
    id: FinancialTransactionShortcode,
    data: TransactionUpdateInput,
  ) =>
    updateFinancialTransaction(
      ctx.db,
      id,
      financialTransactionUpdateData.parse(data),
      ctx.actor,
    );

  const allocationsOf = async (id: FinancialTransactionShortcode) => {
    const { data: items } = await listFinancialTransactions(
      ctx.db,
      {},
      [],
      page,
    );
    return items.find((row) => row.id === id);
  };

  it("splits one card credit across two purchases and nulls the mirror", async () => {
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase("WN-A"), mkPurchase("WN-B")]);
    const txn = await mkTransaction(account.id);

    await update(txn.id, {
      allocations: [
        { purchaseId: a.id, amount: -8.96 },
        { purchaseId: b.id, amount: -7.8 },
      ],
    });

    // The mirror is NULL because there is no single purchase — that is truthful,
    // not "unsettled".
    expect((await allocationsOf(txn.id))?.purchaseId).toBeNull();
    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
  });

  it("finds a split transaction from BOTH purchases, which the mirror alone cannot", async () => {
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase("WN-C"), mkPurchase("WN-D")]);
    const txn = await mkTransaction(account.id);
    await update(txn.id, {
      allocations: [
        { purchaseId: a.id, amount: -8.96 },
        { purchaseId: b.id, amount: -7.8 },
      ],
    });

    for (const purchaseId of [a.id, b.id]) {
      const { data: items } = await listFinancialTransactions(
        ctx.db,
        { purchaseId },
        [],
        page,
      );
      expect(items.map((row) => row.id)).toContain(txn.id);
    }
  });

  it("refuses a set that does not sum to the amount, and one with mixed signs", async () => {
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase("WN-E"), mkPurchase("WN-F")]);
    const txn = await mkTransaction(account.id);

    await expect(
      update(txn.id, {
        allocations: [
          { purchaseId: a.id, amount: -8.96 },
          { purchaseId: b.id, amount: -7.0 },
        ],
      }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();

    await expect(
      update(txn.id, {
        allocations: [
          { purchaseId: a.id, amount: -20 },
          { purchaseId: b.id, amount: 3.24 },
        ],
      }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("carries a corrected amount onto a sole allocation, and refuses to guess for a split", async () => {
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase("WN-G"), mkPurchase("WN-H")]);

    const single = await mkTransaction(account.id, {
      purchaseId: a.id,
      amount: -10,
    });
    await update(single.id, { amount: -12 });
    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);

    const split = await mkTransaction(account.id);
    await update(split.id, {
      allocations: [
        { purchaseId: a.id, amount: -8.96 },
        { purchaseId: b.id, amount: -7.8 },
      ],
    });
    // Rescaling two evidence slices to fit a new total would be fabrication.
    await expect(update(split.id, { amount: -20 })).rejects.toThrow(
      /split across 2 purchases/,
    );
  });

  it("SUMS both slices when merging two purchases that share one transaction", async () => {
    // The regression this test exists for: copying the images/product-links
    // `onConflictDoNothing` onto this edge would silently drop one slice, losing
    // money-shaped evidence and breaking the sum invariant.
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase(), mkPurchase()]);
    const txn = await mkTransaction(account.id);
    await update(txn.id, {
      allocations: [
        { purchaseId: a.id, amount: -8.96 },
        { purchaseId: b.id, amount: -7.8 },
      ],
    });

    await mergePurchases(ctx.db, { keepId: b.id, mergeIds: [a.id] }, ctx.actor);

    // One slice of the full amount survives, so the transaction is singly linked
    // again — and the mirror has moved NULL -> b, which a plain repoint of the
    // column could never have produced.
    const after = await allocationsOf(txn.id);
    expect(after?.purchaseId).toBe(b.id);
    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
  });

  it("moves a non-colliding slice onto the survivor", async () => {
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase(), mkPurchase()]);
    const txn = await mkTransaction(account.id, {
      purchaseId: a.id,
      amount: -25,
    });

    await mergePurchases(ctx.db, { keepId: b.id, mergeIds: [a.id] }, ctx.actor);

    expect((await allocationsOf(txn.id))?.purchaseId).toBe(b.id);
    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
  });

  it("drops every slice of an affected transaction when one of its purchases is deleted", async () => {
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase("WN-M"), mkPurchase("WN-N")]);
    const txn = await mkTransaction(account.id);
    await update(txn.id, {
      allocations: [
        { purchaseId: a.id, amount: -8.96 },
        { purchaseId: b.id, amount: -7.8 },
      ],
    });

    await deletePurchases(
      ctx.db,
      [parseShortcodeFor("purchase", a.id)],
      ctx.actor,
    );

    // The sibling slice on b goes too: a partial set is not a legal state,
    // whereas zero allocations is legal and re-enterable.
    const after = await allocationsOf(txn.id);
    expect(after?.purchaseId).toBeNull();
    const { data: items } = await listFinancialTransactions(
      ctx.db,
      { purchaseId: b.id },
      [],
      page,
    );
    expect(items.map((row) => row.id)).not.toContain(txn.id);
    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
  });

  it("refuses delete_empty_purchases while a settlement allocation is live", async () => {
    const account = await mkAccount();
    const [a, b] = await Promise.all([mkPurchase("WN-O"), mkPurchase("WN-P")]);
    const txn = await mkTransaction(account.id);
    await update(txn.id, {
      allocations: [
        { purchaseId: a.id, amount: -8.96 },
        { purchaseId: b.id, amount: -7.8 },
      ],
    });

    await expect(
      deleteEmptyPurchases(
        ctx.db,
        [parseShortcodeFor("purchase", a.id)],
        ctx.actor,
      ),
    ).rejects.toThrow(/settlement allocations/);
  });
});
