import { type FinancialAccountId } from "@cubby/schemas/identifiers";
import { importWriterInput } from "@cubby/schemas/purchase-import";
import { moneyToMinor } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  evidenceBinding,
  recordKey,
  scopeDirty,
  scopeState,
} from "~/server/db/kernel-schema";
import {
  purchasePaymentEvidence,
  sourceOrderObservation,
} from "~/server/db/retained-tables";
import {
  financialTransactionAllocation,
  purchase,
  expense,
} from "~/server/db/schema";
import { seedBankTransaction } from "~/server/domains/financial-transaction/repo/bank.fixtures";
import {
  appendOrderEvidence,
  orderEventKey,
  paymentAmountKey,
} from "~/server/domains/purchase-import/repo/order-evidence";
import { decide, reconcileNow, recordSubject } from "~/server/kernel/api";

import { startImportRunFixture } from "../service/import-run.fixtures";

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
    const scope = { kind: "purchaseEvent", key: paymentAmountKey(2700n) };
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

    // Legacy evidence can carry extracted payments without retained payment rows.
    const database = getDb(ctx.db);
    const candidate = observation.extraction.candidate!;
    const firstPayment = candidate.payments[0]!;
    await database
      .delete(purchasePaymentEvidence)
      .where(eq(purchasePaymentEvidence.orderObservationId, observation.id));
    await database
      .update(sourceOrderObservation)
      .set({
        extraction: {
          ...observation.extraction,
          candidate: {
            ...candidate,
            payments: [firstPayment, { ...firstPayment, amount: 13 }],
          },
        },
      })
      .where(eq(sourceOrderObservation.id, observation.id));
    const secondary = { kind: "purchaseEvent", key: paymentAmountKey(1300n) };
    await reconcileNow(ctx.db, [scope]);
    await reconcileNow(ctx.db, [secondary]);
    expect(
      await database
        .select({ owner: evidenceBinding.scopeKey })
        .from(evidenceBinding)
        .where(eq(evidenceBinding.factKind, "orderObservation")),
    ).toEqual([{ owner: scope.key }]);
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
        sourceKind: fact.source.kind,
        sourceExternalKey: fact.source.externalKey,
        sourceClaimId: null,
      });
      const orderScope = { kind: "purchaseEvent", key: scopeKey };
      const matching = { kind: "purchaseEvent", key: paymentAmountKey(2700n) };
      const addOrder = async () => {
        await appendOrderEvidence(ctx.db, [{ input: fact, orderKey }]);
        await reconcileNow(ctx.db, [matching]);
        await reconcileNow(ctx.db, [orderScope]);
      };
      const addCharge = async () => {
        const [consumer] = await getDb(ctx.db)
          .select()
          .from(scopeState)
          .where(eq(scopeState.scopeKey, matching.key));
        const [beforeWake] = await getDb(ctx.db)
          .select()
          .from(scopeDirty)
          .where(eq(scopeDirty.scopeKey, matching.key));
        const bank = await charge(setup.card.id, {
          amount: 27,
          postedDate: "2026-09-02",
          merchant: setup.vendor.name,
        });
        await reconcileNow(ctx.db, [{ kind: "purchaseEvent", key: bank.id }]);
        const [afterWake] = await getDb(ctx.db)
          .select()
          .from(scopeDirty)
          .where(eq(scopeDirty.scopeKey, matching.key));
        expect({
          exists: !!afterWake,
          advanced: Number(afterWake?.seq ?? 0) > Number(beforeWake?.seq ?? 0),
        }).toEqual(
          consumer
            ? { exists: true, advanced: true }
            : { exists: false, advanced: false },
        );
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
      await reconcileNow(ctx.db, [matching]);
      await reconcileNow(ctx.db, scopes);
      await reconcileNow(ctx.db, [matching]);
      expect(
        await getDb(ctx.db)
          .select({ key: scopeDirty.scopeKey })
          .from(scopeDirty)
          .where(eq(scopeDirty.scopeKey, orderScope.key)),
      ).toHaveLength(0);
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

      // A cross-scope merge leaves an absorbed key on the survivor's id; the
      // Order's proof follows the live owner whichever row reads first.
      const database = getDb(ctx.db);
      const [booked] = await database
        .select()
        .from(purchase)
        .where(notDeleted(purchase));
      const [owner] = await database
        .select()
        .from(recordKey)
        .where(
          and(
            eq(recordKey.scopeKind, "purchaseEvent"),
            eq(recordKey.entity, "purchase"),
            eq(recordKey.entityId, booked!.id),
          ),
        );
      await database
        .update(sourceOrderObservation)
        .set({ purchaseId: booked!.id });
      await database.insert(recordKey).values({
        scopeKind: "purchaseEvent",
        scopeKey: "0-synthetic-absorbed",
        entity: "purchase",
        naturalKey: owner!.naturalKey,
        entityId: booked!.id,
        mergedAt: new Date(),
      });
      const proofOwner = async () => {
        await reconcileNow(ctx.db, [matching]);
        return database
          .select({ event: evidenceBinding.eventKey })
          .from(evidenceBinding)
          .where(
            and(
              eq(evidenceBinding.factKind, "orderObservation"),
              eq(evidenceBinding.basis, "proven"),
            ),
          );
      };
      expect(await proofOwner()).toEqual([{ event: owner!.scopeKey }]);
      // Rewriting the live row moves it after the absorbed row in the heap.
      await database
        .update(recordKey)
        .set({ createdAt: owner!.createdAt })
        .where(
          and(
            eq(recordKey.scopeKind, owner!.scopeKind),
            eq(recordKey.scopeKey, owner!.scopeKey),
            eq(recordKey.entity, owner!.entity),
            eq(recordKey.naturalKey, owner!.naturalKey),
          ),
        );
      expect(await proofOwner()).toEqual([{ event: owner!.scopeKey }]);
    },
  );

  it("dirties only the payment scope whose own amount gains a charge", async () => {
    const setup = await world();
    await syntheticOrder(setup, "SYNTHETIC-FIRST", 27, "e");
    await syntheticOrder(setup, "SYNTHETIC-SECOND", 41, "f");
    const keys = [paymentAmountKey(2700n), paymentAmountKey(4100n)];
    const dirty = async () =>
      (
        await getDb(ctx.db)
          .select({ key: scopeDirty.scopeKey })
          .from(scopeDirty)
          .where(eq(scopeDirty.scopeKind, "purchaseEvent"))
      )
        .map((row) => row.key)
        .filter((key) => keys.includes(key))
        .sort();
    await reconcileNow(
      ctx.db,
      keys.map((key) => ({ kind: "purchaseEvent", key })),
    );
    expect(await dirty()).toEqual([]);
    await charge(setup.card.id, { amount: 41, postedDate: "2026-09-02" });
    expect(await dirty()).toEqual([keys[1]]);
    await charge(setup.card.id, { amount: 27, postedDate: "2026-09-02" });
    expect(await dirty()).toEqual(keys);
  });

  it("keeps a member's same-payment choice at another amount from an automatic match", async () => {
    const setup = await world();
    const observation = await syntheticOrder(
      setup,
      "SYNTHETIC-CHOSEN",
      10,
      "a",
    );
    const matching = await charge(setup.card.id, {
      amount: 10,
      postedDate: "2026-09-02",
    });
    const chosen = await charge(setup.card.id, {
      amount: 20,
      postedDate: "2026-09-02",
    });
    const scope = { kind: "purchaseEvent", key: paymentAmountKey(1000n) };
    await decide(ctx.db, ctx.actor, [
      {
        channel: "identity",
        kind: "same",
        subject: orderEventKey(observation),
        field: recordSubject("financialTransaction", chosen.id),
        scopes: [scope],
      },
    ]);
    await reconcileNow(ctx.db, [scope]);
    expect(
      await getDb(ctx.db)
        .select({ event: evidenceBinding.eventKey })
        .from(evidenceBinding)
        .where(eq(evidenceBinding.factKind, "retainedPayment")),
    ).not.toContainEqual({ event: `bank:${matching.id}` });
  });

  async function syntheticOrder(
    setup: Awaited<ReturnType<typeof world>>,
    orderId: string,
    amount: number,
    checksum: string,
  ) {
    const run = await startImportRunFixture(ctx.db, setup.run);
    const [observation] = await appendOrderEvidence(ctx.db, [
      {
        orderKey: `${setup.vendor.id}/order/${orderId}`,
        input: importWriterInput.parse({
          runId: run.id,
          ledgerPartyId: setup.party.id,
          vendorId: setup.vendor.id,
          vendorAccountId: setup.account.id,
          source: {
            kind: "vendor_export",
            externalKey: `synthetic:${orderId}`,
            checksum: checksum.repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              orderId,
              merchant: setup.vendor.name,
              orderedAt: "2026-09-01T12:00:00Z",
              currency: "USD",
              printedGrandTotal: amount,
              lines: [
                { title: "Synthetic line", amount, lineKind: "principal" },
              ],
              payments: [
                {
                  amount,
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
    return observation;
  }

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
