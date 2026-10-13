import { testUserId } from "@cubby/schemas/testing";
import {
  workQueueHouseholdInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { user } from "~/server/db/auth.schema";
import { runFinding, suggestion } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { readRecordWorkQueue, readWorkQueue } from "~/server/repo/work-queue";
import { ensureRun } from "~/server/runs/ensure-run";

// Failure modes: a check filter applied after paging leaves counts and pages
// that disagree with the rows; a branch that cannot carry the check leaks into
// a check-filtered page; gap rows lose their check ids to joined prose; typed
// sorts order nulls or negatives inconsistently across directions; a record
// strip shows another record's work, a field-wide suggestion group, or work a
// member-only read would fence.
describe("Work queue gaps, typed columns, and record rows", () => {
  const ctx = withTestDb();

  const merchandiseOrder = async (prefix: string) => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `${prefix} vendor`,
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `${prefix} merchandise`,
      productExpectation: "required",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      displayLabel: `${prefix} order`,
      spendingCategoryId: category.id,
      date: "2026-09-20",
    });
    const lines = [];
    for (const [name, cost, date] of [
      ["Refund", -5, "2026-09-18"],
      ["Line", 20, "2026-09-21"],
      ["Unpriced", null, null],
    ] as const)
      lines.push(
        await insertWithShortcode(ctx.db, "expense", {
          name: `${prefix} ${name}`,
          purchaseId: purchase.id,
          cost,
          date,
          costType: "materials",
          trade: "other",
          lineKind: "principal",
          lineBasis: "item_line",
          economicRole: "vendor",
        }),
      );
    return { vendor, purchase, lines };
  };

  const read = (input: z.input<typeof workQueueHouseholdInput>) =>
    readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({ pageSize: 100, ...input }),
      false,
    );
  const names = (rows: WorkQueueRow[]) => rows.map((row) => row.name);

  it("filters by check before counting and paging, and carries check ids", async () => {
    const prefix = "Synthetic check filter";
    await merchandiseOrder(prefix);
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: `${prefix} widget`, categoryId: null }),
      ctx.actor,
    );
    const all = await read({ query: prefix });
    expect(all.meta.totalCount).toBeGreaterThanOrEqual(4);

    const lines = await read({
      query: prefix,
      check: "expense_product_resolution",
    });
    expect(lines.meta.totalCount).toBe(3);
    for (const row of lines.items) {
      expect(row).toMatchObject({ entity: "expense", source: "research" });
      expect(row.gaps.map((gap) => gap.check)).toEqual([
        "expense_product_resolution",
      ]);
      expect(row.reason).toBe(row.gaps[0]?.message);
    }
    const page = await read({
      query: prefix,
      check: ["expense_product_resolution"],
      pageSize: 1,
    });
    expect(page.meta.totalCount).toBe(3);
    expect(page.items).toHaveLength(1);

    const product = await read({ query: prefix, check: ["product_category"] });
    expect(product.meta.totalCount).toBe(1);
    expect(product.items[0]).toMatchObject({
      entity: "product",
      source: "research",
    });
    const checks = product.items[0]?.gaps.map((gap) => gap.check) ?? [];
    expect(checks).toContain("product_category");
    // Several gaps read as sentences, never the old "; " join.
    expect(product.items[0]?.reason).not.toContain(".;");
    expect(product.items[0]?.reason).toBe(
      product.items[0]?.gaps.map((gap) => gap.message).join(" "),
    );
    // Non-gap rows carry no checks.
    expect(
      all.items
        .filter((row) => row.source !== "research" && row.source !== "email")
        .flatMap((row) => row.gaps),
    ).toEqual([]);
  });

  it("sorts amount and date server-side with nulls last and keeps negatives", async () => {
    const prefix = "Synthetic typed sort";
    const { vendor, purchase } = await merchandiseOrder(prefix);
    const other = await merchandiseOrder("Synthetic other vendor sort");
    const base = {
      query: "Synthetic",
      check: "expense_product_resolution" as const,
    };
    const sorted = (orderBy: "amount" | "date", direction: "asc" | "desc") =>
      read({
        ...base,
        vendor: vendor.shortcode,
        sort: [{ orderBy, direction }],
      });

    expect(names((await sorted("amount", "asc")).items)).toEqual([
      `${prefix} Refund`,
      `${prefix} Line`,
      `${prefix} Unpriced`,
    ]);
    expect(names((await sorted("amount", "desc")).items)).toEqual([
      `${prefix} Line`,
      `${prefix} Refund`,
      `${prefix} Unpriced`,
    ]);
    expect(names((await sorted("date", "asc")).items)).toEqual([
      `${prefix} Refund`,
      `${prefix} Line`,
      `${prefix} Unpriced`,
    ]);
    expect(names((await sorted("date", "desc")).items)).toEqual([
      `${prefix} Line`,
      `${prefix} Refund`,
      `${prefix} Unpriced`,
    ]);
    const rows = (await sorted("amount", "asc")).items;
    expect(rows.map((row) => [row.amount, row.date])).toEqual([
      [-5, "2026-09-18"],
      [20, "2026-09-21"],
      [null, null],
    ]);
    for (const row of rows)
      expect(row.vendor).toEqual({ id: vendor.shortcode, name: vendor.name });
    // The vendor filter applies before counting.
    const both = await read(base);
    expect(both.meta.totalCount).toBeGreaterThanOrEqual(6);
    expect(
      both.items.some((row) => row.vendor?.id === other.vendor.shortcode),
    ).toBe(true);
    // A Purchase's amount is SUM(Expense.cost); its date is its own. A finding
    // naming the Purchase carries the same facts.
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic typed sort member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      { purpose: "ai_suggest" },
    );
    await getDb(ctx.db).insert(runFinding).values({
      runId,
      ledgerPartyId: member.id,
      entityId: purchase.id,
      entityKind: "purchase",
      kind: "other",
      summary: "Synthetic typed sort finding.",
      evidenceFingerprint: "synthetic-typed-sort-finding",
    });
    const strip = await readRecordWorkQueue(
      ctx.db,
      null,
      purchase.shortcode,
      false,
    );
    expect(strip.items.length).toBeGreaterThan(0);
    for (const row of strip.items)
      expect(row).toMatchObject({
        amount: 15,
        date: "2026-09-20",
        vendor: { id: vendor.shortcode, name: vendor.name },
      });
  });

  it("reads one record's rows without suggestion groups or fenced work", async () => {
    const prefix = "Synthetic record strip";
    const { lines } = await merchandiseOrder(prefix);
    const [refund, line] = lines;
    if (!refund || !line) throw new Error("fixture lines missing");
    const strip = await readRecordWorkQueue(
      ctx.db,
      null,
      refund.shortcode,
      false,
    );
    expect(strip.items.length).toBeGreaterThan(0);
    expect(strip.meta.totalCount).toBe(strip.items.length);
    for (const row of strip.items) {
      expect(row).toMatchObject({ entity: "expense", id: refund.shortcode });
      expect(row.displayImages).toEqual([]);
    }
    expect(strip.items.map((row) => row.id)).not.toContain(line.shortcode);

    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: `${prefix} widget`, categoryId: null }),
      ctx.actor,
    );
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      { purpose: "ai_suggest" },
    );
    await getDb(ctx.db)
      .insert(suggestion)
      .values({
        runId,
        entity: "product",
        recordId: await resolveOrThrow(ctx.db, "product", product.id),
        field: "categoryId",
        currentValue: null,
        suggestedValue: "CAT-2222",
        confidence: 0.9,
        model: "typesafe/jev",
        kind: "addition",
        status: "pending",
      });
    const queue = await read({});
    expect(queue.items.some((row) => row.source === "suggestion")).toBe(true);
    const productStrip = await readRecordWorkQueue(
      ctx.db,
      null,
      product.id,
      false,
    );
    expect(productStrip.items.length).toBeGreaterThan(0);
    for (const row of productStrip.items) {
      expect(row.source).not.toBe("suggestion");
      expect(row).toMatchObject({ entity: "product", id: product.id });
    }

    // Member-only reads fence another member's source work identically.
    const otherUserId = testUserId("synthetic-record-strip-other-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Synthetic strip other member",
      email: "synthetic-strip-other@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const first = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic strip first member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const second = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic strip second member",
      kind: "member",
      userId: otherUserId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `${prefix} private vendor`,
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: second.id,
      label: "Synthetic strip second member account",
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `${prefix} private merchandise`,
      productExpectation: "required",
    });
    const privateOrder = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      spendingCategoryId: category.id,
      displayLabel: `${prefix} private order`,
      date: "2026-09-20",
    });
    const privateLine = await insertWithShortcode(ctx.db, "expense", {
      name: `${prefix} private line`,
      purchaseId: privateOrder.id,
      cost: 12,
      date: "2026-09-20",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
      economicRole: "vendor",
    });
    const household = await readRecordWorkQueue(
      ctx.db,
      first.id,
      privateLine.shortcode,
      false,
    );
    expect(household.items.length).toBeGreaterThan(0);
    for (const row of household.items)
      expect(row.waitingFor).toEqual({
        kind: "members",
        members: [{ id: second.shortcode, name: second.name }],
      });
    const fenced = await readRecordWorkQueue(
      ctx.db,
      first.id,
      privateLine.shortcode,
      true,
    );
    expect(fenced.items).toEqual([]);
    expect(fenced.meta.totalCount).toBe(0);
  });
});
