import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  storedImportFix,
  importSourceKind,
  sourceOrderReconciliationReview,
  type ExtractedOrderCandidate,
} from "@cubby/schemas/purchase-import";
import { moneyToMinor } from "@cubby/shared";
import { and, eq, or, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb, withTransaction } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  expense,
  financialAccount,
  financialTransactionAllocation,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  purchase,
  purchasePaymentEvidence,
  sourceOrderObservation,
} from "~/server/db/schema";
import { seedBankTransaction } from "~/server/domains/financial-transaction/repo/bank.fixtures";
import {
  insertPurchaseEventRows,
  updatePurchaseEventWhere,
} from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { createPurchaseEventRecord } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { loadExpenseAllocations } from "~/server/domains/household-contribution/repo/allocation";
import { jsonSnapshot } from "~/server/lib/canonical-json";
import {
  createProductIdentityFixture,
  makeProductInput,
  dollarExpenseColumns,
} from "~/server/testing/repo.fixtures";
import { seedRunFinding } from "~/server/testing/run-finding.fixtures";
import {
  patchRunFindingData,
  runFinding,
} from "~/server/testing/run-finding.fixtures";

import {
  memberImport,
  retainedMailFixture,
} from "../operations/order-import.fixtures";
import { acceptedOrders } from "./accepted-order-read";
import { resolveRunFinding } from "./findings";
import { prepareSourceOrderReconciliation } from "./reconciliation";
import {
  recordSourceOrderObservation,
  reconciliationFingerprint,
} from "./reconciliation-observations";
import {
  loadSourceReconciliationState,
  sourceReconciliationStateFingerprint,
} from "./reconciliation-state";

