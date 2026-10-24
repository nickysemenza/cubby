import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { ProjectId, PurchaseId } from "@cubby/schemas/identifiers";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb, countTestDbQueries } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  purchase as purchaseTable,
  sourceTransactionRecord,
  transactionImport,
  transactionImportRecord,
} from "~/server/db/schema";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { buildEntityReport, buildEntityReports } from ".";

const records = (blocks: ReportBlock[]) =>
  blocks.find(
    (block): block is Extract<ReportBlock, { kind: "records" }> =>
      block.kind === "records",
  );
/** "$1,234.50" or "$48.50 of $91.00" as the cents of its first figure. */
const centsOf = (text: string) =>
  Math.round(Number.parseFloat(text.replace(/[$,]/g, "")) * 100);
const stats = (blocks: ReportBlock[]) =>
  blocks.find(
    (block): block is Extract<ReportBlock, { kind: "stats" }> =>
      block.kind === "stats",
  );

/**
 * The finance detail slots against real rows. What a fake cannot show: the project groups
 * really add up to `SUM(Expense.cost)` to the cent, a charge split across two purchases shows
 * each purchase only its slice, and a verdict carries the shared label.
 */
describe("finance entity reports", () => {
  const ctx = withTestDb("mcp");

  const makePurchase = async (label: string, statedTotal: number | null) => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Report fixture ${label}`,
    });
    return insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      statedTotal,
    });
  };
  const addLine = (
    purchaseId: PurchaseId,
    name: string,
    cost: number,
    extra: {
      projectId?: ProjectId;
      lineKind?: "tax";
      costType?: "services";
    } = {},
  ) =>
    insertWithShortcode(ctx.db, "expense", {
      purchaseId,
      name,
      cost,
      date: "2026-09-01",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      ...extra,
    });
  const report = (
    slot: Parameters<typeof buildEntityReport>[1]["slot"],
    id: string,
  ) =>
    buildEntityReport(
      ctx.db,
      { slot, scope: { kind: "record", id: id } },
      async () => null,
      ctx.actor,
    ).then((result) => result.blocks);

  it("separates retained observations from distinct matched transaction booking", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic report cash",
      identity: { kind: "cash" },
      sourceAliases: [
        {
          source: "synthetic-bank",
          alias: "Synthetic report cash",
          externalAccountId: "synthetic-account",
        },
      ],
    });
    const input = recordSourceTransactionRecordsInput.parse({
      import: {
        source: "synthetic-bank",
        label: "synthetic-report.csv",
        fingerprint: "synthetic-report-first",
        observedAt: "2026-09-02T00:00:00Z",
        rowCountDeclared: 5,
      },
      rows: [25, 40, 12, 5, 9].map((amount, index) => ({
        rowPosition: index + 1,
        providerTransactionId: `synthetic-record-${index}`,
        providerAccountId: "synthetic-account",
        accountDescriptor: "Synthetic report cash",
        statementDate: "2026-09-01",
        providerAmount: -amount,
        rawDescription: `SYNTHETIC REPORT ${index}`,
      })),
    });
    const first = await recordSourceTransactionRecords(
      ctx.db,
      input,
      ctx.actor,
    );
    if (!first.batchId) throw new Error("Expected a retained synthetic import");
    const originals = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord)
      .where(eq(sourceTransactionRecord.batchId, first.batchId));
    const original = originals.find(
      (row) => row.providerTransactionId === "synthetic-record-0",
    );
    if (!original)
      throw new Error("Expected the original synthetic observation");
    const revised = await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          ...input.import,
          fingerprint: "synthetic-report-revision",
          observedAt: "2026-09-03T00:00:00Z",
          rowCountDeclared: 1,
        },
        rows: [{ ...input.rows[0], providerData: { revision: 2 } }],
      }),
      ctx.actor,
    );
    if (!revised.batchId)
      throw new Error("Expected a retained synthetic revision");
    const revision = await getDb(
      ctx.db,
    ).query.sourceTransactionRecord.findFirst({
      where: eq(sourceTransactionRecord.batchId, revised.batchId),
    });
    const collection = await getDb(ctx.db).query.transactionImport.findFirst({
      where: eq(transactionImport.id, first.batchId),
    });
    if (!revision || !collection)
      throw new Error("Expected retained synthetic evidence");
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic report shop",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: purchase.output.id,
      name: "Synthetic booked service",
      cost: 12,
      date: "2026-09-01",
      costType: "services",
      trade: "other",
      lineKind: "principal",
      lineBasis: "allocation",
    });
    for (const row of originals.filter(
      (row) => row.providerTransactionId !== "synthetic-record-4",
    )) {
      const retained = row.id === original.id ? revision : row;
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: row.amount,
        kind:
          row.providerTransactionId === "synthetic-record-1"
            ? "account_transfer"
            : row.providerTransactionId === "synthetic-record-3"
              ? "other"
              : "purchase",
        status: "observed",
        transactionDate: "2026-09-01",
        purchaseId:
          row.providerTransactionId === "synthetic-record-2"
            ? purchase.output.id
            : null,
        sourceRefs: [
          { source: retained.source, externalId: retained.externalId },
        ],
      });
    }
    const before = await report(
      "transactionImport.reconciliation-summary",
      collection.shortcode,
    );
    expect(stats(before)?.figures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Matched", value: 4 }),
        expect.objectContaining({ label: "Unmatched", value: 1 }),
      ]),
    );
    // Historical membership can retain several revisions of one charge; intake
    // refuses that shape for new collections, so model the preserved roster here.
    await getDb(ctx.db)
      .insert(transactionImportRecord)
      .values({ importId: first.batchId, statementRowId: revision.id });
    const blocks = await report(
      "transactionImport.reconciliation-summary",
      collection.shortcode,
    );
    expect(stats(blocks)?.figures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Matched", value: 5 }),
        expect.objectContaining({ label: "Unmatched", value: 1 }),
      ]),
    );
    expect(
      blocks.find(
        (block) =>
          block.kind === "stats" &&
          block.title === "Matched transaction booking",
      ),
    ).toMatchObject({
      figures: expect.arrayContaining([
        { label: "Unbooked", value: 1, format: "count" },
        { label: "Partly booked", value: 0, format: "count" },
        { label: "Booked", value: 1, format: "count" },
        { label: "Not required", value: 1, format: "count" },
        { label: "Unclassified", value: 1, format: "count" },
      ]),
    });
    expect(blocks.filter((block) => block.kind === "stats").at(1)).toEqual(
      before.filter((block) => block.kind === "stats").at(1),
    );
  });

  it("allocates a purchase's whole expense total across its project groups", async () => {
    const [kitchen, garden] = await Promise.all([
      insertWithShortcode(ctx.db, "project", { name: "Kitchen report" }),
      insertWithShortcode(ctx.db, "project", { name: "Garden report" }),
    ]);
    const purchase = await makePurchase("allocation", 70.07);
    await Promise.all([
      addLine(purchase.id, "Faucet", 30.01, { projectId: kitchen.id }),
      addLine(purchase.id, "Hose", 20.02, { projectId: garden.id }),
      addLine(purchase.id, "Loose parts", 10.03),
      addLine(purchase.id, "Tax", 10.01, {
        lineKind: "tax",
        costType: "services",
      }),
    ]);

    const blocks = await report(
      "purchase.project-allocation",
      purchase.shortcode,
    );

    expect(stats(blocks)?.figures[0]).toMatchObject({
      label: "Items + shared charges",
      value: 70.07,
      format: "money",
    });
    const items = records(blocks)?.rows ?? [];
    const cents = items.reduce(
      (sum, item) => sum + centsOf(item.trailing ?? "$0"),
      0,
    );
    // Conservation: spend is SUM(Expense.cost); the groups only attribute it.
    expect(cents).toBe(7007);
    expect(items.map((item) => item.title).sort()).toEqual([
      "Garden report",
      "Kitchen report",
      "Unassigned",
    ]);
    expect(items.find((item) => item.title === "Unassigned")?.id).toBeNull();
  });

  it("states the paperwork against the lines with the shared verdict", async () => {
    const purchase = await makePurchase("reconciliation", 100);
    await addLine(purchase.id, "Half of it", 50);

    const blocks = await report("purchase.reconciliation", purchase.shortcode);

    expect(stats(blocks)?.figures).toEqual([
      { label: "Stated", value: 100, format: "money" },
      { label: "Expenses", value: 50, format: "money" },
      {
        label: "Verdict",
        value: null,
        format: "text",
        text: "Needs review -$50.00",
        tone: "warning",
      },
    ]);
    expect(records(blocks)?.verbs?.map((verb) => verb.id)).toEqual([
      "linkExpenses",
      "linkProducts",
    ]);
  });

  // Vendor reconciliation, displayed spend and incurred settlement deliberately
  // use different ledgers. A narrow reader must not substitute one for another.
  it("keeps refund verdicts and signed spend fresh across duplicate finance slots", async () => {
    const purchase = await makePurchase("signed refunds", 100);
    await addLine(purchase.id, "Vendor net", 80);
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      name: "Household contribution",
      cost: -100,
      economicRole: "reimbursement",
      date: "2026-09-01",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      name: "Future unpriced contribution",
      cost: null,
      economicRole: "reimbursement",
      date: "2026-09-01",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: true,
    });
    const account = await createRepoEntity(ctx, "financialAccount");
    const transaction = async (status: "pending" | "posted") =>
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "refund",
        status,
        postedDate: status === "posted" ? "2026-09-02" : null,
        transactionDate: "2026-09-01",
        amount: -20,
        allocations: [{ purchaseId: purchase.shortcode, amount: -20 }],
      });
    await transaction("pending");
    expect(
      stats(await report("purchase.reconciliation", purchase.shortcode))
        ?.figures[2]?.text,
    ).toBe("Needs review -$120.00");
    // Posted evidence, not merely a pending refund, explains the vendor gap.
    await transaction("posted");
    const slots = [
      "purchase.financial-settlement",
      "purchase.reconciliation",
      "purchase.project-allocation",
    ] as const;
    const batch = (
      requested: Parameters<typeof buildEntityReports>[1]["slots"],
    ) =>
      countTestDbQueries(() =>
        buildEntityReports(
          ctx.db,
          { id: purchase.shortcode, slots: requested },
          async () => null,
          ctx.actor,
        ),
      );
    const single = await batch([...slots]);
    const repeated = await batch([...slots, ...slots].reverse());
    expect(repeated.queryCount).toBe(single.queryCount);
    expect(repeated.result.reports.map(({ slot }) => slot)).toEqual(
      [...slots, ...slots].reverse(),
    );
    for (const { slot, report: result } of repeated.result.reports)
      expect(result.blocks).toEqual(await report(slot, purchase.shortcode));
    expect(
      stats(await report("purchase.reconciliation", purchase.shortcode))
        ?.figures,
    ).toMatchObject([
      { value: 100 },
      { value: -20 },
      { text: "Refund-adjusted -$120.00" },
    ]);
    expect(
      stats(await report("purchase.project-allocation", purchase.shortcode))
        ?.figures[0]?.value,
    ).toBe(-20);
    expect(
      stats(await report("purchase.financial-settlement", purchase.shortcode))
        ?.figures,
    ).toMatchObject([
      { label: "Status", text: "Mismatch · 2" },
      { value: -20 },
      { value: -40 },
      { value: -20 },
    ]);
    await addLine(purchase.id, "New vendor expense", 20);
    expect(
      stats(await report("purchase.reconciliation", purchase.shortcode))
        ?.figures[2]?.text,
    ).toBe("Reconciles");
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      name: "Incurred unpriced",
      cost: null,
      date: "2026-09-01",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
    });
    expect(
      stats(
        await report("purchase.financial-settlement", purchase.shortcode),
      )?.figures.some(({ label }) => label === "Delta"),
    ).toBe(false);
  });

  it("rejects missing and deleted purchase identities for every finance slot", async () => {
    const purchase = await makePurchase("deleted identity", null);
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ deletedAt: new Date() })
      .where(eq(purchaseTable.id, purchase.id));
    for (const slot of [
      "purchase.reconciliation",
      "purchase.project-allocation",
      "purchase.financial-settlement",
    ] as const) {
      await expect(report(slot, purchase.shortcode)).rejects.toThrow(
        /not found/i,
      );
      await expect(report(slot, "PUR-0000")).rejects.toThrow(/not found/i);
    }
  });

  it("shows each purchase only its slice of a charge that settled two orders", async () => {
    const first = await makePurchase("settle-first", 42.5);
    const second = await makePurchase("settle-second", 48.5);
    const account = await createRepoEntity(ctx, "financialAccount");
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-02",
      transactionDate: "2026-09-01",
      merchant: "Report Hardware",
      amount: 91,
      allocations: [
        { purchaseId: first.shortcode, amount: 42.5 },
        { purchaseId: second.shortcode, amount: 48.5 },
      ],
    });

    const blocks = await report(
      "purchase.financial-settlement",
      second.shortcode,
    );
    const items = records(blocks)?.rows ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.trailing).toBe("$48.50 of $91.00");
    expect(stats(blocks)?.figures[0]).toMatchObject({ label: "Status" });
  });
});
