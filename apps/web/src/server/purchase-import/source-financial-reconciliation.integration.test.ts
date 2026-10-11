import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  storedImportFix,
  sourceOrderReconciliationReview,
  type ExtractedOrderCandidate,
} from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransactionAllocation,
  importSourceClaim,
  importSourceOrder,
  purchase,
  purchasePaymentEvidence,
  runFinding,
  sourceOrderObservation,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { loadExpenseAllocations } from "~/server/repo/household-contribution/allocation";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { resolveRunFinding } from "./findings";
import { memberImport, retainedMailFixture } from "./order-import.fixtures";
import { prepareSourceOrderReconciliation } from "./reconciliation";
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
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: party.id,
    });
    await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: card.id,
      kind: "purchase",
      status: "posted",
      amount: 40,
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
      where: eq(purchase.orderId, candidate.orderId!),
    });
    if (!accepted) throw new Error("Synthetic accepted Purchase missing");
    const state = async () => ({
      purchase: await database.query.purchase.findFirst({
        where: eq(purchase.id, accepted.id),
      }),
      source: await database.select().from(importSourceClaim),
      orders: await database.select().from(importSourceOrder),
      payments: await database.select().from(purchasePaymentEvidence),
      allocations: await database.select().from(financialTransactionAllocation),
      expenses: await database
        .select()
        .from(expense)
        .where(eq(expense.purchaseId, accepted.id)),
    });
    const initial = await state();
    expect(initial.payments).toHaveLength(1);
    expect(initial.allocations).toHaveLength(1);
    expect(initial.expenses.map((row) => row.cost)).toEqual([40]);
    return { submit, state, initial, accepted, database };
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
      const w = await world();
      const proposed = {
        ...candidate,
        lines: [
          { ...candidate.lines[0]!, title: "Reviewed workshop admission" },
        ],
      };
      await w.submit("usd-review", "b".repeat(64), proposed);
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
      await w.submit("currency-review", "c".repeat(64), {
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
        await w.database
          .update(runFinding)
          .set({
            proposedFix: { ...fix, reviewedFingerprint: fingerprint, review },
          })
          .where(eq(runFinding.id, finding.id));
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
    const w = await world();
    const association = w.initial.orders[0]!;
    await w.database
      .update(importSourceOrder)
      .set({ acceptedObservationId: null })
      .where(eq(importSourceOrder.id, association.id));
    await w.database.delete(sourceOrderObservation);
    const before = await w.state();
    const result = await w.submit("historical-replay", "a".repeat(64));
    expect(result.committed.items[0]?.outcome).toBe("replayed");
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
    await w.submit("historical-replay-retry", "a".repeat(64));
    expect(await w.database.select().from(sourceOrderObservation)).toEqual(
      observations,
    );
  });

  it("refuses changed financial facts without refreshing accepted source or money", async () => {
    const { submit, state, initial, accepted, database } = await world();
    const result = await submit("changed", "b".repeat(64), {
      ...candidate,
      printedGrandTotal: 45,
      lines: [{ ...candidate.lines[0]!, amount: 45 }],
      payments: [{ ...candidate.payments[0]!, amount: 45 }],
    });
    expect(result.committed.items[0]).toMatchObject({
      outcome: "conflict",
      purchaseId: accepted.shortcode,
      findingCount: 1,
    });
    expect(await state()).toEqual(initial);
    const findings = await database
      .select()
      .from(runFinding)
      .where(eq(runFinding.entityId, accepted.id));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      status: "open",
      kind: "other",
      proposedFix: {
        kind: "reconcile_source_order",
        purchaseId: accepted.id,
        acceptedChecksum: "a".repeat(64),
        source: {
          kind: "vendor_export",
          externalKey: "synthetic:workshop:order",
          checksum: "b".repeat(64),
        },
        proposedExtraction: {
          status: "ready",
          candidate: { printedGrandTotal: 45, payments: [{ amount: 45 }] },
        },
        reviewedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const repeated = await submit("changed-retry", "b".repeat(64), {
      ...candidate,
      printedGrandTotal: 45,
      lines: [{ ...candidate.lines[0]!, amount: 45 }],
      payments: [{ ...candidate.payments[0]!, amount: 45 }],
    });
    expect(repeated.committed.items[0]?.outcome).toBe("conflict");
    expect(
      await database
        .select()
        .from(runFinding)
        .where(eq(runFinding.entityId, accepted.id)),
    ).toHaveLength(1);
    await expect(
      resolveRunFinding(
        ctx.db,
        { id: findings[0]!.id, action: "apply" },
        ctx.actor,
      ),
    ).rejects.toThrow(/review/iu);
    expect(await state()).toEqual(initial);
  });

  it("commits an explicitly reviewed cost correction once and retains the first extraction", async () => {
    const { submit, state, initial, accepted, database } = await world();
    await submit("corrected-cost", "d".repeat(64), {
      ...candidate,
      printedGrandTotal: 45,
      // A source-stated cost type replaces the reviewed line's old one.
      lines: [{ ...candidate.lines[0]!, amount: 45, costType: "services" }],
      // The original settlement stays valid until separately corrected.
      payments: candidate.payments,
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
    expect(await state()).toEqual(initial);
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
    expect(after.orders[0]!.checksum).toBe("d".repeat(64));
    expect(after.payments).toEqual(initial.payments);
    expect(after.allocations).toEqual(initial.allocations);
    expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
      status: "applied",
    });
    expect(await state()).toEqual(after);
    const observations = await database.select().from(sourceOrderObservation);
    expect(observations).toHaveLength(2);
    expect(
      observations.find((row) => row.checksum === "a".repeat(64))!.extraction
        .candidate!.printedGrandTotal,
    ).toBe(40);
    expect(after.orders[0]!.acceptedObservationId).toBe(
      observations.find((row) => row.checksum === "d".repeat(64))!.id,
    );
  });

  it("rejects a reviewed correction after a human changes its ledger", async () => {
    const { submit, state, initial, accepted, database } = await world();
    await submit("stale-cost", "e".repeat(64), {
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
    await database
      .update(expense)
      .set({ cost: 42 })
      .where(eq(expense.id, initial.expenses[0]!.id));
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

  it("refuses accepted payment changes that disagree with a statement allocation", async () => {
    const { submit, state, initial, accepted, database } = await world();
    await submit("payment-conflict", "f".repeat(64), {
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
    const { submit, state, initial, database } = await world();
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

  it("refuses a changed card number even when payment and allocation amounts agree", async () => {
    const { submit, state, accepted, database } = await world();
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
    await submit("wrong-card-correction", "7".repeat(64), {
      ...candidate,
      payments: [{ ...candidate.payments[0]!, cardLastFour: "2222" }],
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
  });

  it("preserves exact beneficiary and funder cents when splitting an accepted Expense", async () => {
    const { submit, state, initial, accepted, database } = await world();
    const parties = await Promise.all(
      ["Synthetic beneficiary A", "Synthetic beneficiary B"].map((name) =>
        insertWithShortcode(ctx.db, "ledgerParty", { name, kind: "member" }),
      ),
    );
    const original = initial.expenses[0]!;
    await database.insert(expenseAttribution).values([
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
    await submit("split-with-cents", "6".repeat(64), proposed);
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
    const { submit, state, accepted, database } = await world();
    const source = {
      kind: "receipt_photo" as const,
      externalKey: "synthetic:changing-receipt",
    };
    for (const [checksum, amount] of [
      ["8", 45],
      ["9", 50],
    ] as const)
      await submit(
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
      where: eq(sourceOrderObservation.id, association.acceptedObservationId!),
    });
    expect(observation?.checksum).toBe("9".repeat(64));
    expect(after.expenses[0]!.cost).toBe(50);
  });

  it("refuses to attach two proposed lines to the same Expense", async () => {
    const { submit, state, accepted, database } = await world();
    await submit("double-binding", "5".repeat(64), {
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
    ).rejects.toThrow(/distinct|unique/u);
    expect(await state()).toEqual(before);
  });

  it("refuses a same-total replacement that moves existing party cents", async () => {
    const { submit, state, initial, accepted, database } = await world();
    const owner = initial.source[0]!.ledgerPartyId;
    await database.insert(expenseAttribution).values([
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
    await submit("same-total-party-change", "4".repeat(64), {
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
    ).rejects.toThrow(/preserve.*cents/u);
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
      expect(after.orders).toHaveLength(3);
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
    expect(imported.committed.items[0]).toMatchObject({
      outcome: "conflict",
      findingCount: 1,
    });
    const after = await state();
    expect(after.expenses).toEqual(initial.expenses);
    expect(after.payments).toEqual(initial.payments);
    expect(after.allocations).toEqual(initial.allocations);
    expect(after.orders).toEqual(initial.orders);
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

  it("reuses an unlinked item Expense after explicit review without adding spending", async () => {
    const { database } = await world();
    const good = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic admission pass" }),
      ctx.actor,
    );
    const unlinked = await insertWithShortcode(ctx.db, "expense", {
      name: "Workshop admission",
      cost: 40,
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
    const before = await database.select().from(expense);
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
    expect(imported.committed.items[0]).toMatchObject({
      outcome: "conflict",
      findingCount: 1,
    });
    expect(await database.select().from(expense)).toEqual(before);
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
    const after = await database.select().from(expense);
    expect(after).toHaveLength(before.length);
    expect(after.find((row) => row.id === unlinked.id)).toMatchObject({
      cost: 40,
      productId: good.entityId,
      purchaseId: finding!.entityId,
    });
  });

  it("replays the original accepted checksum after a refused refresh", async () => {
    const { submit, state, initial } = await world();
    await submit("changed-payment", "b".repeat(64), {
      ...candidate,
      payments: [{ amount: 41, chargedAt: "2026-09-02T12:00:00Z" }],
    });
    const replay = await submit("original-replay", "a".repeat(64));
    expect(replay.committed.items[0]).toMatchObject({
      outcome: "replayed",
      findingCount: 0,
    });
    const after = await state();
    expect(after.orders).toEqual(initial.orders);
    expect(after.payments).toEqual(initial.payments);
    expect(after.allocations).toEqual(initial.allocations);
    expect(after.expenses).toEqual(initial.expenses);
    expect(after.source.map((row) => row.checksum)).toEqual(["a".repeat(64)]);
  });

  it("accepts cosmetic checksum changes without replacing payments or adding spend", async () => {
    const { submit, state, initial } = await world();
    const cosmetic = await submit("cosmetic", "c".repeat(64), {
      ...candidate,
      merchant: "Synthetic workshop receipt",
      payments: [
        {
          ...candidate.payments[0]!,
          chargedAt: "2026-09-02T12:00:00.000Z",
          description: "Receipt formatting changed",
        },
      ],
    });
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
    const replay = await submit("cosmetic-replay", "c".repeat(64));
    expect(replay.committed.items[0]?.outcome).toBe("replayed");
  });
});