// The prepare/commit seam and real PostgreSQL readback guard the accepted
// source, spend ledger and settlement together; no mocked writer can prove it.
describe("accepted source financial reconciliation", () => {
  const ctx = withTestDb();
  const candidate: ExtractedOrderCandidate = {
    orderId: "SYNTHETIC-RECONCILE-1",
    orderedAt: "2026-09-01T18:00:00Z",
    merchant: "Synthetic workshop",
    currency: "USD",
    printedGrandTotal: 40,
    lines: [{ title: "Workshop admission", amount: 40, lineKind: "principal" }],
    payments: [{ amount: 40, chargedAt: "2026-09-02T12:00:00Z" }],
    allShipmentsDelivered: false,
  };

  // A free reward must reduce spend once, remain a discount on replay, and
  // never become a synthetic payment or alter the receipt's stated total.
  it("imports and replays a receipt reward as one signed discount", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic reward member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic rewards shop",
    });
    const rewardReceipt: ExtractedOrderCandidate = {
      ...candidate,
      orderId: "SYNTHETIC-FREE-REWARD",
      printedGrandTotal: 196.57,
      lines: [
        { title: "Synthetic goods", amount: 201.57, lineKind: "principal" },
        { title: "Free receipt reward", amount: -5, lineKind: "discount" },
      ],
      payments: [{ amount: 196.57, chargedAt: "2026-09-02T12:00:00Z" }],
    };
    const submit = () =>
      memberImport(ctx.db, ctx.actor, {
        key: "synthetic-free-reward",
        orders: [
          {
            stableOrderId: "synthetic-free-reward",
            vendorId: vendor.shortcode,
            source: {
              kind: "receipt_photo",
              externalKey: "synthetic:free-reward",
              checksum: "b".repeat(64),
            },
            extraction: { status: "ready", candidate: rewardReceipt },
          },
        ],
      });
    await submit();
    await submit();
    const database = getDb(ctx.db);
    const recorded = await database.query.purchase.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(purchase.orderId, rewardReceipt.orderId!)),
      },
    });
    if (!recorded) throw new Error("Synthetic reward Purchase missing");
    expect(recorded.statedTotal).toBe(19657n);
    const lines = await database
      .select(dollarExpenseColumns())
      .from(expense)
      .where(eq(expense.purchaseId, recorded.id));
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.lineKind === "discount")).toMatchObject({
      cost: -5,
      name: "Free receipt reward",
    });
    expect(
      lines.reduce(
        (total, line) => total + Math.round((line.cost ?? 0) * 100),
        0,
      ),
    ).toBe(19657);
    const payments = await database
      .select()
      .from(purchasePaymentEvidence)
      .where(
        or(
          eq(purchasePaymentEvidence.purchaseId, recorded.id),
          inArray(
            purchasePaymentEvidence.orderObservationId,
            database
              .select({ id: acceptedOrders.id })
              .from(acceptedOrders)
              .where(eq(acceptedOrders.purchaseId, recorded.id)),
          ),
        ),
      );
    expect(payments).toHaveLength(1);
    expect(payments[0]?.amountMinor).toBe(19657n);
  });

  async function world(
    firstKind:
      | "vendor_export"
      | "receipt_photo"
      | "mail_message" = "vendor_export",
  ) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic reconciliation member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic reconciliation vendor",
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic reconciliation account",
      identity: { kind: "credit_card", network: "visa" },
      ledgerPartyId: party.id,
    });
    await seedBankTransaction(ctx.db, {
      accountId: card.id,
      kind: "purchase",
      status: "posted",
      amount: moneyToMinor(40),
      postedDate: "2026-09-02",
      merchant: "SYNTHETIC WORKSHOP",
    });
    const submit = async (
      key: string,
      checksum: string,
      proposed = candidate,
      source: {
        kind: "vendor_export" | "receipt_photo" | "mail_message";
        externalKey: string;
      } = { kind: "vendor_export", externalKey: "synthetic:workshop:order" },
    ) => {
      if (source.kind === "mail_message") {
        const mail = await retainedMailFixture(ctx.db, {
          ledgerPartyId: party.id,
          mailboxId: "synthetic-reconciliation-mailbox",
          messageId: key,
          checksum: checksum,
          sender: "orders@example.test",
          subject: "Synthetic order receipt",
          receivedAt: new Date("2026-09-02T12:00:00Z"),
          content: {
            snippet: null,
            bodyText: "Synthetic workshop admission",
            bodyHtml: null,
          },
        });
        if (!mail) throw new Error("Synthetic retained Email missing");
        source = {
          kind: "mail_message",
          externalKey: `gmail:${mail.mailboxId}:${mail.messageId}`,
        };
      }
      return memberImport(ctx.db, ctx.actor, {
        key,
        orders: [
          {
            stableOrderId: key,
            vendorId: vendor.shortcode,
            source: {
              ...source,
              checksum,
            },
            extraction: { status: "ready", candidate: proposed },
          },
        ],
      });
    };
    await submit("accepted", "a".repeat(64), candidate, {
      kind: firstKind,
      externalKey: "synthetic:workshop:order",
    });
    const database = getDb(ctx.db);
    const accepted = await database.query.purchase.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(purchase.orderId, candidate.orderId!)),
      },
    });
    if (!accepted) throw new Error("Synthetic accepted Purchase missing");
    const state = async () => ({
      purchase: await database.query.purchase.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(table, eq(purchase.id, accepted.id)),
        },
      }),
      source: await database.select().from(importSourceClaim),
      orders: await database.select().from(importSourceOrder),
      payments: await database.select().from(purchasePaymentEvidence),
      allocations: await database.select().from(financialTransactionAllocation),
      expenses: await database
        .select(dollarExpenseColumns())
        .from(expense)
        .where(eq(expense.purchaseId, accepted.id)),
    });
    const initial = await state();
    expect(initial.payments).toHaveLength(1);
    expect(initial.allocations).toHaveLength(1);
    expect(initial.expenses.map((row) => row.cost)).toEqual([40]);
    return { submit, state, initial, accepted, database };
  }

  /** Stored predecessor work is seeded explicitly; its review still uses the real command and money guards. */
  async function retainedReviewWorld() {
    const w = await world();
    const [original] = await w.database.select().from(sourceOrderObservation);
    if (!original?.ledgerPartyId || !original.runId)
      throw new Error("Synthetic retained source owner is missing");
    const [claim] = await w.database
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: original.ledgerPartyId,
        kind: original.sourceKind,
        externalKey: original.sourceExternalKey,
        checksum: original.checksum,
        firstRunId: original.runId,
        lastRunId: original.runId,
      })
      .returning();
    if (!claim) throw new Error("Synthetic retained source claim is missing");
    await w.database
      .update(sourceOrderObservation)
      .set({ sourceClaimId: claim.id, purchaseId: w.accepted.id })
      .where(eq(sourceOrderObservation.id, original.id));
    const [association] = await w.database
      .insert(importSourceOrder)
      .values({
        sourceClaimId: claim.id,
        orderKey: original.orderKey,
        purchaseId: w.accepted.id,
        checksum: original.checksum,
        outputFingerprint: "2".repeat(64),
        acceptedObservationId: original.id,
        originalOrder: {
          checksum: original.checksum,
          extraction: original.extraction,
        },
      })
      .returning();
    if (!association || !w.initial.expenses[0])
      throw new Error("Synthetic retained order is missing");
    await w.database.insert(importSourceProduct).values({
      sourceOrderId: association.id,
      lineIndex: 0,
      expenseId: w.initial.expenses[0].id,
      productId: w.initial.expenses[0].productId,
    });
    await w.database
      .update(purchasePaymentEvidence)
      .set({
        sourceClaimId: claim.id,
        purchaseId: w.accepted.id,
        orderObservationId: null,
      })
      .where(eq(purchasePaymentEvidence.orderObservationId, original.id));
    const sourceRunId = original.runId;
    type SourceIdentity = {
      kind: "vendor_export" | "receipt_photo" | "mail_message";
      externalKey: string;
    };
    const capture = async (
      checksum: string,
      proposed: ExtractedOrderCandidate,
      identity?: SourceIdentity,
    ) => {
      const source = {
        ...(identity ?? {
          kind: importSourceKind.parse(original.sourceKind),
          externalKey: original.sourceExternalKey,
        }),
        checksum,
      };
      let [owner] = await w.database
        .select()
        .from(importSourceClaim)
        .where(
          and(
            eq(importSourceClaim.ledgerPartyId, claim.ledgerPartyId),
            eq(importSourceClaim.kind, source.kind),
            eq(importSourceClaim.externalKey, source.externalKey),
          ),
        );
      if (!owner)
        [owner] = await w.database
          .insert(importSourceClaim)
          .values({
            ledgerPartyId: claim.ledgerPartyId,
            kind: source.kind,
            externalKey: source.externalKey,
            checksum,
            firstRunId: sourceRunId,
            lastRunId: sourceRunId,
          })
          .returning();
      if (!owner)
        throw new Error("Synthetic captured source ownership is missing");
      const observation = await withTransaction(ctx.db, (tx) =>
        recordSourceOrderObservation(
          tx,
          {
            sourceClaimId: owner.id,
            orderKey: association.orderKey,
            purchaseId: w.accepted.id,
          },
          {
            vendorId: original.vendorId,
            runId: sourceRunId,
            source,
            extraction: { status: "ready", candidate: proposed },
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ),
      );
      return { source, owner, observation };
    };
    const propose = async (
      key: string,
      checksum: string,
      proposed: ExtractedOrderCandidate,
      identity?: SourceIdentity,
    ) => {
      const { source, owner, observation } = await capture(
        checksum,
        proposed,
        identity,
      );
      const [acceptedSource] = await w.database
        .select()
        .from(importSourceOrder)
        .where(
          and(
            eq(importSourceOrder.sourceClaimId, owner.id),
            eq(importSourceOrder.orderKey, association.orderKey),
          ),
        );
      return seedRunFinding(ctx.db, {
        runId: sourceRunId,
        ledgerPartyId: claim.ledgerPartyId,
        entityKind: "purchase",
        entityId: w.accepted.id,
        kind: "source_financial_changed",
        summary: `Synthetic retained review ${key}`,
        evidenceFingerprint: await reconciliationFingerprint({
          source,
          orderKey: association.orderKey,
          observationId: observation.id,
        }),
        proposedFix: {
          kind: "reconcile_source_order",
          purchaseId: w.accepted.id,
          source,
          orderKey: association.orderKey,
          acceptedChecksum: acceptedSource?.checksum ?? null,
          proposedExtraction: observation.extraction,
          observationId: observation.id,
          reviewedFingerprint: "0".repeat(64),
        },
      });
    };
    const acceptSibling = async (
      checksum: string,
      proposed: ExtractedOrderCandidate,
      identity: SourceIdentity,
    ) => {
      const { source, owner, observation } = await capture(
        checksum,
        proposed,
        identity,
      );
      const [sibling] = await w.database
        .insert(importSourceOrder)
        .values({
          sourceClaimId: owner.id,
          orderKey: association.orderKey,
          purchaseId: w.accepted.id,
          checksum,
          outputFingerprint: "3".repeat(64),
          acceptedObservationId: observation.id,
          originalOrder: {
            checksum: source.checksum,
            extraction: observation.extraction,
          },
        })
        .returning();
      if (!sibling)
        throw new Error("Synthetic retained sibling source is missing");
      return sibling;
    };
    return { ...w, initial: await w.state(), propose, acceptSibling };
  }

  // Stored legacy approvals must also refuse foreign/unknown currency even when
  // their full state fingerprint and numerical settlement remain consistent.
  it.each([
    { currency: "EUR", action: "prepare" },
    { currency: null, action: "prepare" },
    { currency: "EUR", action: "commit" },
    { currency: null, action: "commit" },
  ] as const)(
    "rejects $currency attach-only monetary reconciliation at $action",
    async ({ currency, action }) => {
      const w = await retainedReviewWorld();
      const proposed = {
        ...candidate,
        lines: [
          { ...candidate.lines[0]!, title: "Reviewed workshop admission" },
        ],
      };
      await w.propose("usd-review", "b".repeat(64), proposed);
      const [usdFinding] = await w.database.select().from(runFinding);
      if (!usdFinding) throw new Error("Synthetic USD finding missing");
      const resolution = {
        kind: "attach_only" as const,
        lines: [
          {
            lineIndex: 0,
            expenseId: parseShortcodeFor(
              "expense",
              w.initial.expenses[0]!.shortcode,
            ),
            productId: null,
          },
        ],
      };
      const usdReview = await prepareSourceOrderReconciliation(
        ctx.db,
        { id: usdFinding.id, resolution },
        ctx.actor,
      );
      await w.propose("currency-review", "c".repeat(64), {
        ...proposed,
        currency,
      });
      const findings = await w.database.select().from(runFinding);
      const finding = findings.find((row) => row.id !== usdFinding.id);
      if (!finding) throw new Error("Synthetic currency finding missing");
      const fix = storedImportFix.parse(finding.proposedFix);
      if (fix?.kind !== "reconcile_source_order")
        throw new Error("Synthetic currency proposal missing");
      const fingerprint = await withTransaction(ctx.db, async (tx) => {
        const state = await loadSourceReconciliationState(
          tx,
          fix,
          finding.ledgerPartyId,
          resolution,
        );
        return sourceReconciliationStateFingerprint(state, fix, resolution);
      });
      // Model an approval stored by the earlier implementation without weakening
      // the current public commit contract or bypassing its fingerprint checks.
      if (action === "commit") {
        const review = sourceOrderReconciliationReview.parse({
          ...usdReview,
          source: fix.source,
          orderKey: fix.orderKey,
          proposed: {
            checksum: fix.source.checksum,
            extraction: fix.proposedExtraction,
          },
          reviewedFingerprint: fingerprint,
        });
        await patchRunFindingData(ctx.db, finding.id, {
          proposedFix: jsonSnapshot.parse({
            ...fix,
            reviewedFingerprint: fingerprint,
            review,
          }),
        });
      }
      const before = {
        accepted: await w.state(),
        findings: await w.database.select().from(runFinding),
        observations: await w.database.select().from(sourceOrderObservation),
      };
      expect(before.accepted).toEqual(w.initial);
      await expect(
        action === "prepare"
          ? prepareSourceOrderReconciliation(
              ctx.db,
              { id: finding.id, resolution },
              ctx.actor,
            )
          : resolveRunFinding(
              ctx.db,
              {
                id: finding.id,
                action: "apply",
                reviewedFingerprint: fingerprint,
              },
              ctx.actor,
            ),
      ).rejects.toThrow(/USD|currency/i);
      expect({
        accepted: await w.state(),
        findings: await w.database.select().from(runFinding),
        observations: await w.database.select().from(sourceOrderObservation),
      }).toEqual(before);
    },
  );

  it("exact replay promotes only verifiable historical accepted evidence without changing money", async () => {
    const w = await retainedReviewWorld();
    const association = w.initial.orders[0]!;
    await w.database
      .update(importSourceOrder)
      .set({ acceptedObservationId: null })
      .where(eq(importSourceOrder.id, association.id));
    await w.database.delete(sourceOrderObservation);
    const before = await w.state();
    const result = await w.submit("historical-replay", "a".repeat(64));
    const after = await w.state();
    expect(after.orders[0]?.acceptedObservationId).toBeTruthy();
    expect(after.orders[0]?.originalOrder).toEqual(association.originalOrder);
    expect(after.orders[0]?.checksum).toBe(association.checksum);
    expect(after.orders[0]?.outputFingerprint).toBe(
      association.outputFingerprint,
    );
    expect(after.payments).toEqual(before.payments);
    expect(after.allocations).toEqual(before.allocations);
    expect(after.expenses).toEqual(before.expenses);
    expect(after.purchase).toEqual(before.purchase);
    const observations = await w.database.select().from(sourceOrderObservation);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      checksum: association.checksum,
      extraction: association.originalOrder?.extraction,
      runId: null,
      primaryDocumentImageId: null,
      screenshotImageId: null,
    });
    // Materializing the verifiable original records evidence, without inventing
    // capture provenance or republishing money. Its next exact capture replays.
    expect(result.committed.items[0]?.outcome).toBe("updated");
    const retry = await w.submit("historical-replay-retry", "a".repeat(64));
    expect(retry.committed.items[0]?.outcome).toBe("replayed");
    expect(await w.database.select().from(sourceOrderObservation)).toEqual(
      observations,
    );
  });

  it("refuses changed financial facts without refreshing accepted money and preserves edits while held", async () => {
    const { submit, state, initial, accepted, database } = await world();
    const originalFacts = await database.select().from(sourceOrderObservation);
    const changed = {
      ...candidate,
      printedGrandTotal: 45,
      lines: [{ ...candidate.lines[0]!, amount: 45 }],
      payments: [{ ...candidate.payments[0]!, amount: 45 }],
    };
    await submit("changed", "b".repeat(64), changed);
    const after = await state();
    expect(after.purchase).toEqual(initial.purchase);
    expect(after.expenses).toEqual(initial.expenses);
    expect(after.allocations).toEqual(initial.allocations);
    const facts = await database.select().from(sourceOrderObservation);
    expect(facts.map((row) => row.checksum).sort()).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(facts.find((row) => row.id === originalFacts[0]!.id)).toEqual(
      originalFacts[0],
    );
    const { scopeState, drift } = await import("~/server/db/kernel-schema");
    const { orderEventKey } = await import("./order-evidence");
    const key = orderEventKey(facts[0]!);
    const held = async () =>
      (
        await database
          .select()
          .from(scopeState)
          .where(eq(scopeState.scopeKey, key))
      )[0];
    expect(await held()).toMatchObject({ stage: "needs_you", error: null });
    expect(
      await database.select().from(drift).where(eq(drift.scopeKey, key)),
    ).toHaveLength(1);
    await submit("changed-retry", "b".repeat(64), changed);
    expect(await database.select().from(sourceOrderObservation)).toHaveLength(
      2,
    );
    expect((await state()).expenses).toEqual(initial.expenses);
    await updatePurchaseEventWhere(
      ctx.db,
      "expense",
      { cost: 4200n },
      eq(expense.id, initial.expenses[0]!.id),
      ctx.actor,
    );
    await submit("changed-after-member-edit", "b".repeat(64), changed);
    const expenseValues = (rows: typeof initial.expenses) =>
      rows.map(({ updatedAt: _updatedAt, ...row }) => row);
    expect(expenseValues((await state()).expenses)).toEqual(
      expenseValues(initial.expenses).map((row) => ({ ...row, cost: 42 })),
    );
    expect((await state()).allocations).toEqual(initial.allocations);
    expect(await held()).toMatchObject({ stage: "needs_you", error: null });
    expect((await state()).purchase?.id).toBe(accepted.id);
  });

  // The state loader must refuse a moved reviewed Expense as stale, not a 500.
  it("refuses to apply a review whose Expense moved to another Purchase as a CONFLICT", async () => {
    const { propose, state, initial, accepted, database } =
      await retainedReviewWorld();
    await propose("moved-expense", "e".repeat(64), {
      ...candidate,
      printedGrandTotal: 45,
      lines: [{ ...candidate.lines[0]!, amount: 45 }],
      payments: candidate.payments,
    });
    const [finding] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    const expenseId = parseShortcodeFor(
      "expense",
      initial.expenses[0]!.shortcode,
    );
    const preview = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding!.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [expenseId],
          lines: [{ lineIndex: 0, expenseId, productId: null }],
          attributionTargets: [
            { role: "beneficiary", partyId: null, amount: 45 },
            { role: "funder", partyId: null, amount: 45 },
          ],
        },
      },
      ctx.actor,
    );
    const other = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: accepted.vendorId,
      date: "2026-09-03",
      orderId: null,
    });
    await updatePurchaseEventWhere(
      ctx.db,
      "expense",
      { purchaseId: other.id },
      eq(expense.id, initial.expenses[0]!.id),
    );
    const snapshot = async () => ({
      state: await state(),
      expenses: await database
        .select(dollarExpenseColumns())
        .from(expense)
        .where(eq(expense.id, initial.expenses[0]!.id)),
      findings: await database
        .select()
        .from(runFinding)
        .where(eq(runFinding.id, finding!.id)),
    });
    const before = await snapshot();
    await expect(
      resolveRunFinding(
        ctx.db,
        {
          id: finding!.id,
          action: "apply",
          reviewedFingerprint: preview.reviewedFingerprint,
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "PURCHASE_IMPORT_REVIEW_STALE",
      message: "A selected Expense belongs to a different Purchase.",
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each([false, true])(
    "preserves only proven receipt correspondences on replacement (item changed: %s)",
    async (itemChanged) => {
      const w = await retainedReviewWorld();
      await w.acceptSibling("c".repeat(64), candidate, {
        kind: "receipt_photo",
        externalKey: "synthetic:sibling-receipt",
      });
      const sibling = (await w.database.select().from(importSourceOrder)).find(
        (row) => row.id !== w.initial.orders[0]!.id,
      );
      if (!sibling) throw new Error("Synthetic sibling receipt missing");
      const item = w.initial.expenses[0]!;
      await w.database
        .insert(importSourceProduct)
        .values({
          sourceOrderId: sibling.id,
          lineIndex: 0,
          expenseId: item.id,
          productId: null,
        })
        .onConflictDoUpdate({
          target: [
            importSourceProduct.sourceOrderId,
            importSourceProduct.lineIndex,
          ],
          set: { expenseId: item.id },
        });
      const originals = Object.fromEntries(
        (await w.database.select().from(importSourceOrder)).map((row) => [
          row.id,
          row.originalOrder,
        ]),
      );
      await w.propose("review-replacement", "d".repeat(64), {
        ...candidate,
        orderedAt: "2026-09-02T18:00:00Z",
        lines: itemChanged
          ? [{ ...candidate.lines[0]!, title: "Synthetic replacement item" }]
          : candidate.lines,
      });
      const finding = (await w.database.select().from(runFinding)).find(
        (row) =>
          storedImportFix.parse(row.proposedFix)?.kind ===
          "reconcile_source_order",
      );
      if (!finding) throw new Error("Synthetic replacement review missing");
      const review = await prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding.id,
          resolution: {
            kind: "replace_lines",
            expenseIds: [parseShortcodeFor("expense", item.shortcode)],
            lines: [
              {
                lineIndex: 0,
                expenseId: parseShortcodeFor("expense", item.shortcode),
                productId: null,
              },
            ],
          },
        },
        ctx.actor,
      );
      await resolveRunFinding(
        ctx.db,
        {
          id: finding.id,
          action: "apply",
          reviewedFingerprint: review.reviewedFingerprint,
        },
        ctx.actor,
      );
      const bindings = await w.database.select().from(importSourceProduct);
      expect(bindings).toHaveLength(2);
      expect(bindings.map((row) => row.expenseId)).toEqual([
        itemChanged ? null : item.id,
        itemChanged ? null : item.id,
      ]);
      const after = await w.state();
      expect(after.expenses).toHaveLength(1);
      expect(after.expenses[0]).toMatchObject({ id: item.id, cost: 40 });
      expect(
        Object.fromEntries(
          after.orders.map((row) => [row.id, row.originalOrder]),
        ),
      ).toEqual(originals);
    },
  );

  it("commits an explicitly reviewed cost correction once and retains the first extraction", async () => {
    const { submit, state, accepted, database } = await world();
    const [original] = await database
      .select()
      .from(sourceOrderObservation)
      .where(eq(sourceOrderObservation.checksum, "a".repeat(64)));
    if (!original?.ledgerPartyId || !original.runId)
      throw new Error("Synthetic retained source owner missing");
    // Seed the actual retained predecessor shape: an accepted association and
    // an unfinished source review, not a second current import path.
    const [claim] = await database
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: original.ledgerPartyId,
        kind: original.sourceKind,
        externalKey: original.sourceExternalKey,
        checksum: original.checksum,
        firstRunId: original.runId,
        lastRunId: original.runId,
      })
      .returning();
    if (!claim) throw new Error("Synthetic retained source claim missing");
    await database
      .update(sourceOrderObservation)
      .set({
        sourceClaimId: claim.id,
        purchaseId: accepted.id,
        contentFingerprint: "1".repeat(64),
      })
      .where(eq(sourceOrderObservation.id, original.id));
    const [association] = await database
      .insert(importSourceOrder)
      .values({
        sourceClaimId: claim.id,
        orderKey: original.orderKey,
        purchaseId: accepted.id,
        checksum: original.checksum,
        outputFingerprint: "2".repeat(64),
        acceptedObservationId: original.id,
        originalOrder: {
          checksum: original.checksum,
          extraction: original.extraction,
        },
      })
      .returning();
    if (!association) throw new Error("Synthetic retained association missing");
    const before = await state();
    await database.insert(importSourceProduct).values({
      sourceOrderId: association.id,
      lineIndex: 0,
      expenseId: before.expenses[0]!.id,
      productId: null,
    });
    await database
      .update(purchasePaymentEvidence)
      .set({ sourceClaimId: claim.id, purchaseId: accepted.id })
      .where(eq(purchasePaymentEvidence.orderObservationId, original.id));
    const initial = await state();
    await submit("corrected-cost", "d".repeat(64), {
      ...candidate,
      printedGrandTotal: 45,
      // A source-stated cost type replaces the reviewed line's old one.
      lines: [{ ...candidate.lines[0]!, amount: 45, costType: "services" }],
      // The original settlement stays valid until separately corrected.
      payments: candidate.payments,
    });
    const [proposal] = await database
      .select()
      .from(sourceOrderObservation)
      .where(eq(sourceOrderObservation.checksum, "d".repeat(64)));
    if (!proposal)
      throw new Error("Synthetic retained proposed extraction missing");
    await database
      .update(sourceOrderObservation)
      .set({
        sourceClaimId: claim.id,
        purchaseId: accepted.id,
        contentFingerprint: "3".repeat(64),
      })
      .where(eq(sourceOrderObservation.id, proposal.id));
    const finding = await seedRunFinding(ctx.db, {
      runId: proposal.runId,
      ledgerPartyId: original.ledgerPartyId,
      entityKind: "purchase",
      entityId: accepted.id,
      kind: "source_financial_changed",
      summary: "Synthetic retained cost correction",
      evidenceFingerprint: "4".repeat(64),
      proposedFix: {
        kind: "reconcile_source_order",
        purchaseId: accepted.id,
        source: {
          kind: proposal.sourceKind,
          externalKey: proposal.sourceExternalKey,
          checksum: proposal.checksum,
        },
        orderKey: proposal.orderKey,
        acceptedChecksum: original.checksum,
        proposedExtraction: proposal.extraction,
        reviewedFingerprint: "0".repeat(64),
        observationId: proposal.id,
      },
    });
    const pendingFacts = await database.select().from(sourceOrderObservation);
    const pending = await state();
    expect(pending.expenses).toEqual(initial.expenses);
    expect(pending.allocations).toEqual(initial.allocations);
    expect(pending.payments).toEqual(expect.arrayContaining(initial.payments));
    const preview = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding!.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: initial.expenses.map((row) =>
            parseShortcodeFor("expense", row.shortcode),
          ),
          lines: [
            {
              lineIndex: 0,
              expenseId: parseShortcodeFor(
                "expense",
                initial.expenses[0]!.shortcode,
              ),
              productId: null,
            },
          ],
          attributionTargets: [
            { role: "beneficiary", partyId: null, amount: 45 },
            { role: "funder", partyId: null, amount: 45 },
          ],
        },
      },
      ctx.actor,
    );
    expect(preview).toMatchObject({
      spend: { before: 40, after: 45, delta: 5 },
    });
    expect(await state()).toEqual(pending);
    const input = {
      id: finding!.id,
      action: "apply" as const,
      reviewedFingerprint: preview.reviewedFingerprint,
    };
    expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
      status: "applied",
    });
    const after = await state();
    expect(after.expenses.map((row) => row.cost)).toEqual([45]);
    expect(after.expenses[0]!.id).toBe(initial.expenses[0]!.id);
    const [corrected] = await database
      .select({ costType: expense.costType })
      .from(expense)
      .where(eq(expense.id, initial.expenses[0]!.id));
    expect(corrected?.costType).toBe("services");
    expect(after.orders[0]!.originalOrder).toEqual(
      initial.orders[0]!.originalOrder,
    );
    expect(after.orders).toEqual(
      initial.orders.map((order) => ({
        ...order,
        checksum: "d".repeat(64),
        acceptedObservationId: after.orders[0]!.acceptedObservationId,
        updatedAt: after.orders[0]!.updatedAt,
        outputFingerprint: after.orders[0]!.outputFingerprint,
      })),
    );
    expect(after.orders[0]!.outputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(after.orders[0]!.outputFingerprint).not.toBe(
      initial.orders[0]!.outputFingerprint,
    );
    expect(after.orders[0]!.acceptedObservationId).not.toBe(
      initial.orders[0]!.acceptedObservationId,
    );
    expect(after.orders[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      initial.orders[0]!.updatedAt.getTime(),
    );
    expect(after.payments).toEqual(expect.arrayContaining(initial.payments));
    const retained = await database
      .select()
      .from(sourceOrderObservation)
      .where(eq(sourceOrderObservation.id, original.id));
    expect(retained[0]?.extraction).toEqual(original.extraction);
    expect(after.allocations).toEqual(initial.allocations);
    // Expiry prevents a new application, not replay of an applied receipt.
    await patchRunFindingData(ctx.db, finding!.id, {
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
      status: "applied",
    });
    expect(await state()).toEqual(after);
    const observations = await database.select().from(sourceOrderObservation);
    // Acceptance reuses the reviewed capture; choices belong to Decisions.
    expect(observations).toEqual(pendingFacts);
    expect(
      observations.find((row) => row.checksum === "a".repeat(64))!.extraction
        .candidate!.printedGrandTotal,
    ).toBe(40);
    expect(after.orders[0]!.acceptedObservationId).toBe(proposal.id);
    expect(
      await database
        .select({ purchaseId: acceptedOrders.purchaseId })
        .from(acceptedOrders)
        .where(eq(acceptedOrders.id, proposal.id)),
    ).toEqual([{ purchaseId: accepted.id }]);
    expect(proposal.extraction.candidate?.printedGrandTotal).toBe(45);
  });

  it("rejects a reviewed correction after a human changes its ledger", async () => {
    const { propose, state, initial, accepted, database } =
      await retainedReviewWorld();
    await propose("stale-cost", "e".repeat(64), {
      ...candidate,
      lines: [{ ...candidate.lines[0]!, title: "Corrected admission" }],
    });
    const [finding] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    const preview = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding!.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [
            parseShortcodeFor("expense", initial.expenses[0]!.shortcode),
          ],
          lines: [
            {
              lineIndex: 0,
              expenseId: parseShortcodeFor(
                "expense",
                initial.expenses[0]!.shortcode,
              ),
              productId: null,
            },
          ],
        },
      },
      ctx.actor,
    );
    await updatePurchaseEventWhere(
      ctx.db,
      "expense",
      { cost: 4200n },
      eq(expense.id, initial.expenses[0]!.id),
    );
    const changed = await state();
    await expect(
      resolveRunFinding(
        ctx.db,
        {
          id: finding!.id,
          action: "apply",
          reviewedFingerprint: preview.reviewedFingerprint,
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed|stale/u);
    expect(await state()).toEqual(changed);
  });

  it("keeps accepted-observation payment reconciliation on the financial path", async () => {
    const { initial, database, state, propose } = await retainedReviewWorld();
    await database.update(purchasePaymentEvidence).set({ amountMinor: 3900n });
    const retainedPayments = await database
      .select()
      .from(purchasePaymentEvidence);
    const finding = await propose(
      "retained-payment-correction",
      "a".repeat(64),
      candidate,
    );
    const review = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding.id,
        resolution: {
          kind: "attach_only",
          lines: [
            {
              lineIndex: 0,
              expenseId: parseShortcodeFor(
                "expense",
                initial.expenses[0]!.shortcode,
              ),
              productId: null,
            },
          ],
        },
      },
      ctx.actor,
    );
    await resolveRunFinding(
      ctx.db,
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: review.reviewedFingerprint,
      },
      ctx.actor,
    );
    const after = await state();
    expect(after.payments).toHaveLength(retainedPayments.length + 1);
    for (const retained of retainedPayments)
      expect(after.payments.find((row) => row.id === retained.id)).toEqual(
        retained,
      );
    const acceptedPayment = after.payments.find(
      (row) =>
        row.orderObservationId === after.orders[0]?.acceptedObservationId,
    );
    expect(acceptedPayment?.amountMinor).toBe(4000n);
    expect(after.expenses).toEqual(initial.expenses);
    expect(after.allocations).toEqual(initial.allocations);
  });

  it("refuses accepted payment changes that disagree with a statement allocation", async () => {
    const { propose, state, initial, accepted, database } =
      await retainedReviewWorld();
    await propose("payment-conflict", "f".repeat(64), {
      ...candidate,
      payments: [{ amount: 45, chargedAt: "2026-09-02T12:00:00Z" }],
    });
    const [finding] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    await expect(
      prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding!.id,
          resolution: {
            kind: "attach_only",
            lines: [
              {
                lineIndex: 0,
                expenseId: parseShortcodeFor(
                  "expense",
                  initial.expenses[0]!.shortcode,
                ),
                productId: null,
              },
            ],
          },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/allocation/u);
    expect(await state()).toEqual(initial);
  });

  it("reviews changed extraction from the same immutable source bytes", async () => {
    const { submit, state, initial, database } = await retainedReviewWorld();
    const result = await submit("same-bytes-correction", "a".repeat(64), {
      ...candidate,
      lines: [{ ...candidate.lines[0]!, title: "Reviewed admission identity" }],
    });
    expect(result.committed.items[0]).toMatchObject({
      outcome: "conflict",
      findingCount: 1,
    });
    expect(await state()).toEqual(initial);
    const observations = await database.select().from(sourceOrderObservation);
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((row) => row.checksum)).size).toBe(1);
    expect(
      new Set(observations.map((row) => row.contentFingerprint)).size,
    ).toBe(2);
  });

  it.each([
    {
      change: "card number",
      payment: { ...candidate.payments[0]!, cardLastFour: "2222" },
    },
    {
      change: "stored-value tender",
      payment: { ...candidate.payments[0]!, tender: "stored_value" as const },
    },
  ])(
    "refuses a changed $change even when payment and allocation amounts agree",
    async ({ payment }) => {
      const { propose, state, accepted, database } =
        await retainedReviewWorld();
      await database
        .update(financialAccount)
        .set({
          cardNumbers: [
            {
              last4: "1111",
              kind: "primary",
              note: null,
              validFrom: null,
              validTo: null,
            },
          ],
        })
        .where(eq(financialAccount.name, "Synthetic reconciliation account"));
      const before = await state();
      await propose("wrong-card-correction", "7".repeat(64), {
        ...candidate,
        payments: [payment],
      });
      const [finding] = await database
        .select()
        .from(runFinding)
        .where(eq(runFinding.entityId, accepted.id));
      await expect(
        prepareSourceOrderReconciliation(
          ctx.db,
          {
            id: finding!.id,
            resolution: {
              kind: "attach_only",
              lines: [
                {
                  lineIndex: 0,
                  expenseId: parseShortcodeFor(
                    "expense",
                    before.expenses[0]!.shortcode,
                  ),
                  productId: null,
                },
              ],
            },
          },
          ctx.actor,
        ),
      ).rejects.toThrow(/allocation/u);
      expect(await state()).toEqual(before);
    },
  );

  it("preserves exact beneficiary and funder cents when splitting an accepted Expense", async () => {
    const { propose, state, initial, accepted, database } =
      await retainedReviewWorld();
    const parties = await Promise.all(
      ["Synthetic beneficiary A", "Synthetic beneficiary B"].map((name) =>
        insertWithShortcode(ctx.db, "ledgerParty", { name, kind: "member" }),
      ),
    );
    const original = initial.expenses[0]!;
    await insertPurchaseEventRows(ctx.db, "ExpenseAttribution", [
      {
        expenseId: original.id,
        role: "beneficiary",
        ledgerPartyId: parties[0]!.id,
        weight: 1333,
      },
      {
        expenseId: original.id,
        role: "beneficiary",
        ledgerPartyId: parties[1]!.id,
        weight: 2667,
      },
      {
        expenseId: original.id,
        role: "funder",
        ledgerPartyId: parties[0]!.id,
        weight: 1999,
      },
      {
        expenseId: original.id,
        role: "funder",
        ledgerPartyId: parties[1]!.id,
        weight: 2001,
      },
    ]);
    const proposed = {
      ...candidate,
      lines: [
        {
          title: "Admission portion A",
          amount: 13.33,
          lineKind: "principal" as const,
        },
        {
          title: "Admission portion B",
          amount: 26.67,
          lineKind: "principal" as const,
        },
      ],
    };
    await propose("split-with-cents", "6".repeat(64), proposed);
    const [finding] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    const preview = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding!.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [parseShortcodeFor("expense", original.shortcode)],
          lines: proposed.lines.map((_, lineIndex) => ({
            lineIndex,
            expenseId: parseShortcodeFor("expense", original.shortcode),
            productId: null,
          })),
        },
      },
      ctx.actor,
    );
    expect(preview.spend).toEqual({ before: 40, after: 40, delta: 0 });
    // The reviewed split names LedgerParties by shortcode, never uuid, both in
    // the response and in the stored proposal the commit replays.
    expect(new Set(preview.attributions.map((row) => row.partyId))).toEqual(
      new Set(parties.map((party) => party.shortcode)),
    );
    expect(preview.attributions.some((row) => "partyCode" in row)).toBe(false);
    const [prepared] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.id, finding!.id));
    const storedFix = storedImportFix.parse(prepared!.proposedFix);
    expect(
      storedFix?.kind === "reconcile_source_order"
        ? storedFix.review?.attributions
        : null,
    ).toEqual(preview.attributions);
    await resolveRunFinding(
      ctx.db,
      {
        id: finding!.id,
        action: "apply",
        reviewedFingerprint: preview.reviewedFingerprint,
      },
      ctx.actor,
    );
    const after = await state();
    expect(
      after.expenses
        .filter((row) => !row.deletedAt)
        .map((row) => row.cost)
        .sort(),
    ).toEqual([13.33, 26.67]);
    const allocations = await loadExpenseAllocations(ctx.db, {
      expenseIds: after.expenses
        .filter((row) => !row.deletedAt)
        .map((row) => row.id),
      includeFuture: true,
    });
    const totals = new Map<string, bigint>();
    for (const row of allocations) {
      const key = `${row.role}:${row.ledgerPartyId}`;
      totals.set(key, (totals.get(key) ?? 0n) + row.cents);
    }
    expect(totals.get(`beneficiary:${parties[0]!.id}`)).toBe(1333n);
    expect(totals.get(`beneficiary:${parties[1]!.id}`)).toBe(2667n);
    expect(totals.get(`funder:${parties[0]!.id}`)).toBe(1999n);
    expect(totals.get(`funder:${parties[1]!.id}`)).toBe(2001n);
    expect(after.payments).toEqual(initial.payments);
    expect(after.allocations).toEqual(initial.allocations);
  });

  it("retains the first competing observation when a later observation is explicitly accepted", async () => {
    const { propose, state, accepted, database } = await retainedReviewWorld();
    const source = {
      kind: "receipt_photo" as const,
      externalKey: "synthetic:changing-receipt",
    };
    for (const [checksum, amount] of [
      ["8", 45],
      ["9", 50],
    ] as const)
      await propose(
        `competing-${amount}`,
        checksum.repeat(64),
        {
          ...candidate,
          printedGrandTotal: amount,
          lines: [{ ...candidate.lines[0]!, amount }],
        },
        source,
      );
    const findings = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    const finding = findings.find((row) => {
      const fix = storedImportFix.parse(row.proposedFix);
      return (
        fix?.kind === "reconcile_source_order" &&
        fix.source.checksum === "9".repeat(64)
      );
    })!;
    const before = await state();
    const preview = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [
            parseShortcodeFor("expense", before.expenses[0]!.shortcode),
          ],
          lines: [
            {
              lineIndex: 0,
              expenseId: parseShortcodeFor(
                "expense",
                before.expenses[0]!.shortcode,
              ),
              productId: null,
            },
          ],
          attributionTargets: [
            { role: "beneficiary", partyId: null, amount: 50 },
            { role: "funder", partyId: null, amount: 50 },
          ],
        },
      },
      ctx.actor,
    );
    await resolveRunFinding(
      ctx.db,
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: preview.reviewedFingerprint,
      },
      ctx.actor,
    );
    const after = await state();
    const association = after.orders.find(
      (row) => row.checksum === "9".repeat(64),
    )!;
    expect(association.originalOrder?.checksum).toBe("8".repeat(64));
    expect(
      association.originalOrder?.extraction.candidate?.printedGrandTotal,
    ).toBe(45);
    const observation = await database.query.sourceOrderObservation.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            eq(sourceOrderObservation.id, association.acceptedObservationId!),
          ),
      },
    });
    expect(observation?.checksum).toBe("9".repeat(64));
    expect(after.expenses[0]!.cost).toBe(50);
  });

  it("refuses to attach two proposed lines to the same Expense", async () => {
    const { propose, state, accepted, database } = await retainedReviewWorld();
    await propose("double-binding", "5".repeat(64), {
      ...candidate,
      printedGrandTotal: 80,
      lines: [
        candidate.lines[0]!,
        { ...candidate.lines[0]!, title: "Second admission" },
      ],
    });
    const [finding] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    const before = await state();
    await expect(
      prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding!.id,
          resolution: {
            kind: "attach_only",
            lines: [
              {
                lineIndex: 0,
                expenseId: parseShortcodeFor(
                  "expense",
                  before.expenses[0]!.shortcode,
                ),
                productId: null,
              },
            ],
          },
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "PURCHASE_IMPORT_REVIEW_INVALID",
      message: "Review exactly one binding for each proposed order line.",
    });
    await expect(
      prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding!.id,
          resolution: {
            kind: "attach_only",
            lines: [0, 1].map((lineIndex) => ({
              lineIndex,
              expenseId: parseShortcodeFor(
                "expense",
                before.expenses[0]!.shortcode,
              ),
              productId: null,
            })),
          },
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "PURCHASE_IMPORT_REVIEW_INVALID",
      message:
        "Attach-only bindings require a distinct Expense for each proposed line.",
    });
    expect(await state()).toEqual(before);
  });

  it("refuses a same-total replacement that moves existing party cents", async () => {
    const { propose, state, initial, accepted, database } =
      await retainedReviewWorld();
    const owner = initial.source[0]!.ledgerPartyId;
    await insertPurchaseEventRows(ctx.db, "ExpenseAttribution", [
      {
        expenseId: initial.expenses[0]!.id,
        role: "beneficiary",
        ledgerPartyId: owner,
        weight: 1,
      },
      {
        expenseId: initial.expenses[0]!.id,
        role: "funder",
        ledgerPartyId: owner,
        weight: 1,
      },
    ]);
    await propose("same-total-party-change", "4".repeat(64), {
      ...candidate,
      lines: [{ ...candidate.lines[0]!, title: "Reviewed title" }],
    });
    const [finding] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    const before = await state();
    await expect(
      prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding!.id,
          resolution: {
            kind: "replace_lines",
            expenseIds: [
              parseShortcodeFor("expense", initial.expenses[0]!.shortcode),
            ],
            lines: [
              {
                lineIndex: 0,
                expenseId: parseShortcodeFor(
                  "expense",
                  initial.expenses[0]!.shortcode,
                ),
                productId: null,
              },
            ],
            attributionTargets: [
              { role: "beneficiary", partyId: null, amount: 40 },
              { role: "funder", partyId: null, amount: 40 },
            ],
          },
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "PURCHASE_IMPORT_REVIEW_INVALID",
      message:
        "Same-total replacements must preserve each party's beneficiary and funder cents.",
    });
    expect(await state()).toEqual(before);
  });

  it.each([
    ["vendor_export", "receipt_photo", "mail_message"],
    ["vendor_export", "mail_message", "receipt_photo"],
    ["receipt_photo", "vendor_export", "mail_message"],
    ["receipt_photo", "mail_message", "vendor_export"],
    ["mail_message", "vendor_export", "receipt_photo"],
    ["mail_message", "receipt_photo", "vendor_export"],
  ] as const)(
    "converges independent receipt, mail and retailer evidence in %s/%s/%s order",
    async (...kinds) => {
      const { submit, state, initial, database } = await world(kinds[0]);
      for (const [index, kind] of kinds.slice(1).entries()) {
        const imported = await submit(
          `independent-${index}`,
          String(index + 1).repeat(64),
          candidate,
          { kind, externalKey: `synthetic:independent:${kind}` },
        );
        expect(imported.committed.items[0]).toMatchObject({
          outcome: "updated",
          findingCount: 0,
        });
      }
      const after = await state();
      expect(after.expenses).toEqual(initial.expenses);
      expect(after.allocations).toEqual(initial.allocations);
      expect(await database.select().from(sourceOrderObservation)).toHaveLength(
        3,
      );
    },
  );

  it("records a competing independent source without accepting its payments or attachment", async () => {
    const { submit, state, initial, accepted, database } = await world();
    const imported = await submit(
      "competing-receipt",
      "9".repeat(64),
      {
        ...candidate,
        printedGrandTotal: 45,
        lines: [{ ...candidate.lines[0]!, amount: 45 }],
        payments: [{ ...candidate.payments[0]!, amount: 45 }],
      },
      { kind: "receipt_photo", externalKey: "synthetic:competing:receipt" },
    );
    const after = await state();
    expect(after.expenses).toEqual(initial.expenses);
    expect(after.payments).toEqual(expect.arrayContaining(initial.payments));
    const captured = after.payments.filter(
      (row) => !initial.payments.some((prior) => prior.id === row.id),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      amountMinor: 4500n,
      orderObservationId: expect.any(String),
    });
    expect(after.allocations).toEqual(initial.allocations);
    expect(after.orders).toEqual(initial.orders);
    expect(imported.committed.items[0]).toMatchObject({
      outcome: "conflict",
      findingCount: 1,
    });
    const [finding] = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    expect(finding!.proposedFix).toMatchObject({
      kind: "reconcile_source_order",
      observationId: expect.any(String),
    });
    expect(await database.select().from(sourceOrderObservation)).toHaveLength(
      2,
    );
  });

  it("reviews orphan spending and preserves disposals when importing a later purchase", async () => {
    const { database } = await world();
    const good = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic admission pass" }),
      ctx.actor,
    );
    const unlinked = await createPurchaseEventRecord(ctx.db, "expense", {
      name: "Workshop admission",
      cost: 4000n,
      costType: "materials",
      date: "2026-09-01",
      productId: good.entityId,
      productQuantity: 1,
      lineKind: "principal",
      lineBasis: "item_line",
      trade: "other",
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic pass seller",
    });
    const before = await database.select(dollarExpenseColumns()).from(expense);
    const imported = await memberImport(ctx.db, ctx.actor, {
      key: "unlinked-pass",
      orders: [
        {
          stableOrderId: "unlinked-pass",
          vendorId: seller.shortcode,
          source: {
            kind: "vendor_export",
            externalKey: "synthetic:unlinked:pass",
            checksum: "8".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              ...candidate,
              orderId: "SYNTHETIC-PASS-2",
              payments: [],
            },
          },
          resolutions: [{ kind: "existing", productId: good.id }],
        },
      ],
    });
    expect(await database.select(dollarExpenseColumns()).from(expense)).toEqual(
      before,
    );
    expect(imported.committed.items[0]).toMatchObject({
      outcome: "conflict",
      findingCount: 1,
    });
    const [finding] = await database.select().from(runFinding);
    const preview = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding!.id,
        resolution: {
          kind: "attach_only",
          lines: [
            {
              lineIndex: 0,
              expenseId: parseShortcodeFor("expense", unlinked.shortcode),
              productId: good.id,
            },
          ],
        },
      },
      ctx.actor,
    );
    expect(preview.spend).toEqual({ before: 40, after: 40, delta: 0 });
    await resolveRunFinding(
      ctx.db,
      {
        id: finding!.id,
        action: "apply",
        reviewedFingerprint: preview.reviewedFingerprint,
      },
      ctx.actor,
    );
    const after = await database.select(dollarExpenseColumns()).from(expense);
    expect(after).toHaveLength(before.length);
    expect(after.find((row) => row.id === unlinked.id)).toMatchObject({
      cost: 40,
      productId: good.entityId,
      purchaseId: finding!.entityId,
    });

    const { output: disposal } = await createRepoEntity(ctx, "expense", {
      name: "Discarded synthetic pass",
      notes: "Member recorded the old item as discarded.",
      cost: 0,
      costType: "materials",
      date: "2026-09-15",
      productId: good.id,
      productQuantity: -1,
      lineKind: "principal",
      lineBasis: "item_line",
      trade: "other",
    });
    const [disposalBefore] = await database
      .select(dollarExpenseColumns())
      .from(expense)
      .where(eq(expense.shortcode, disposal.id));
    const inventoryBefore = await database.select().from(inventoryEntry);
    const { output: header } = await createRepoEntity(ctx, "purchase", {
      vendorId: seller.shortcode,
      orderId: "SYNTHETIC-PASS-3",
      date: "2026-10-01",
      statedTotal: 40,
      notes: "Synthetic retained header note",
      defaultTrade: "other",
    });
    const repurchase = await memberImport(ctx.db, ctx.actor, {
      key: "unlinked-pass-repurchase",
      orders: [
        {
          stableOrderId: "unlinked-pass-repurchase",
          vendorId: seller.shortcode,
          targetPurchaseId: header.id,
          source: {
            kind: "vendor_export",
            externalKey: "synthetic:unlinked:pass:repurchase",
            checksum: "9".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              ...candidate,
              orderId: "SYNTHETIC-PASS-3",
              orderedAt: "2026-10-01",
              payments: [],
            },
          },
          resolutions: [{ kind: "existing", productId: good.id }],
        },
      ],
    });
    expect(repurchase.committed.items[0]).toMatchObject({
      outcome: "updated",
      purchaseId: header.id,
      findingCount: 0,
    });
    const [laterPurchase] = await database
      .select()
      .from(purchase)
      .where(eq(purchase.shortcode, header.id));
    expect(laterPurchase).toMatchObject({
      date: "2026-10-01",
      statedTotal: 4000n,
      notes: "Synthetic retained header note",
    });
    expect(
      await database
        .select(dollarExpenseColumns())
        .from(expense)
        .where(eq(expense.purchaseId, laterPurchase!.id)),
    ).toMatchObject([{ cost: 40, productId: good.entityId }]);
    expect(
      await database
        .select(dollarExpenseColumns())
        .from(expense)
        .where(eq(expense.shortcode, disposal.id)),
    ).toEqual([disposalBefore]);
    expect(await database.select().from(inventoryEntry)).toEqual(
      inventoryBefore,
    );
  });

  it("replays the original accepted checksum after a refused refresh", async () => {
    const { submit, state, initial } = await retainedReviewWorld();
    await submit("changed-payment", "b".repeat(64), {
      ...candidate,
      payments: [{ amount: 41, chargedAt: "2026-09-02T12:00:00Z" }],
    });
    const held = await state();
    const replay = await submit("original-replay", "a".repeat(64));
    expect(replay.committed.items[0]).toMatchObject({
      outcome: "replayed",
      findingCount: 0,
    });
    const after = await state();
    expect(after.orders).toEqual(initial.orders);
    expect(after.payments).toEqual(held.payments);
    expect(after.allocations).toEqual(initial.allocations);
    expect(after.expenses).toEqual(initial.expenses);
    expect(after.source.map((row) => row.checksum)).toEqual(["a".repeat(64)]);
  });

  it("accepts cosmetic checksum changes without replacing payments or adding spend", async () => {
    const { submit, state, initial } = await retainedReviewWorld();
    const cosmeticCandidate = {
      ...candidate,
      merchant: "Synthetic workshop receipt",
      payments: [
        {
          ...candidate.payments[0]!,
          chargedAt: "2026-09-02T12:00:00.000Z",
          description: "Receipt formatting changed",
        },
      ],
    };
    const cosmetic = await submit(
      "cosmetic",
      "c".repeat(64),
      cosmeticCandidate,
    );
    expect(cosmetic.committed.items[0]).toMatchObject({
      outcome: "updated",
      findingCount: 0,
    });
    const after = await state();
    expect(after.payments).toEqual(initial.payments);
    expect(after.allocations).toEqual(initial.allocations);
    expect(after.expenses).toEqual(initial.expenses);
    expect(after.orders[0]?.originalOrder).toEqual(
      initial.orders[0]?.originalOrder,
    );
    expect(after.orders[0]?.checksum).toBe("c".repeat(64));
    expect(after.source).toHaveLength(1);
    const replay = await submit(
      "cosmetic-replay",
      "c".repeat(64),
      cosmeticCandidate,
    );
    expect(replay.committed.items[0]?.outcome).toBe("replayed");
  });
});
