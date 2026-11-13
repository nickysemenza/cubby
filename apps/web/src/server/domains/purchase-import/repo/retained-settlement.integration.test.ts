import {type FinancialAccountId} from "@cubby/schemas/identifiers";
import { importWriterInput } from "@cubby/schemas/purchase-import";
import { moneyToMinor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb, notDeleted } from "~/server/db/helpers";
import { evidenceBinding } from "~/server/db/kernel-schema";
import {financialTransactionAllocation, purchase, expense} from "~/server/db/schema";
import { seedBankTransaction } from "~/server/domains/financial-transaction/repo/bank.fixtures";
import {
  appendOrderEvidence,
  orderEventKey,
  paymentAmountKey,
} from "~/server/domains/purchase-import/repo/order-evidence";
import { decide, reconcileNow, recordSubject } from "~/server/kernel/api";


import { startImportRunFixture } from "../service/import-run.fixtures";


const checksum = (seed: number) => seed.toString(16).padStart(64, "0");

describe("settlement from retained order evidence", () => {
  const ctx = withTestDb();
  

  it("keeps an ambiguous order payment unbound until a same decision, then binds the complete set", async () => {
    const setup = await world();
    const run = await startImportRunFixture(ctx.db, setup.run);
    const first = await charge(setup.card.id, {
      amount: 27,
      postedDate: "2026-09-02",
    });
    await charge(setup.card.id, { amount: 27, postedDate: "2026-09-02" });
    const [observation] = await appendOrderEvidence(ctx.db, [
      {
        orderKey: `${setup.vendor.id}/order/SYNTHETIC-MATCH`,
        input: importWriterInput.parse({
          runId: run.id,
          ledgerPartyId: setup.party.id,
          vendorId: setup.vendor.id,
          vendorAccountId: setup.account.id,
          source: {
            kind: "vendor_export",
            externalKey: "synthetic:match",
            checksum: "c".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYNTHETIC-MATCH",
              merchant: setup.vendor.name,
              orderedAt: "2026-09-01T12:00:00Z",
              currency: "USD",
              printedGrandTotal: 27,
              lines: [
                {
                  title: "Synthetic service",
                  amount: 27,
                  lineKind: "principal",
                },
              ],
              payments: [
                {
                  amount: 27,
                  chargedAt: "2026-09-02T12:00:00Z",
                  tender: "card",
                },
              ],
            },
          },
          primaryDocumentImageId: null,
          screenshotImageId: null,
        }),
      },
    ]);
    if (!observation)
      throw new Error("Synthetic accepted observation is missing");
    const scope = { kind: "paymentMatch", key: paymentAmountKey(2700n) };
    const [ambiguous] = await reconcileNow(ctx.db, [scope]);
    expect(
      ambiguous?.gaps.some((gap) =>
        gap.actions.some((action) => action.kind === "same"),
      ),
    ).toBe(true);
    expect(
      await getDb(ctx.db)
        .select()
        .from(evidenceBinding)
        .where(eq(evidenceBinding.factKind, "retainedPayment")),
    ).toEqual([]);
    await decide(ctx.db, ctx.actor, [
      {
        channel: "identity",
        kind: "same",
        subject: orderEventKey(observation),
        field: recordSubject("financialTransaction", first.id),
        scopes: [scope],
      },
    ]);
    const [resolved] = await reconcileNow(ctx.db, [scope]);
    expect(resolved?.status).toBe("applied");
    expect(
      await getDb(ctx.db)
        .select({
          event: evidenceBinding.eventKey,
          basis: evidenceBinding.basis,
        })
        .from(evidenceBinding)
        .where(eq(evidenceBinding.factKind, "retainedPayment")),
    ).toEqual([{ event: `bank:${first.id}`, basis: "decision" }]);
  });

  it.each(["charge-first", "order-first"])(
    "itemizes one spending event from accepted Email evidence (%s)",
    async (arrival) => {
      const setup = await world();
      const run = await startImportRunFixture(ctx.db, setup.run);
      const orderId = "SYNTHETIC-ARRIVAL";
      const fact = importWriterInput.parse({
        runId: run.id,
        ledgerPartyId: setup.party.id,
        vendorId: setup.vendor.id,
        vendorAccountId: setup.account.id,
        source: {
          kind: "mail_message",
          externalKey: "synthetic:arrival",
          checksum: "d".repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            orderId,
            merchant: setup.vendor.name,
            orderedAt: "2026-09-01T12:00:00Z",
            currency: "USD",
            printedGrandTotal: 27,
            lines: [
              {
                title: "Synthetic first item",
                amount: 20,
                lineKind: "principal",
              },
              {
                title: "Synthetic second item",
                amount: 7,
                lineKind: "principal",
              },
            ],
            payments: [
              { amount: 27, chargedAt: "2026-09-02T12:00:00Z", tender: "card" },
            ],
          },
        },
        primaryDocumentImageId: null,
        screenshotImageId: null,
      });
      const orderKey = `${setup.vendor.id}/order/${orderId}`;
      const scopeKey = orderEventKey({
      ledgerPartyId: setup.party.id,
        vendorId: setup.vendor.id,
        orderKey,
        extraction: fact.extraction,
      });
      const orderScope = { kind: "purchaseEvent", key: scopeKey };
      const matching = { kind: "paymentMatch", key: paymentAmountKey(2700n) };
      const addOrder = async () => {
        await appendOrderEvidence(ctx.db, [{ input: fact, orderKey }]);
        await reconcileNow(ctx.db, [matching]);
        await reconcileNow(ctx.db, [orderScope]);
      };
      const addCharge = async () => {
        const bank = await charge(setup.card.id, {
          amount: 27,
          postedDate: "2026-09-02",
          merchant: setup.vendor.name,
        });
        await reconcileNow(ctx.db, [{ kind: "purchaseEvent", key: bank.id }]);
        return bank;
      };
      const category = await insertWithShortcode(ctx.db, "spendingCategory", {
        name: "Synthetic member category",
      });
      let bank;
      if (arrival === "charge-first") {
        bank = await addCharge();
        const [lump] = await getDb(ctx.db)
          .select()
          .from(expense)
          .where(notDeleted(expense));
        if (!lump) throw new Error("Synthetic charge must book a lump first");
        await decide(ctx.db, ctx.actor, [
          {
            channel: "assignment",
            kind: "set",
            subject: recordSubject("expense", lump.id),
            field: "spendingCategoryId",
            value: category.id,
          },
        ]);
        await addOrder();
      } else {
        await addOrder();
        bank = await addCharge();
      }
      await reconcileNow(ctx.db, [matching]);
      const scopes = [orderScope, { kind: "purchaseEvent", key: bank.id }];
      await reconcileNow(ctx.db, scopes);
      await reconcileNow(ctx.db, scopes);
      expect(
        await getDb(ctx.db)
          .select({ id: purchase.id })
          .from(purchase)
          .where(notDeleted(purchase)),
      ).toHaveLength(1);
      expect(
        (
          await getDb(ctx.db)
            .select({ name: expense.name, cost: expense.cost })
            .from(expense)
            .where(notDeleted(expense))
        ).sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: "Synthetic first item", cost: 2000n },
        { name: "Synthetic second item", cost: 700n },
      ]);
      expect(
        await getDb(ctx.db)
          .select({ category: expense.spendingCategoryId })
          .from(expense)
          .where(notDeleted(expense)),
      ).toEqual([
        { category: arrival === "charge-first" ? category.id : null },
        { category: arrival === "charge-first" ? category.id : null },
      ]);
      expect(
        await getDb(ctx.db)
          .select({ amount: financialTransactionAllocation.amountMinor })
          .from(financialTransactionAllocation)
          .where(notDeleted(financialTransactionAllocation)),
      ).toEqual([{ amount: 2700n }]);
    },
  );

  async function world() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Settlement member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `ForgeWear ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Settlement card",
      identity: { kind: "credit_card", network: "visa" },
      ledgerPartyId: party.id,
    });
    // Each order is imported by its own member Run: a commit settles the Run.
    const run = { ledgerPartyId: party.id, vendorAccountId: account.id };
    return { party, vendor, account, card, run };
  }

  async function charge(
    accountId: FinancialAccountId,
    input: {
      amount: number;
      postedDate: string;
      status?: "posted" | "pending" | "void" | "expected";
      merchant?: string;
    },
  ) {
    return seedBankTransaction(ctx.db, {
      accountId,
      kind: input.amount < 0 ? "refund" : "purchase",
      status: input.status ?? "posted",
      amount: moneyToMinor(input.amount),
      transactionDate: null,
      postedDate: input.postedDate,
      merchant: input.merchant ?? "FORGEWEAR",
    });
  }


});
