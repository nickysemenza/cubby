import type {
  ExpenseId,
  PurchaseId,
  PurchaseShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  unsafeExpenseShortcode,
  unsafeProductId,
  unsafeProjectShortcode,
  unsafePurchaseId,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import {
  type ExpenseCreateInput,
  type ExpenseOut,
  expenseCreateInput,
  expenseMatchInput,
  projectCreateInput,
} from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { expenseRouter } from "~/server/api/routers/expense";
import { createTestCaller } from "~/server/api/trpc";
import type { Database } from "~/server/db";
import { expense as expenseTable, product } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";
import { findOrphanedEntityEmbeddings } from "~/server/repo/entity-embedding";
import {
  createExpense,
  deleteExpenses,
  deleteExpensesWithPurchaseEffects,
  expenseAnalytics,
  expenseList,
  getExpenseByShortcode,
  matchExpenses,
  moveExpenses,
  setExpensesCostType,
  setExpensesTrade,
  updateExpense,
} from "~/server/repo/expense";
import { createProduct, deleteProducts } from "~/server/repo/product";
import { createProject, deleteProjects } from "~/server/repo/project";
import {
  deletePurchases,
  getPurchaseByID,
  getPurchaseExpenses,
  purchaseList,
  updatePurchase,
} from "~/server/repo/purchase";
import {
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  resolveLiveShortcode,
  resolveShortcode,
} from "~/server/repo/shortcode-resolver";
import { vendorOptions } from "~/server/repo/vendor";

/**
 * `vendor` on the create input still resolves into a real `Vendor` + `Purchase`
 * (see `resolveCharge`), so a row created by NAME comes back carrying the ids
 * every filter and grouping assertion below needs. Throwing rather than
 * asserting inline keeps the id non-nullable at the call site.
 *
 * Both `vendorId` and `purchaseId` on `ExpenseOut` are shortcodes now (the
 * public boundary) — see `purchaseUuid` below for the call sites that still
 * need the internal uuid `getPurchaseByID`/`getPurchaseExpenses` key on.
 */
/**
 * `createExpense`/`updateExpense` hand back `{ output, entityId }` — the uuid is
 * for audit/side-effect bookkeeping. These tests assert on the public shape.
 */
const unwrap = async <T>(p: Promise<{ output: T }>): Promise<T> =>
  (await p).output;

const vendorIdOf = (expense: ExpenseOut): VendorShortcode => {
  if (!expense.vendorId) {
    throw new Error(`expected a resolved vendor on "${expense.name}"`);
  }
  return expense.vendorId;
};

const purchaseIdOf = (expense: ExpenseOut): PurchaseShortcode => {
  if (!expense.purchaseId) {
    throw new Error(`expected a resolved charge on "${expense.name}"`);
  }
  return expense.purchaseId;
};

/**
 * `getPurchaseByID`/`getPurchaseExpenses` still key on the charge's internal
 * uuid; `purchaseIdOf` only ever hands back the public shortcode. Resolve the
 * call sites that need it.
 *
 * Through `resolveShortcode`, NOT `resolveLiveShortcode` — a charge that just
 * got folded away (`foldChargeInto`) is soft-deleted but its uuid is still a
 * valid, queryable row (e.g. `getPurchaseExpenses` on a vacated charge must
 * still resolve, to prove it now has zero live lines).
 */
const purchaseUuid = async (
  db: Database,
  code: PurchaseShortcode,
): Promise<PurchaseId> => {
  const resolved = await resolveShortcode(db, code);
  if (!resolved) throw new Error(`purchase not found: ${code}`);
  return unsafePurchaseId(resolved.id);
};

// NB: project rollup contribution (spend/expenseCount/subtree) and
// project-delete-blocking-on-live-expenses are already covered in
// project.integration.test.ts ("rolls up spend..." and "blocks deletion
// while live tasks or expenses still reference the project") — not
// re-asserted here.

describe("expense repository — CRUD", () => {
  const ctx = withTestDb();

  it("creates, reads (with projectName join), updates (incl. clearing date/projectId), and deletes", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "expense crud project" }),
      ctx.actor,
    );

    const { output: created } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "test faucet",
        projectId: project.id,
        cost: 42.5,
        date: "2026-01-15",
        url: "https://example.com/faucet",
        notes: "brushed nickel",
        future: false,
      }),
      ctx.actor,
    );

    const read = await getExpenseByShortcode(ctx.db, created.id);
    expect(read).toMatchObject({
      name: "test faucet",
      cost: 42.5,
      date: "2026-01-15",
      costType: "materials",
      trade: "plumbing",
      url: "https://example.com/faucet",
      notes: "brushed nickel",
      future: false,
      projectId: project.id,
      projectName: project.name,
    });

    const { output: updated } = await updateExpense(
      ctx.db,
      created.id,
      { name: "updated faucet", cost: 55, projectId: null },
      ctx.actor,
    );
    expect(updated.name).toBe("updated faucet");
    expect(updated.cost).toBe(55);
    expect(updated.date).toBe("2026-01-15");
    expect(updated.projectId).toBeNull();
    expect(updated.projectName).toBeNull();

    await deleteExpenses(ctx.db, [created.id], ctx.actor);

    // Unlike `getExpenseByID`, `getExpenseByShortcode` never throws — it
    // resolves to null for a soft-deleted (or otherwise unresolvable) code.
    expect(await getExpenseByShortcode(ctx.db, created.id)).toBeNull();

    const { data } = await expenseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(data.map((p) => p.id)).not.toContain(created.id);
  });

  it("reports affected and newly empty Purchases while retaining sibling lines", async () => {
    const { output: retained } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "retained purchase line",
          vendor: "Deletion Outcome Vendor",
          orderId: "DELETE-OUTCOME-1",
        }),
      ),
      ctx.actor,
    );
    const { output: sibling } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "deleted sibling line",
          vendor: "Deletion Outcome Vendor",
          orderId: "DELETE-OUTCOME-1",
        }),
      ),
      ctx.actor,
    );
    const { output: only } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "deleted only line",
          vendor: "Deletion Outcome Vendor",
          orderId: "DELETE-OUTCOME-2",
        }),
      ),
      ctx.actor,
    );

    const result = await deleteExpensesWithPurchaseEffects(
      ctx.db,
      [sibling.id, only.id],
      ctx.actor,
    );

    expect(result.result).toEqual({
      deleted: 2,
      deletedIds: expect.arrayContaining([sibling.id, only.id]),
      affectedPurchaseIds: expect.arrayContaining([
        retained.purchaseId,
        only.purchaseId,
      ]),
      newlyEmptyPurchaseIds: [only.purchaseId],
    });
    expect(await getExpenseByShortcode(ctx.db, retained.id)).not.toBeNull();
    expect(await getExpenseByShortcode(ctx.db, sibling.id)).toBeNull();
    expect(await getExpenseByShortcode(ctx.db, only.id)).toBeNull();
  });
});

describe("expense repository — expenseList filters", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("filters by search, costType, trade, future", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "materials",
        name: "copper pipe",
        future: false,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "electrical",
        costType: "tools",
        name: "wire strippers",
        future: true,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "services",
        name: "plumber visit",
        future: false,
      }),
      ctx.actor,
    );

    const bySearch = await expenseList(
      ctx.db,
      { search: "copper" },
      [],
      pagination,
    );
    expect(bySearch.data.map((p) => p.name)).toEqual(["copper pipe"]);

    const byCostType = await expenseList(
      ctx.db,
      { costType: "tools" },
      [],
      pagination,
    );
    expect(byCostType.data.map((p) => p.name)).toEqual(["wire strippers"]);

    const byTrade = await expenseList(
      ctx.db,
      { trade: "plumbing" },
      [],
      pagination,
    );
    expect(new Set(byTrade.data.map((p) => p.name))).toEqual(
      new Set(["copper pipe", "plumber visit"]),
    );

    const futureOnly = await expenseList(
      ctx.db,
      { future: true },
      [],
      pagination,
    );
    expect(futureOnly.data.map((p) => p.name)).toEqual(["wire strippers"]);

    const notFuture = await expenseList(
      ctx.db,
      { future: false },
      [],
      pagination,
    );
    expect(new Set(notFuture.data.map((p) => p.name))).toEqual(
      new Set(["copper pipe", "plumber visit"]),
    );
  });

  it("filters by projectId, and projectId + includeSubProjects over a 3-level chain", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "filter parent" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "filter child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    const { output: grandchild } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "filter grandchild",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    const { output: other } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "unrelated project" }),
      ctx.actor,
    );

    for (const [proj, name] of [
      [parent, "parent expense"],
      [child, "child expense"],
      [grandchild, "grandchild expense"],
      [other, "unrelated expense"],
    ] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "materials",
          name,
          projectId: proj.id,
        }),
        ctx.actor,
      );
    }

    const directOnly = await expenseList(
      ctx.db,
      { projectId: parent.id },
      [],
      pagination,
    );
    expect(directOnly.data.map((p) => p.name)).toEqual(["parent expense"]);

    const subtree = await expenseList(
      ctx.db,
      { projectId: parent.id, includeSubProjects: true },
      [],
      pagination,
    );
    expect(new Set(subtree.data.map((p) => p.name))).toEqual(
      new Set(["parent expense", "child expense", "grandchild expense"]),
    );
    expect(subtree.data.map((p) => p.name)).not.toContain("unrelated expense");
  });

  it("filters by dateFrom/dateTo with inclusive boundaries", async () => {
    const { output: inWindow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "in window",
        date: "2026-02-15",
      }),
      ctx.actor,
    );
    const { output: lowerBoundary } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on lower boundary",
        date: "2026-02-01",
      }),
      ctx.actor,
    );
    const { output: upperBoundary } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "on upper boundary",
        date: "2026-02-28",
      }),
      ctx.actor,
    );
    const { output: beforeWindow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "before window",
        date: "2026-01-01",
      }),
      ctx.actor,
    );
    const { output: afterWindow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "after window",
        date: "2026-03-01",
      }),
      ctx.actor,
    );
    const windowed = await expenseList(
      ctx.db,
      { dateFrom: "2026-02-01", dateTo: "2026-02-28" },
      [],
      pagination,
    );
    expect(new Set(windowed.data.map((p) => p.id))).toEqual(
      new Set([inWindow.id, lowerBoundary.id, upperBoundary.id]),
    );
    expect(windowed.data.map((p) => p.id)).not.toContain(beforeWindow.id);
    expect(windowed.data.map((p) => p.id)).not.toContain(afterWindow.id);

    // dateFrom alone — open upper bound.
    const fromOnly = await expenseList(
      ctx.db,
      { dateFrom: "2026-02-28" },
      [],
      pagination,
    );
    expect(new Set(fromOnly.data.map((p) => p.id))).toEqual(
      new Set([upperBoundary.id, afterWindow.id]),
    );

    // dateTo alone — open lower bound.
    const toOnly = await expenseList(
      ctx.db,
      { dateTo: "2026-02-01" },
      [],
      pagination,
    );
    expect(new Set(toOnly.data.map((p) => p.id))).toEqual(
      new Set([beforeWindow.id, lowerBoundary.id]),
    );
  });

  it("filters by costMin/costMax (inclusive boundary, outside window, null-cost excluded)", async () => {
    const mk = (name: string, cost: number | undefined) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "other",
            costType: "materials",
            name,
            ...(cost === undefined ? {} : { cost }),
          }),
          ctx.actor,
        ),
      );

    const lowerBoundary = await mk("cost on lower boundary", 100);
    const inWindow = await mk("cost in window", 250);
    const upperBoundary = await mk("cost on upper boundary", 500);
    const belowWindow = await mk("cost below window", 99.99);
    const aboveWindow = await mk("cost above window", 500.01);
    const credit = await mk("cost credit", -96.67);
    const zero = await mk("cost zero", 0);
    const nullCost = await mk("cost not recorded", undefined);
    expect(nullCost.cost).toBeNull();

    const windowed = await expenseList(
      ctx.db,
      { costMin: 100, costMax: 500 },
      [],
      pagination,
    );
    expect(new Set(windowed.data.map((p) => p.id))).toEqual(
      new Set([lowerBoundary.id, inWindow.id, upperBoundary.id]),
    );
    // Null cost falls out of the window by SQL semantics, exactly as a null
    // date does — `costPresenceFilter: "none"` is the filter for those rows.
    expect(windowed.data.map((p) => p.id)).not.toContain(nullCost.id);
    expect(windowed.data.map((p) => p.id)).not.toContain(belowWindow.id);
    expect(windowed.data.map((p) => p.id)).not.toContain(aboveWindow.id);

    // costMin alone — open upper bound.
    const fromOnly = await expenseList(
      ctx.db,
      { costMin: 500 },
      [],
      pagination,
    );
    expect(new Set(fromOnly.data.map((p) => p.id))).toEqual(
      new Set([upperBoundary.id, aboveWindow.id]),
    );

    // costMax alone — open lower bound. Credits are BELOW zero, so they are in.
    const toOnly = await expenseList(ctx.db, { costMax: 0 }, [], pagination);
    expect(new Set(toOnly.data.map((p) => p.id))).toEqual(
      new Set([credit.id, zero.id]),
    );

    // The guard-style regression: `costMin: 0` is a real bound, not a falsy
    // no-op. A truthiness check here would return the credit row too.
    const nonNegative = await expenseList(
      ctx.db,
      { costMin: 0 },
      [],
      pagination,
    );
    expect(nonNegative.data.map((p) => p.id)).not.toContain(credit.id);
    expect(nonNegative.data.map((p) => p.id)).toContain(zero.id);

    // ...and `costMax: 0` likewise excludes every positive row rather than
    // being dropped as falsy.
    expect(toOnly.data.map((p) => p.id)).not.toContain(inWindow.id);
  });

  it("filters and sorts by recorded product quantity with nulls last", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "quantity filter product" }),
      ctx.actor,
    );
    const mk = (name: string, productQuantity: number | null) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "other",
            costType: "materials",
            name,
            productId: product.id,
            productQuantity,
          }),
          ctx.actor,
        ),
      );

    const unknown = await mk("quantity unknown", null);
    const one = await mk("quantity one", 1);
    const two = await mk("quantity two", 2);
    const five = await mk("quantity five", 5);

    const exact = await expenseList(
      ctx.db,
      { productQuantityMin: 1, productQuantityMax: 1 },
      [],
      pagination,
    );
    expect(exact.data.map((row) => row.id)).toEqual([one.id]);

    const has = await expenseList(
      ctx.db,
      { productQuantityPresenceFilter: "has", productQuantityMin: 2 },
      [],
      pagination,
    );
    expect(new Set(has.data.map((row) => row.id))).toEqual(
      new Set([two.id, five.id]),
    );

    const missing = await expenseList(
      ctx.db,
      { productQuantityPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(missing.data.map((row) => row.id)).toEqual([unknown.id]);

    const asc = await expenseList(
      ctx.db,
      {},
      [{ orderBy: "productQuantity", direction: "asc" }],
      pagination,
    );
    expect(asc.data.map((row) => row.id)).toEqual([
      one.id,
      two.id,
      five.id,
      unknown.id,
    ]);

    const desc = await expenseList(
      ctx.db,
      {},
      [{ orderBy: "productQuantity", direction: "desc" }],
      pagination,
    );
    expect(desc.data.map((row) => row.id)).toEqual([
      five.id,
      two.id,
      one.id,
      unknown.id,
    ]);
  });

  it("ORs several `search` terms over the name, and ANDs notesSearch/urlSearch", async () => {
    const { output: extractor } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "dust extractor",
        notes: "festool order CT-36",
        url: "home depot",
      }),
      ctx.actor,
    );
    const { output: chopSaw } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "chop saw",
        notes: "bosch miter",
      }),
      ctx.actor,
    );
    const { output: unrelated } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "nursery mix",
      }),
      ctx.actor,
    );

    // A bare string behaves exactly as it always did.
    const single = await expenseList(
      ctx.db,
      { search: "extractor" },
      [],
      pagination,
    );
    expect(single.data.map((p) => p.id)).toEqual([extractor.id]);

    // Several terms OR — this is the whole point. The ledger names the thing,
    // not the product, so a caller guessing at synonyms wants any of them to
    // hit. ANDing would make this strictly worse than the single-term search.
    const either = await expenseList(
      ctx.db,
      { search: ["extractor", "chop"] },
      [],
      pagination,
    );
    expect(new Set(either.data.map((p) => p.id))).toEqual(
      new Set([extractor.id, chopSaw.id]),
    );
    expect(either.data.map((p) => p.id)).not.toContain(unrelated.id);

    // notesSearch is its own column, and ANDs with the name search rather than
    // reusing its term — the bug that would otherwise zero out every search,
    // since most rows have no notes.
    const byNotes = await expenseList(
      ctx.db,
      { notesSearch: "festool" },
      [],
      pagination,
    );
    expect(byNotes.data.map((p) => p.id)).toEqual([extractor.id]);

    const nameAndNotes = await expenseList(
      ctx.db,
      { search: ["extractor", "chop"], notesSearch: "bosch" },
      [],
      pagination,
    );
    expect(nameAndNotes.data.map((p) => p.id)).toEqual([chopSaw.id]);

    // `url` routinely holds a bare pre-roster store name.
    const byUrl = await expenseList(
      ctx.db,
      { urlSearch: "home depot" },
      [],
      pagination,
    );
    expect(byUrl.data.map((p) => p.id)).toEqual([extractor.id]);

    // An all-whitespace term degrades to no constraint rather than matching
    // nothing (`formatSearchTerm` returns undefined, so `or()` collapses).
    const blank = await expenseList(ctx.db, { search: ["  "] }, [], pagination);
    expect(blank.data.map((p) => p.id)).toEqual(
      expect.arrayContaining([extractor.id, chopSaw.id, unrelated.id]),
    );
  });

  it("combines filters with AND semantics", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "combined filter project" }),
      ctx.actor,
    );
    const { output: matches } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "matches everything",
        projectId: project.id,
        date: "2026-05-10",
        future: false,
      }),
      ctx.actor,
    );
    // Right project, wrong trade.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "materials",
        name: "wrong trade",
        projectId: project.id,
        date: "2026-05-10",
        future: false,
      }),
      ctx.actor,
    );
    // Right everything, wrong date.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "wrong date",
        projectId: project.id,
        date: "2026-01-01",
        future: false,
      }),
      ctx.actor,
    );

    const result = await expenseList(
      ctx.db,
      {
        projectId: project.id,
        trade: "plumbing",
        costType: "materials",
        future: false,
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
      },
      [],
      pagination,
    );
    expect(result.data.map((p) => p.id)).toEqual([matches.id]);
  });
});

describe("expense repository — sorting/pagination", () => {
  const ctx = withTestDb();

  it("defaults to sorting by date, supports multi-sort, and reports correct total count with a small page size", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "b expense",
        cost: 10,
        date: "2026-01-02",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "an expense",
        cost: 20,
        date: "2026-01-01",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "an expense second",
        cost: 5,
        date: "2026-01-01",
      }),
      ctx.actor,
    );

    // Default sort: date.
    const byDate = await expenseList(
      ctx.db,
      {},
      [{ orderBy: "date", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(byDate.data[0]?.date).toBe("2026-01-01");
    expect(byDate.data[2]?.date).toBe("2026-01-02");

    // Multi-sort: date asc, then cost desc as a tiebreak among the two
    // same-day rows.
    const multiSort = await expenseList(
      ctx.db,
      {},
      [
        { orderBy: "date", direction: "asc" },
        { orderBy: "cost", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(multiSort.data.map((p) => p.name)).toEqual([
      "an expense",
      "an expense second",
      "b expense",
    ]);

    // Small page size — count still reflects the full unpaginated total.
    const { data: page, count } = await expenseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 2,
    });
    expect(page).toHaveLength(2);
    expect(count).toBe(3);
  });

  it("keeps tied sort values disjoint and exhaustive across the 100-row boundary", async () => {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const shortcode = (value: number) => {
      let remaining = value;
      let body = "";
      for (let position = 0; position < 4; position += 1) {
        body = alphabet[remaining % alphabet.length]! + body;
        remaining = Math.floor(remaining / alphabet.length);
      }
      return `EXP-${body}`;
    };

    await getDb(ctx.db)
      .insert(expenseTable)
      .values(
        Array.from({ length: 105 }, (_, index) => ({
          shortcode: shortcode(index),
          name: `boundary expense ${index}`,
          date: "2026-03-24",
          costType: "materials" as const,
          trade: "other" as const,
        })),
      );

    const sort = [{ orderBy: "date", direction: "desc" as const }];
    const first = await expenseList(ctx.db, {}, sort, {
      pageIndex: 0,
      pageSize: 100,
    });
    const second = await expenseList(ctx.db, {}, sort, {
      pageIndex: 1,
      pageSize: 100,
    });
    const repeatedFirst = await expenseList(ctx.db, {}, sort, {
      pageIndex: 0,
      pageSize: 100,
    });

    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(first.count).toBe(105);
    expect(first.data).toHaveLength(100);
    expect(second.data).toHaveLength(5);
    expect(new Set(ids).size).toBe(105);
    expect(repeatedFirst.data.map((row) => row.id)).toEqual(
      first.data.map((row) => row.id),
    );
  });
});

describe("expense router", () => {
  const ctx = withTestDb();

  it("chartData returns the filtered set", async () => {
    const caller = createTestCaller(expenseRouter, ctx.db);
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "materials",
        name: "chart match",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "electrical",
        costType: "materials",
        name: "chart non-match",
      }),
      ctx.actor,
    );

    const result = await caller.chartData({ trade: "plumbing" });
    expect(result.map((p) => p.name)).toEqual(["chart match"]);
  });

  describe("projectPresenceFilter", () => {
    /** One assigned expense, one unassigned, plus a decoy in another project. */
    const seedProjectMix = async () => {
      const [{ output: projA }, { output: projB }] = await Promise.all([
        createProject(
          ctx.db,
          projectCreateInput.parse({ name: "assigned home" }),
          ctx.actor,
        ),
        createProject(
          ctx.db,
          projectCreateInput.parse({ name: "other home" }),
          ctx.actor,
        ),
      ]);
      for (const [name, projectId] of [
        ["has a project", projA.id],
        ["other project", projB.id],
        ["needs a project", undefined],
      ] as const) {
        await createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "drywall",
            costType: "tools",
            name,
            ...(projectId ? { projectId } : {}),
          }),
          ctx.actor,
        );
      }
      return { projA, projB };
    };

    it("'none' returns only unassigned expenses", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      await seedProjectMix();

      const rows = await caller.chartData({ projectPresenceFilter: "none" });
      const names = rows.map((p) => p.name);
      expect(names).toContain("needs a project");
      expect(names).not.toContain("has a project");
      expect(names).not.toContain("other project");
    });

    it("'has' returns only assigned expenses", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      await seedProjectMix();

      const names = (
        await caller.chartData({ projectPresenceFilter: "has" })
      ).map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(["has a project", "other project"]),
      );
      expect(names).not.toContain("needs a project");
    });

    // The case the old `noProject` boolean could not express at all: it AND-ed
    // with projectId, so this pair matched nothing. Presence now ORs.
    it("combines with projectId as OR — that project plus the unassigned", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      const { projA } = await seedProjectMix();

      const names = (
        await caller.chartData({
          projectId: [projA.id],
          projectPresenceFilter: "none",
        })
      ).map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(["has a project", "needs a project"]),
      );
      expect(names).not.toContain("other project");
    });

    // buildExpenseWhereClause backs BOTH the ledger list and the analytics
    // aggregates; this pins that they still agree through the new OR branch.
    it("keeps ledger totals and analytics totals in agreement", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      const { projA } = await seedProjectMix();
      const filters = {
        projectId: [projA.id],
        projectPresenceFilter: "none" as const,
      };

      const [listed, analytics] = await Promise.all([
        caller.list({ filters }),
        caller.analytics(filters),
      ]);

      expect(analytics.summary.count).toBe(listed.items.length);
      expect(analytics.summary.net).toBeCloseTo(
        listed.items.reduce((sum, p) => sum + (p.cost ?? 0), 0),
        2,
      );
    });
  });

  describe("chargeContext", () => {
    it("returns canonical charge identity and the other lines, excluding the expense itself", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      const orderId = "111-siblings-0000001";
      const [{ output: self }, { output: sibling }] = await Promise.all([
        createExpense(
          ctx.db,
          makeExpenseInput({
            name: "sibling source row",
            vendor: "Amazon",
            orderId,
          }),
          ctx.actor,
        ),
        createExpense(
          ctx.db,
          makeExpenseInput({
            name: "the other line",
            vendor: "Amazon",
            orderId,
          }),
          ctx.actor,
        ),
      ]);
      // A line of a DIFFERENT charge, to prove the scope is the charge and not
      // the vendor.
      await createExpense(
        ctx.db,
        makeExpenseInput({ name: "unrelated amazon buy", vendor: "Amazon" }),
        ctx.actor,
      );

      // Charge date and ledger date are separate domain fields. The link label
      // must use this canonical Purchase date, never `self.date`.
      const chargeDate = "2026-07-30";
      await updatePurchase(
        ctx.db,
        {
          id: purchaseIdOf(self),
          data: { date: chargeDate },
        },
        ctx.actor,
      );

      const context = await caller.chargeContext(self.id);
      expect(context?.purchase).toEqual({
        id: purchaseIdOf(self),
        orderId,
        displayLabel: null,
        date: chargeDate,
        vendorId: vendorIdOf(self),
        vendorName: "Amazon",
      });
      // `getPurchaseExpenses` includes the source row (the charge total needs
      // it); the detail section filters itself out here, so a single-line charge
      // renders nothing rather than a list of one.
      expect(context?.siblings.map((p) => p.id)).toEqual([sibling.id]);
    });

    it("returns null for an expense with no charge — without early-returning on a missing order id", async () => {
      const caller = createTestCaller(expenseRouter, ctx.db);
      const { output: chargeless } = await createExpense(
        ctx.db,
        makeExpenseInput({ name: "cash, no vendor" }),
        ctx.actor,
      );
      expect(chargeless.purchaseId).toBeNull();
      expect(await caller.chargeContext(chargeless.id)).toBeNull();

      // The distinction the old `orderSiblings` got wrong: it bailed on a missing
      // ORDER ID, which would have hidden this section for the 33% of
      // vendor-bearing rows that have none — even though they sit on a real
      // charge with real siblings. Gating on `purchaseId` instead is what fixed
      // it.
      const { output: orderless } = await createExpense(
        ctx.db,
        makeExpenseInput({ name: "walk-in line a", vendor: "Tool Nirvana" }),
        ctx.actor,
      );
      const { output: alsoOnThatCharge } = await createExpense(
        ctx.db,
        makeExpenseInput({
          name: "walk-in line b",
          purchaseId: purchaseIdOf(orderless),
        }),
        ctx.actor,
      );
      expect(orderless.orderId).toBeNull();
      const context = await caller.chargeContext(orderless.id);
      expect(context?.purchase.orderId).toBeNull();
      expect(context?.purchase.vendorName).toBe("Tool Nirvana");
      expect(context?.siblings.map((p) => p.id)).toEqual([alsoOnThatCharge.id]);
    });
  });

  it("tradeAffinity counts assigned expenses per project and trade", async () => {
    const caller = createTestCaller(expenseRouter, ctx.db);
    const { output: proj } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "affinity project" }),
      ctx.actor,
    );
    for (const trade of ["drywall", "drywall", "electrical"] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade,
          costType: "materials",
          name: `affinity ${trade}`,
          projectId: proj.id,
        }),
        ctx.actor,
      );
    }
    // Unassigned rows have no project to weight, so they must not appear.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "drywall",
        costType: "materials",
        name: "affinity unassigned",
      }),
      ctx.actor,
    );

    const matrix = await caller.tradeAffinity();
    const forProject = matrix.filter((row) => row.projectId === proj.id);
    expect(forProject.find((row) => row.trade === "drywall")?.count).toBe(2);
    expect(forProject.find((row) => row.trade === "electrical")?.count).toBe(1);
  });

  it("bulkMove moves expenses to another project and to the inbox (null), returning items + sideEffects", async () => {
    const caller = createTestCaller(expenseRouter, ctx.db);
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "bulk move a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "bulk move b" }),
      ctx.actor,
    );
    const { output: p1 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "bulk move expense 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: p2 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "bulk move expense 2",
        projectId: projectA.id,
      }),
      ctx.actor,
    );

    const toB = await caller.bulkMove({
      ids: [p1.id, p2.id],
      projectId: projectB.id,
    });
    expect(toB.items.map((i) => i.projectId)).toEqual([
      projectB.id,
      projectB.id,
    ]);
    expect(toB.sideEffects).toBeDefined();

    // expenseBulkMoveInput allows a null projectId — moves to the inbox.
    const toInbox = await caller.bulkMove({
      ids: [p1.id, p2.id],
      projectId: null,
    });
    expect(toInbox.items.every((i) => i.projectId === null)).toBe(true);
    expect(toInbox.sideEffects).toBeDefined();
  });
});

describe("expense repository — moveExpenses", () => {
  const ctx = withTestDb();

  it("moves rows to the new projectId and writes an audit entry per changed row", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses a" }),
      ctx.actor,
    );
    const { output: projectB, entityId: projectBId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses b" }),
      ctx.actor,
    );
    const { output: p1, entityId: p1Id } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "move me 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: p2 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "move me 2",
        projectId: projectA.id,
      }),
      ctx.actor,
    );

    const moved = await moveExpenses(
      ctx.db,
      { ids: [p1.id, p2.id], projectId: projectB.id },
      ctx.actor,
    );
    expect(moved.map((p) => p.projectId)).toEqual([projectB.id, projectB.id]);

    // `getAuditLog`'s `entityId` matches the internal uuid, not the shortcode
    // — and so does the diff `computeChanges` records for `projectId` itself,
    // since that's the raw FK column value, not the public shortcode.
    const auditP1 = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: p1Id,
      limit: 20,
    });
    expect(
      auditP1.entries.some(
        (e) =>
          e.action === "update" &&
          (e.changes as { projectId?: { from: unknown; to: unknown } } | null)
            ?.projectId?.to === projectBId,
      ),
    ).toBe(true);
  });

  it("leaves soft-deleted ids in the input untouched", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses untouched a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses untouched b" }),
      ctx.actor,
    );
    const { output: live } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "still live",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: deleted } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "soon deleted",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

    const moved = await moveExpenses(
      ctx.db,
      { ids: [live.id, deleted.id], projectId: projectB.id },
      ctx.actor,
    );
    // Only the live row comes back — the soft-deleted id is silently excluded,
    // not moved.
    expect(moved.map((p) => p.id)).toEqual([live.id]);
  });

  it("rejects a nonexistent or soft-deleted target project with PROJECT_NOT_FOUND", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses reject source" }),
      ctx.actor,
    );
    const { output: expenseRow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "reject target",
        projectId: project.id,
      }),
      ctx.actor,
    );
    const bogusProjectId = unsafeProjectShortcode(
      "00000000-0000-0000-0000-000000000000",
    );

    await expect(
      moveExpenses(
        ctx.db,
        { ids: [expenseRow.id], projectId: bogusProjectId },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PROJECT_NOT_FOUND" },
    });

    const { output: deletedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "soon-deleted target" }),
      ctx.actor,
    );
    await deleteProjects(ctx.db, [deletedProject.id], ctx.actor);

    await expect(
      moveExpenses(
        ctx.db,
        { ids: [expenseRow.id], projectId: deletedProject.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PROJECT_NOT_FOUND" },
    });
  });

  it("no-op on an id list with only nonexistent ids (returns empty, no error)", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move expenses noop project" }),
      ctx.actor,
    );
    const bogusId = unsafeExpenseShortcode("EXP-ZZZZ");

    const moved = await moveExpenses(
      ctx.db,
      { ids: [bogusId], projectId: project.id },
      ctx.actor,
    );
    expect(moved).toEqual([]);
  });
});

/**
 * The two bulk enum writers behind the ledger's selection toolbar
 * (`expense-bulk-actions.tsx` → `bulkSetTrade` / `bulkSetCostType`). Same shape
 * as `moveExpenses` minus the FK assert — a plain audited column write over
 * `ids` — so what's worth pinning is the part that isn't the column write: the
 * audit entry fires only for rows whose value actually CHANGED, and a
 * soft-deleted id is skipped rather than resurrected.
 */
describe("expense repository — bulk trade / cost-type writes", () => {
  const ctx = withTestDb();

  const line = (name: string, overrides: Partial<ExpenseCreateInput> = {}) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput({ name, ...overrides })),
      ctx.actor,
    );

  /** `update` audit entries for one expense — keyed on the internal uuid. */
  const updateEntries = async (id: ExpenseId) =>
    (
      await getAuditLog(ctx.db, {
        entityType: "expense",
        entityId: id,
        limit: 50,
      })
    ).entries.filter((e) => e.action === "update");

  const changeOf = (
    entry: { changes: unknown } | undefined,
    field: "trade" | "costType",
  ) =>
    (entry?.changes as Record<string, { from: unknown; to: unknown }> | null)?.[
      field
    ];

  it("setExpensesTrade writes the trade over the listed ids only, and audits just the rows that changed", async () => {
    const { output: a, entityId: aId } = await line("bulk trade a", {
      trade: "other",
    });
    const { output: b } = await line("bulk trade b", { trade: "other" });
    // Already carries the target value: it must be written (harmlessly) but NOT
    // audited — `computeChanges` returns null, so the `if (changes)` arm skips it.
    const { output: already, entityId: alreadyId } = await line(
      "bulk trade already electrical",
      { trade: "electrical" },
    );
    const { output: untouched } = await line("bulk trade bystander", {
      trade: "plumbing",
    });

    const updated = await setExpensesTrade(
      ctx.db,
      { ids: [a.id, b.id, already.id], trade: "electrical" },
      ctx.actor,
    );

    expect(updated.map((row) => row.trade)).toEqual([
      "electrical",
      "electrical",
      "electrical",
    ]);
    // Not in `ids` — a bulk write must never widen past its selection.
    expect((await getExpenseByShortcode(ctx.db, untouched.id))?.trade).toBe(
      "plumbing",
    );

    expect(changeOf((await updateEntries(aId))[0], "trade")).toEqual({
      from: "other",
      to: "electrical",
    });
    expect(await updateEntries(alreadyId)).toHaveLength(0);
  });

  it("setExpensesTrade skips soft-deleted ids and returns [] when nothing live matches", async () => {
    const { output: live } = await line("bulk trade live", { trade: "other" });
    const { output: deleted } = await line("bulk trade deleted", {
      trade: "other",
    });
    await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

    const updated = await setExpensesTrade(
      ctx.db,
      { ids: [live.id, deleted.id], trade: "flooring" },
      ctx.actor,
    );
    expect(updated.map((row) => row.id)).toEqual([live.id]);

    // `before.length === 0` returns before any write, so an all-dead selection is
    // a silent no-op rather than an error.
    expect(
      await setExpensesTrade(
        ctx.db,
        { ids: [deleted.id], trade: "flooring" },
        ctx.actor,
      ),
    ).toEqual([]);
  });

  it("setExpensesCostType writes the cost type and audits only the changed rows", async () => {
    const { output: a, entityId: aId } = await line("bulk costType a", {
      costType: "materials",
    });
    const { output: already, entityId: alreadyId } = await line(
      "bulk costType already tools",
      { costType: "tools" },
    );

    const updated = await setExpensesCostType(
      ctx.db,
      { ids: [a.id, already.id], costType: "tools" },
      ctx.actor,
    );
    expect(updated.map((row) => row.costType)).toEqual(["tools", "tools"]);

    expect(changeOf((await updateEntries(aId))[0], "costType")).toEqual({
      from: "materials",
      to: "tools",
    });
    expect(await updateEntries(alreadyId)).toHaveLength(0);
  });
});

describe("expense repository — expenseAnalytics", () => {
  const ctx = withTestDb();

  it("aggregates match manual arithmetic, omits empty categories, and stays consistent with expenseList under the same filter", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project b" }),
      ctx.actor,
    );

    // p1: actual spend, plumbing/materials, projectA, dated Jan.
    const { output: p1 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "analytics p1 actual",
        projectId: projectA.id,
        cost: 100,
        date: "2026-01-10",
        future: false,
      }),
      ctx.actor,
    );
    // p2: committed (future) spend, plumbing/materials, projectA, dated Jan.
    const { output: p2 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2026-01-20",
        trade: "plumbing",
        costType: "materials",
        name: "analytics p2 committed",
        projectId: projectA.id,
        cost: 50,
        future: true,
      }),
      ctx.actor,
    );
    // p3: a credit/refund (negative cost), electrical/materials, no project (inbox), dated Jan.
    const { output: p3 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "materials",
        name: "analytics p3 credit",
        cost: -20,
        date: "2026-01-15",
        future: false,
      }),
      ctx.actor,
    );
    // p4: actual spend, electrical/services, projectB, dated Feb.
    const { output: p4 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "services",
        name: "analytics p4 actual",
        projectId: projectB.id,
        cost: 30,
        date: "2026-02-01",
        future: false,
      }),
      ctx.actor,
    );

    const filters = { search: "analytics p" };
    const result = await expenseAnalytics(ctx.db, filters);

    // --- summary: actual=100+30, committed=50, credits=20, net=160 ---
    expect(result.summary).toEqual({
      actual: 130,
      committed: 50,
      credits: 20,
      net: 160,
      count: 4,
      actualCount: 3, // p1, p3, p4 (future: false)
      plannedCount: 1, // p2
    });

    // --- byCostType: only materials/services appear (no other costType seeded) ---
    expect(result.byCostType).toEqual(
      expect.arrayContaining([
        {
          costType: "materials",
          actual: 100,
          committed: 50,
          credits: 20,
          net: 130,
          count: 3,
        },
        {
          costType: "services",
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );
    expect(result.byCostType).toHaveLength(2);

    // --- byTrade: plumbing + electrical only ---
    expect(result.byTrade).toEqual(
      expect.arrayContaining([
        {
          trade: "plumbing",
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
        },
        {
          trade: "electrical",
          actual: 30,
          committed: 0,
          credits: 20,
          net: 10,
          count: 2,
        },
      ]),
    );
    expect(result.byTrade).toHaveLength(2);

    // --- tradeCostMatrix: the 3 combos actually present, not the full cross product ---
    expect(result.tradeCostMatrix).toHaveLength(3);
    expect(result.tradeCostMatrix).toEqual(
      expect.arrayContaining([
        {
          trade: "plumbing",
          costType: "materials",
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
        },
        {
          trade: "electrical",
          costType: "materials",
          actual: 0,
          committed: 0,
          credits: 20,
          net: -20,
          count: 1,
        },
        {
          trade: "electrical",
          costType: "services",
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );

    // --- monthly: Jan (p1, p2, p3) and Feb (p4) ---
    expect(result.monthly).toEqual([
      {
        month: "2026-01",
        actual: 100,
        committed: 50,
        credits: 20,
        net: 130,
        count: 3,
      },
      {
        month: "2026-02",
        actual: 30,
        committed: 0,
        credits: 0,
        net: 30,
        count: 1,
      },
    ]);

    // --- cumulative: running sum of monthly.net, ascending ---
    expect(result.cumulative).toEqual([
      { month: "2026-01", cumulativeNet: 130 },
      { month: "2026-02", cumulativeNet: 160 },
    ]);

    // --- byProject: p3 (no project) excluded ---
    expect(result.byProject).toEqual(
      expect.arrayContaining([
        {
          projectId: projectA.id,
          projectName: projectA.name,
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
        },
        {
          projectId: projectB.id,
          projectName: projectB.name,
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );
    expect(result.byProject).toHaveLength(2);

    // --- core invariant: analytics totals agree with expenseList's visible
    // rows under the SAME filter — sum expenseList's `cost` column and
    // compare against summary.net (both should equal 160). ---
    const { data: listedRows } = await expenseList(ctx.db, filters, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(listedRows.map((p) => p.id).sort()).toEqual(
      [p1.id, p2.id, p3.id, p4.id].sort(),
    );
    const summedCost = listedRows.reduce((sum, p) => sum + (p.cost ?? 0), 0);
    expect(summedCost).toBe(result.summary.net);
  });

  it("groups byVendor through the charge, and does NOT sum to summary.net", async () => {
    const mk = (name: string, cost: number, vendor?: string) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            trade: "other",
            costType: "tools",
            name,
            cost,
            future: false,
            date: "2026-04-01",
            ...(vendor ? { vendor } : {}),
          }),
          ctx.actor,
        ),
      );

    const acmeA = await mk("vendor acme a", 100, "Analytics Acme");
    const acmeB = await mk("vendor acme b", 25, "Analytics Acme");
    // A credit against the same vendor — negative rows are real here, and the
    // vendor's net must telescope rather than being filtered out.
    await mk("vendor acme refund", -25, "Analytics Acme");
    await mk("vendor other", 40, "Analytics Other");
    // No vendor recorded: no charge to attach to, so the inner join drops it.
    // This is the row that makes byVendor disagree with summary.net.
    const vendorless = await mk("vendor none", 60);
    expect(vendorless.purchaseId).toBeNull();

    const result = await expenseAnalytics(ctx.db, { dateFrom: "2026-04-01" });

    const acme = result.byVendor.find((r) => r.vendorName === "Analytics Acme");
    expect(acme).toMatchObject({
      vendorId: vendorIdOf(acmeA),
      vendorName: "Analytics Acme",
      actual: 125,
      committed: 0,
      credits: 25,
      net: 100,
      count: 3,
    });
    // Both lines resolved onto the SAME vendor by name, so the group key is one
    // id rather than two spellings.
    expect(vendorIdOf(acmeB)).toBe(vendorIdOf(acmeA));

    expect(
      result.byVendor.find((r) => r.vendorName === "Analytics Other")?.net,
    ).toBe(40);
    expect(result.byVendor.map((r) => r.vendorName)).not.toContain(null);

    // --- the asymmetry, asserted rather than treated as a bug ---
    // byVendor is an INNER join, so the charge-less row is excluded and the
    // vendor nets total LESS than summary.net. The gap is exactly that row.
    const vendorNet = result.byVendor.reduce((sum, r) => sum + r.net, 0);
    expect(vendorNet).toBe(140);
    expect(result.summary.net).toBe(200);
    expect(result.summary.net - vendorNet).toBe(60);
  });

  it("applies the same filters as expenseList (e.g. trade) so a scoped analytics call only sees the matching rows", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "plumbing",
        costType: "materials",
        name: "analytics filter match",
        cost: 10,
        future: false,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "electrical",
        costType: "materials",
        name: "analytics filter non-match",
        cost: 999,
        future: false,
      }),
      ctx.actor,
    );

    const result = await expenseAnalytics(ctx.db, {
      search: "analytics filter",
      trade: "plumbing",
    });
    expect(result.summary).toMatchObject({ net: 10, count: 1 });
    expect(result.byTrade).toEqual([
      {
        trade: "plumbing",
        actual: 10,
        committed: 0,
        credits: 0,
        net: 10,
        count: 1,
      },
    ]);
  });
});

describe("expense repository — embedding cascade invariant", () => {
  const ctx = withTestDb();

  // Full cascade coverage (seeded embedding row -> soft-deleted + orphan
  // check) lives in
  // repo/inventory/embedding-cascade-invariant.integration.test.ts's
  // "deleteExpenses leaves no orphan" case. This just re-confirms the
  // no-orphan invariant holds from this file's own delete path too.
  it("deleteExpenses leaves no orphaned EntityEmbedding rows", async () => {
    const { output: expenseRow } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "embedding cascade check",
      }),
      ctx.actor,
    );

    await deleteExpenses(ctx.db, [expenseRow.id], ctx.actor);

    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });
});

// The product bridge: an expense optionally points at the product it bought,
// and a *negative* expense on the same product records the exit (sale, return,
// or a 0-cost disposal). Money and ownership have deliberately separate
// authorities — these cases pin the read side of that.
describe("expense repository — product bridge", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("round-trips productId/vendor and resolves productName", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge miter saw" }),
      ctx.actor,
    );

    const { output: created } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "millwork",
        costType: "tools",
        name: "miter saw",
        productId: product.id,
        vendor: "Home Depot",
        cost: 180,
      }),
      ctx.actor,
    );

    const read = await getExpenseByShortcode(ctx.db, created.id);
    expect(read).toMatchObject({
      productId: product.id,
      productName: "bridge miter saw",
      vendor: "Home Depot",
    });

    const { output: cleared } = await updateExpense(
      ctx.db,
      created.id,
      { productId: null, vendor: null },
      ctx.actor,
    );
    expect(cleared.productId).toBeNull();
    expect(cleared.productName).toBeNull();
    expect(cleared.vendor).toBeNull();
  });

  it("filters by productId — acquisition and disposal rows, nothing else", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge tile saw" }),
      ctx.actor,
    );

    const { output: bought } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "flooring",
        costType: "tools",
        name: "tile saw",
        productId: product.id,
        cost: 180,
      }),
      ctx.actor,
    );
    const { output: sold } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "flooring",
        costType: "tools",
        name: "sold tile saw",
        productId: product.id,
        cost: -150,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "flooring",
        costType: "materials",
        name: "unrelated thinset",
      }),
      ctx.actor,
    );

    const { data, count } = await expenseList(
      ctx.db,
      { productId: product.id },
      [],
      pagination,
    );
    expect(count).toBe(2);
    expect(data.map((p) => p.id).sort()).toEqual([bought.id, sold.id].sort());
    // Net basis is the sum of the linked rows — the derivation the product page
    // renders, with nothing stored.
    expect(data.reduce((sum, p) => sum + (p.cost ?? 0), 0)).toBe(30);
  });

  it("deleteProducts rejects a product still referenced by a live expense", async () => {
    // This used to be permitted deliberately — a product referenced only by
    // expenses deleted fine, and the dangling link degraded to a null
    // display name via resolveLiveJoinName. That was reversed
    // (PRODUCT_HAS_EXPENSES, mirroring PRODUCT_HAS_INVENTORY): the ledger's
    // net cost and owned/sold window are derived from these rows, and a
    // nameless product would silently corrupt that derivation with no
    // restore path. See expense repository — productPresenceFilter's "has"
    // still counts an expense whose linked product was later soft-deleted"
    // below for the (still-real) dangling-link read path, produced by writing
    // deletedAt directly rather than through this now-blocked guard.
    const bridgeDoomedDrill = await createProduct(
      ctx.db,
      makeProductInput({ name: "bridge doomed drill" }),
      ctx.actor,
    );
    const { output: created } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "doomed drill",
        productId: bridgeDoomedDrill.id,
      }),
      ctx.actor,
    );

    await expect(
      deleteProducts(
        ctx.db,
        [
          unsafeProductId(
            (await resolveLiveShortcode(
              ctx.db,
              bridgeDoomedDrill.id,
              "product",
            ))!,
          ),
        ],
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: { reason: "PRODUCT_HAS_EXPENSES" },
    });

    const read = await getExpenseByShortcode(ctx.db, created.id);
    expect(read?.productId).toBe(bridgeDoomedDrill.id);
    expect(read?.productName).toBe("bridge doomed drill");
  });

  it("still matches name search when vendor is null", async () => {
    // Regression gate: vendor must never join the `search` term, because
    // buildSearchConditions ANDs its searchFilters — `name ILIKE q AND vendor
    // ILIKE q` would return nothing for the (overwhelming) null-vendor rows.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "vendorless grommets",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { search: "grommets" },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toContain("vendorless grommets");
  });

  it("filters by vendor id independently of search", async () => {
    const { output: lumber } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "lumber run",
        vendor: "Ganahl Lumber",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "screws",
        vendor: "Home Depot",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { vendorId: vendorIdOf(lumber) },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toEqual(["lumber run"]);
  });

  it("can't leak a vendor whose name is a prefix of another's", async () => {
    // The class of bug the old exact-string match existed to prevent ("Amazon
    // (254)" also dragging in "Amazon Business") is gone by construction now:
    // two names are two rows in the `Vendor` roster, so the filter compares
    // primary keys and there is no substring to leak through.
    const { output: prime } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "prime order",
        vendor: "Amazon",
      }),
      ctx.actor,
    );
    const { output: business } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "bulk order",
        vendor: "Amazon Business",
      }),
      ctx.actor,
    );
    expect(vendorIdOf(prime)).not.toBe(vendorIdOf(business));

    const { data } = await expenseList(
      ctx.db,
      { vendorId: vendorIdOf(prime) },
      [],
      pagination,
    );
    expect(data.map((p) => p.name)).toEqual(["prime order"]);
  });

  it("matches any of a set of vendor ids", async () => {
    const line = (name: string, vendor: string) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse({
            date: "2024-01-15",
            trade: "other",
            costType: "materials",
            name,
            vendor,
          }),
          ctx.actor,
        ),
      );
    const socketSet = await line("socket set", "eBay");
    const deckScrews = await line("deck screws", "Home Depot");
    await line("paint", "Lowe's");

    const { data } = await expenseList(
      ctx.db,
      { vendorId: [vendorIdOf(socketSet), vendorIdOf(deckScrews)] },
      [],
      pagination,
    );
    expect(data.map((p) => p.name).sort()).toEqual([
      "deck screws",
      "socket set",
    ]);
  });

  it("filters by purchase (charge) id directly, no vendor hop needed", async () => {
    const orderId = "111-purchaseid-filter-0000001";
    const { output: first } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "line one of the charge",
        vendor: "Amazon",
        orderId,
      }),
      ctx.actor,
    );
    const { output: second } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "line two of the charge",
        vendor: "Amazon",
        orderId,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "unrelated charge",
        vendor: "Home Depot",
      }),
      ctx.actor,
    );
    // Both lines resolved onto the same `Purchase` via `(vendor, orderId)`.
    expect(purchaseIdOf(second)).toBe(purchaseIdOf(first));

    const { data } = await expenseList(
      ctx.db,
      { purchaseId: purchaseIdOf(first) },
      [],
      pagination,
    );
    expect(data.map((p) => p.name).sort()).toEqual([
      "line one of the charge",
      "line two of the charge",
    ]);
  });

  it("finds chargeless rows via vendorPresenceFilter, and ORs with a selection", async () => {
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "cash at the yard",
      }),
      ctx.actor,
    );
    const { output: tileSaw } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "tile saw",
        vendor: "Tool Nirvana",
      }),
      ctx.actor,
    );

    // "No vendor" and "no charge" are the same predicate — `purchase.vendorId`
    // is NOT NULL, so a line either has a charge (and therefore a vendor) or has
    // neither.
    const none = await expenseList(
      ctx.db,
      { vendorPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(none.data.map((p) => p.name)).toEqual(["cash at the yard"]);

    // OR, not AND — "Tool Nirvana or nothing recorded" is one filter.
    const both = await expenseList(
      ctx.db,
      { vendorId: vendorIdOf(tileSaw), vendorPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(both.data.map((p) => p.name).sort()).toEqual([
      "cash at the yard",
      "tile saw",
    ]);
  });
});

describe("expense repository — productPresenceFilter", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it('"has" returns only expenses with a linked product', async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "presence linked drill" }),
      ctx.actor,
    );
    const { output: linked } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "linked expense",
        productId: product.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "unlinked expense",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { productPresenceFilter: "has" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id)).toContain(linked.id);
    expect(data.map((p) => p.name)).not.toContain("unlinked expense");
  });

  it('"none" returns only expenses with no linked product', async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "presence linked sander" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "linked sander expense",
        productId: product.id,
      }),
      ctx.actor,
    );
    const { output: unlinked } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "unlinked sander expense",
      }),
      ctx.actor,
    );

    const { data } = await expenseList(
      ctx.db,
      { productPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id)).toContain(unlinked.id);
    expect(data.map((p) => p.name)).not.toContain("linked sander expense");
  });

  it('"has" still counts an expense whose linked product was later soft-deleted', async () => {
    // This is the documented semantic decision (buildExpenseWhereClause,
    // repo/expense/lookup.ts): "linked" means productId IS NOT NULL, which
    // deliberately includes rows whose product was soft-deleted afterward.
    // The public relation degrades to null because a dead target has no live
    // shortcode to expose, while the private FK still drives the filter.
    //
    // The state is written directly (mirrors location.integration.test.ts's
    // "a shelf holding only a soft-deleted product counts as empty") because
    // `deleteProducts` now refuses a product with a live expense
    // (PRODUCT_HAS_EXPENSES), so the single-delete path can't produce this
    // dangling link anymore. It's still a real state worth covering — a
    // sync/import path or a future admin tool could soft-delete a product out
    // from under its expenses — so the read-side degradation stays pinned.
    const doomedRouter = await createProduct(
      ctx.db,
      makeProductInput({ name: "presence doomed router" }),
      ctx.actor,
    );
    const { output: expense } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "tools",
        name: "doomed router expense",
        productId: doomedRouter.id,
      }),
      ctx.actor,
    );

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(
        eq(
          product.id,
          unsafeProductId(
            (await resolveLiveShortcode(ctx.db, doomedRouter.id, "product"))!,
          ),
        ),
      );

    const hasFiltered = await expenseList(
      ctx.db,
      { productPresenceFilter: "has" },
      [],
      pagination,
    );
    expect(hasFiltered.data.map((p) => p.id)).toContain(expense.id);
    const stillLinked = hasFiltered.data.find((p) => p.id === expense.id);
    expect(stillLinked?.productId).toBeNull();
    expect(stillLinked?.productName).toBeNull();

    const noneFiltered = await expenseList(
      ctx.db,
      { productPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(noneFiltered.data.map((p) => p.id)).not.toContain(expense.id);
  });
});

/**
 * Charge grouping — what replaced `getExpenseOrderSiblings`. The group is a
 * parent link (`expense.purchaseId → Purchase`) resolved on write by
 * `resolveCharge`, not a `(vendor, orderId)` string match reconstructed on read,
 * so these pin where `createExpense` files a line and what
 * `getPurchaseExpenses` reads back out of one charge.
 */
describe("expense repository — charge grouping", () => {
  const ctx = withTestDb();

  const chargeLine = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) =>
    expenseCreateInput.parse({
      date: "2024-01-15",
      trade: "other",
      costType: "materials",
      name,
      cost: 10,
      vendor,
      orderId,
    });

  it("files two lines of one order onto ONE charge, where they see each other", async () => {
    const orderId = "111-charge-0000001";
    const { output: first } = await createExpense(
      ctx.db,
      chargeLine("order line one", "Amazon", orderId),
      ctx.actor,
    );
    const { output: second } = await createExpense(
      ctx.db,
      chargeLine("order line two", "Amazon", orderId),
      ctx.actor,
    );
    // Same order id under a DIFFERENT vendor is a different charge — an order id
    // is only unique within a vendor, which is exactly what the partial-unique
    // `(vendorId, orderId)` index encodes.
    const { output: collision } = await createExpense(
      ctx.db,
      chargeLine("same id, other retailer", "Home Depot", orderId),
      ctx.actor,
    );
    // Same vendor, different order — the other axis.
    const { output: otherOrder } = await createExpense(
      ctx.db,
      chargeLine("different order", "Amazon", "111-charge-0000002"),
      ctx.actor,
    );

    expect(purchaseIdOf(first)).toBe(purchaseIdOf(second));
    expect(purchaseIdOf(collision)).not.toBe(purchaseIdOf(first));
    expect(purchaseIdOf(otherOrder)).not.toBe(purchaseIdOf(first));

    // Every line of the charge, source row included — the total needs it, and
    // the detail section filters itself out (see `expense.chargeContext`).
    const lines = await getPurchaseExpenses(
      ctx.db,
      await purchaseUuid(ctx.db, purchaseIdOf(first)),
    );
    expect(lines.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
    expect(lines.map((p) => p.id)).not.toContain(collision.id);
    expect(lines.map((p) => p.id)).not.toContain(otherOrder.id);
  });

  it("keeps two order-less buys from one vendor on SEPARATE charges", async () => {
    const { output: walkInA } = await createExpense(
      ctx.db,
      chargeLine("counter sale a", "Tool Nirvana"),
      ctx.actor,
    );
    const { output: walkInB } = await createExpense(
      ctx.db,
      chargeLine("counter sale b", "Tool Nirvana"),
      ctx.actor,
    );

    // Deliberate, not a miss: `(vendorId, null)` is not unique, and grouping by
    // `(vendor, date)` instead would falsely merge real rows (71 of them, across
    // 31 groups, on the live ledger). Two walk-in buys from one store are two
    // transactions; merging near-duplicates is `mergePurchases`, a user action.
    expect(purchaseIdOf(walkInA)).not.toBe(purchaseIdOf(walkInB));
    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(walkInA)),
        )
      ).map((p) => p.id),
    ).toEqual([walkInA.id]);
    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(walkInB)),
        )
      ).map((p) => p.id),
    ).toEqual([walkInB.id]);
  });

  it("gives a line with no vendor no charge at all", async () => {
    // An order id alone can't name a transaction (they're only unique per
    // vendor), so a vendorless line gets no charge rather than an unidentifiable
    // one — and the detail page's charge section stays off for it.
    const { output: loose } = await createExpense(
      ctx.db,
      chargeLine("cash, no receipt", null, "WN-no-vendor"),
      ctx.actor,
    );
    expect(loose.purchaseId).toBeNull();
    expect(loose.vendorId).toBeNull();
    expect(loose.orderId).toBeNull();
  });

  it("excludes a soft-deleted line of the charge", async () => {
    const orderId = "111-charge-deleted";
    const { output: keep } = await createExpense(
      ctx.db,
      chargeLine("surviving line", "Amazon", orderId),
      ctx.actor,
    );
    const { output: doomed } = await createExpense(
      ctx.db,
      chargeLine("deleted line", "Amazon", orderId),
      ctx.actor,
    );

    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(keep)),
        )
      ).map((p) => p.id),
    ).toContain(doomed.id);

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(keep)),
        )
      ).map((p) => p.id),
    ).toEqual([keep.id]);
  });
});

/**
 * Charge resolution on UPDATE — `resolveCharge`'s `current` argument, which the
 * create path never exercises.
 *
 * An update is the side where a name-to-charge resolution can do damage rather
 * than just be wrong: the row is already ON a charge, so a careless re-resolve
 * re-points it and leaves the old charge behind. Nothing sweeps up empty charges
 * and there is no restore path, so a leak there is permanent — that's the bug
 * these pin.
 */
describe("expense repository — charge resolution on update", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 100 };

  const line = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) => makeExpenseInput({ name, cost: 10, vendor, orderId });

  /** Live charges belonging to one vendor — the orphan detector below. */
  const chargeCount = async (id: VendorShortcode) =>
    (await purchaseList(ctx.db, { vendorId: id }, [], page)).count;

  it("re-writing the SAME vendor onto an order-less row mints no second charge", async () => {
    // THE regression gate. `(vendorId, null)` is not unique, so
    // `findOrCreatePurchase` cannot dedupe an order-less charge — it always
    // inserts. Without `resolveCharge`'s `current` short-circuit, every save of
    // an unchanged vendor (an inline edit that re-submits the same value, a
    // re-import of the same row) created a fresh charge, re-pointed the expense
    // at it, and orphaned the previous one — `statedTotal` and attached
    // documents included.
    const { output: counterSale } = await createExpense(
      ctx.db,
      line("counter sale", "Tool Nirvana"),
      ctx.actor,
    );
    const vendorId = vendorIdOf(counterSale);
    const chargeBefore = purchaseIdOf(counterSale);
    expect(await chargeCount(vendorId)).toBe(1);

    const { output: rewritten } = await updateExpense(
      ctx.db,
      counterSale.id,
      { vendor: "Tool Nirvana" },
      ctx.actor,
    );

    expect(rewritten.purchaseId).toBe(chargeBefore);
    expect(await chargeCount(vendorId)).toBe(1);

    // Idempotent again when the unchanged order id is restated alongside it —
    // the `current.orderId === requestedOrderId` arm of the same guard.
    const { output: withOrder } = await createExpense(
      ctx.db,
      line("online order", "Tool Nirvana", "#11325"),
      ctx.actor,
    );
    const { output: restated } = await updateExpense(
      ctx.db,
      withOrder.id,
      { vendor: "Tool Nirvana", orderId: "#11325" },
      ctx.actor,
    );
    expect(restated.purchaseId).toBe(purchaseIdOf(withOrder));
    expect(await chargeCount(vendorId)).toBe(2); // the walk-in + this order
  });

  it("vendor: null detaches the line but leaves the charge and its other lines intact", async () => {
    const orderId = "111-detach-0000001";
    const { output: keep } = await createExpense(
      ctx.db,
      line("stays on the order", "Amazon", orderId),
      ctx.actor,
    );
    const { output: leaving } = await createExpense(
      ctx.db,
      line("mis-filed line", "Amazon", orderId),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(keep);
    expect(purchaseIdOf(leaving)).toBe(chargeId);

    const { output: detached } = await updateExpense(
      ctx.db,
      leaving.id,
      { vendor: null },
      ctx.actor,
    );
    expect(detached.purchaseId).toBeNull();
    expect(detached.vendorId).toBeNull();
    expect(detached.vendor).toBeNull();
    expect(detached.orderId).toBeNull();

    // Detaching one line is never a reason to delete the charge: the charge is
    // where `statedTotal` and the invoice PDF live, and its OTHER lines are real
    // spend. `null` means "this row isn't part of that transaction", not
    // "that transaction didn't happen".
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);
    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.orderId).toBe(orderId);
    expect(
      (await getPurchaseExpenses(ctx.db, chargeUuid)).map((p) => p.id),
    ).toEqual([keep.id]);
  });

  it("changing the vendor moves the line to the other vendor's charge, carrying its order id", async () => {
    const orderId = "WN-moved-0001";
    const { output: misattributed } = await createExpense(
      ctx.db,
      line("bought at the wrong store", "Lowe's", orderId),
      ctx.actor,
    );
    const wrongCharge = purchaseIdOf(misattributed);

    const { output: corrected } = await updateExpense(
      ctx.db,
      misattributed.id,
      { vendor: "Home Depot" },
      ctx.actor,
    );

    expect(corrected.purchaseId).not.toBe(wrongCharge);
    expect(corrected.vendor).toBe("Home Depot");
    // An omitted `orderId` means "leave it alone" — the receipt number is still
    // the receipt number, so it rides along to the new vendor's charge
    // (`current?.orderId ?? null`).
    expect(corrected.orderId).toBe(orderId);

    // The vacated charge is FOLDED into the new one, not left line-less: `resolveCharge` folds when the old charge loses its last line, so its statedTotal/notes/date and documents carry over rather than stranding. Same rule as detaching above.
    expect(
      await getPurchaseExpenses(
        ctx.db,
        await purchaseUuid(ctx.db, wrongCharge),
      ),
    ).toEqual([]);
  });

  it("adding an order id moves an order-less line onto the (vendor, orderId) charge, joining a sibling already there", async () => {
    const orderId = "111-adopt-0000001";
    const { output: alreadyFiled } = await createExpense(
      ctx.db,
      line("first line of the order", "Amazon", orderId),
      ctx.actor,
    );
    const { output: loose } = await createExpense(
      ctx.db,
      line("second line, order id not known yet", "Amazon"),
      ctx.actor,
    );
    // Two separate charges to start with — an order-less buy can't dedupe.
    expect(purchaseIdOf(loose)).not.toBe(purchaseIdOf(alreadyFiled));

    const { output: adopted } = await updateExpense(
      ctx.db,
      loose.id,
      { vendor: "Amazon", orderId },
      ctx.actor,
    );

    // Reconciling an order id is what MERGES the two lines: `(vendorId, orderId)`
    // is partial-unique, so the resolve finds the existing charge rather than
    // creating a second one for the same order.
    expect(adopted.purchaseId).toBe(purchaseIdOf(alreadyFiled));
    expect(adopted.orderId).toBe(orderId);
    expect(
      (
        await getPurchaseExpenses(
          ctx.db,
          await purchaseUuid(ctx.db, purchaseIdOf(alreadyFiled)),
        )
      )
        .map((p) => p.id)
        .sort(),
    ).toEqual([alreadyFiled.id, loose.id].sort());
  });

  // REGRESSION GUARD. This was a live bug: `resolveCharge` read only
  // `data.vendor` and returned "no change" whenever it was omitted, ignoring
  // `current.vendorName` sitting in the same argument — so an `{ orderId }`-only
  // update was silently dropped.
  //
  // It is not a hypothetical input shape, it is the ONLY shape the UI sends: both
  // Order # inline editors save `data: { orderId }` and nothing else
  // (app/expenses/expenselist.tsx and app/projects/shared.tsx), so typing an
  // order number into the ledger's Order # cell did nothing on every
  // vendor-bearing row — breaking the central purchase-import workflow.
  //
  // The test below this one pins the constraint the fix must not break: a
  // genuinely vendorless row still drops the order id.
  it("adopts an order id written on its own, using the vendor the row already has", async () => {
    const orderId = "111-alone-0000001";
    const { output: alreadyFiled } = await createExpense(
      ctx.db,
      line("first line of the order", "Amazon", orderId),
      ctx.actor,
    );
    const { output: loose } = await createExpense(
      ctx.db,
      line("order id typed in later", "Amazon"),
      ctx.actor,
    );

    const { output: adopted } = await updateExpense(
      ctx.db,
      loose.id,
      { orderId },
      ctx.actor,
    );

    expect(adopted.orderId).toBe(orderId);
    expect(adopted.purchaseId).toBe(purchaseIdOf(alreadyFiled));
  });

  it("an explicit purchaseId short-circuits name resolution and wins over a conflicting vendor", async () => {
    // `expenseCreateInput.purchaseId`'s doc: an id is never a guess, so there is
    // nothing to resolve. This is the purchase detail page's "add a line to this
    // charge" path — it must not be second-guessed by a stale vendor value the
    // form happened to carry along.
    const { output: anchor } = await createExpense(
      ctx.db,
      line("known charge anchor", "eBay", "eb-shortcircuit-1"),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(anchor);
    const { output: stray } = await createExpense(
      ctx.db,
      line("stray line", null),
      ctx.actor,
    );

    const { output: attached } = await updateExpense(
      ctx.db,
      stray.id,
      { purchaseId: chargeId, vendor: "Conflicting Vendor" },
      ctx.actor,
    );

    expect(attached.purchaseId).toBe(chargeId);
    expect(attached.vendor).toBe("eBay");
    expect(attached.orderId).toBe("eb-shortcircuit-1");
    // The short-circuit is before `findOrCreateVendor`, so the conflicting name
    // never reaches the roster — a resolve-anyway implementation would leave a
    // junk vendor row behind even though the id won.
    expect((await vendorOptions(ctx.db)).map((v) => v.name)).not.toContain(
      "Conflicting Vendor",
    );
  });

  it("drops an order id written with no vendor rather than half-recording it", async () => {
    // An order id alone can't name a transaction — they're only unique per
    // vendor — so there is no charge it could safely create. Dropped, not
    // stored on an unidentifiable charge.
    const { output: cash } = await createExpense(
      ctx.db,
      line("cash, no receipt", null),
      ctx.actor,
    );
    expect(cash.purchaseId).toBeNull();
    const chargesBefore = (await purchaseList(ctx.db, {}, [], page)).count;

    const { output: updated } = await updateExpense(
      ctx.db,
      cash.id,
      { orderId: "WN-no-vendor" },
      ctx.actor,
    );

    expect(updated.purchaseId).toBeNull();
    expect(updated.orderId).toBeNull();
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(
      chargesBefore,
    );
  });

  // The OTHER half of door 2. The sibling test above ("adopts an order id
  // written on its own") drives `renameChargeOrderId` into its collision arm and
  // falls through to the existing charge; this one drives the arm that actually
  // renames, which is the COMMON path — correcting a typo'd order number on a
  // charge whose only line is the row being edited.
  it("corrects a typo'd order id IN PLACE on a single-line charge, keeping its statedTotal", async () => {
    const { output: typo } = await createExpense(
      ctx.db,
      line("receipt with a typo", "Home Depot", "WN6344646"),
      ctx.actor,
    );
    const chargeId = purchaseIdOf(typo);
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);
    const vendorId = vendorIdOf(typo);
    // The two things a re-minted charge would strand. `statedTotal` is the
    // reconciliation cue the whole Purchase table exists to hold.
    await updatePurchase(
      ctx.db,
      { id: chargeId, data: { statedTotal: 10, notes: "invoice on file" } },
      ctx.actor,
    );

    const { output: fixed } = await updateExpense(
      ctx.db,
      typo.id,
      { orderId: "WN63446464" },
      ctx.actor,
    );

    // SAME charge, renamed — not a fresh one with the old left behind.
    expect(fixed.purchaseId).toBe(chargeId);
    expect(fixed.orderId).toBe("WN63446464");
    expect(await chargeCount(vendorId)).toBe(1);
    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.statedTotal).toBe(10);
    expect(charge.notes).toBe("invoice on file");

    // Audited on the CHARGE: the rename returns `undefined` to `resolveCharge`,
    // so `expenseCrud.update` sees no column change and emits nothing — without
    // `renameChargeOrderId`'s own entry the edit would leave no trace anywhere.
    // `getAuditLog`'s `entityId` matches the internal uuid (what `logAuditEntry`
    // writes), not the shortcode.
    const chargeAudit = await getAuditLog(ctx.db, {
      entityType: "purchase",
      entityId: chargeUuid,
      limit: 20,
    });
    expect(
      chargeAudit.entries.some(
        (e) =>
          e.action === "update" &&
          (e.changes as { orderId?: { from: unknown; to: unknown } } | null)
            ?.orderId?.to === "WN63446464",
      ),
    ).toBe(true);

    // Clearing it is the same in-place rename with no collision check to make —
    // `(vendorId, null)` isn't in the partial-unique index at all.
    const { output: cleared } = await updateExpense(
      ctx.db,
      typo.id,
      { orderId: null },
      ctx.actor,
    );
    expect(cleared.purchaseId).toBe(chargeId);
    expect(cleared.orderId).toBeNull();
    expect(await chargeCount(vendorId)).toBe(1);
  });

  /**
   * ATOMICITY GATE — fails on the pre-`withTransactionOn` code.
   *
   * `resolveCharge` used to run in its OWN transaction and commit, and only then
   * did the factory's column write run in a second one. So when the write failed
   * — `updateLiveAndReturn` throws when there is no live row, which is exactly
   * what a concurrent soft-delete produces — the vendor and charge it had just
   * minted survived with nothing pointing at them, and nothing sweeps up empty
   * charges. Same invariant `createExpense` already documents ("a vendor or
   * charge created here must not outlive a failed expense write"), which the
   * update path silently didn't hold.
   *
   * The delete-then-update ordering here is the deterministic form of the race:
   * the window it models is "soft-deleted after `resolveCharge` read the row",
   * and the observable outcome is identical.
   */
  it("rolls back a resolved vendor AND charge when the row was concurrently soft-deleted", async () => {
    const { output: doomed, entityId: doomedId } = await createExpense(
      ctx.db,
      line("about to be deleted", null),
      ctx.actor,
    );
    const chargesBefore = (await purchaseList(ctx.db, {}, [], page)).count;
    const vendorsBefore = (await vendorOptions(ctx.db)).length;

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    // A brand-new vendor AND a brand-new charge, so both sides of the resolve
    // have something to leak.
    await expect(
      updateExpense(
        ctx.db,
        doomed.id,
        { vendor: "Ghost Supply Co", orderId: "GSC-rollback-1" },
        ctx.actor,
      ),
    ).rejects.toThrow();

    expect((await vendorOptions(ctx.db)).map((v) => v.name)).not.toContain(
      "Ghost Supply Co",
    );
    expect((await vendorOptions(ctx.db)).length).toBe(vendorsBefore);
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(
      chargesBefore,
    );

    // And no audit entry for a write that never landed. `getAuditLog`'s
    // `entityId` matches the internal uuid, not the shortcode.
    const audit = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: doomedId,
      limit: 20,
    });
    expect(audit.entries.filter((e) => e.action === "update")).toEqual([]);
  });

  it("refuses an explicit purchaseId that points at a soft-deleted charge", async () => {
    // An FK proves the charge row exists, not that it isn't tombstoned, and an
    // explicit `purchaseId` skips `resolveCharge` entirely — so
    // `assertPurchaseLive` is the only thing between a direct API call and spend
    // filed against a dead charge.
    const { output: anchor } = await createExpense(
      ctx.db,
      line("line on a doomed charge", "eBay", "eb-tombstone-1"),
      ctx.actor,
    );
    const deadChargeId = purchaseIdOf(anchor);
    await deletePurchases(ctx.db, [deadChargeId], ctx.actor);

    await expect(
      createExpense(
        ctx.db,
        makeExpenseInput({
          name: "aimed at a dead charge",
          cost: 5,
          purchaseId: deadChargeId,
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });

    // Same guard on the update short-circuit: `rest.purchaseId` never passes
    // through `resolveCharge`, so it is checked separately or it goes in unchecked.
    const { output: stray } = await createExpense(
      ctx.db,
      line("stray", null),
      ctx.actor,
    );
    await expect(
      updateExpense(ctx.db, stray.id, { purchaseId: deadChargeId }, ctx.actor),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });
    expect(
      (await getExpenseByShortcode(ctx.db, stray.id))?.purchaseId,
    ).toBeNull();

    // A charge id that never existed is refused by the same assert.
    await expect(
      updateExpense(
        ctx.db,
        stray.id,
        {
          purchaseId: unsafePurchaseShortcode("PUR-ZZZZ"),
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });
  });
});

/**
 * `orderIdPresenceFilter` — presence resolved through the CHARGE, not a column
 * on the row. See `orderIdPresence` in repo/expense/lookup.ts.
 */
describe("expense repository — orderIdPresenceFilter", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  /** The three states the filter has to tell apart. */
  const seed = async () => {
    const { output: hasOrderId } = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "amazon order line",
        vendor: "Amazon",
        orderId: "111-presence-0000001",
      }),
      ctx.actor,
    );
    // A contractor's progress payment: a real charge, but the vendor never
    // issued an order number for it.
    const { output: chargeWithoutOrderId } = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "progress payment", vendor: "Flow Form" }),
      ctx.actor,
    );
    // No charge at all — cash at the yard, no vendor recorded.
    const { output: noCharge } = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "cash at the yard" }),
      ctx.actor,
    );

    expect(hasOrderId.orderId).toBe("111-presence-0000001");
    expect(purchaseIdOf(chargeWithoutOrderId)).toBeTruthy();
    expect(chargeWithoutOrderId.orderId).toBeNull();
    expect(noCharge.purchaseId).toBeNull();

    return { hasOrderId, chargeWithoutOrderId, noCharge };
  };

  it("'none' spans BOTH a charge-less row and a charge with a null order id", async () => {
    // The load-bearing case. `NOT IN (…)` evaluates to NULL — and so fails to
    // match — when the left side is NULL, so `notInArray(purchaseId, …)` ALONE
    // would silently drop every charge-less row from this bucket: 193 rows on the
    // real ledger, i.e. most of the unreconciled worklist. The `isNull` arm is
    // what puts them back, and both states must come back together because "no
    // order id" has always meant exactly that.
    const { hasOrderId, chargeWithoutOrderId, noCharge } = await seed();

    const { data } = await expenseList(
      ctx.db,
      { orderIdPresenceFilter: "none" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id).sort()).toEqual(
      [chargeWithoutOrderId.id, noCharge.id].sort(),
    );
    expect(data.map((p) => p.id)).not.toContain(hasOrderId.id);
  });

  it("'has' matches only rows whose charge carries an order id", async () => {
    const { hasOrderId } = await seed();

    const { data } = await expenseList(
      ctx.db,
      { orderIdPresenceFilter: "has" },
      [],
      pagination,
    );
    expect(data.map((p) => p.id)).toEqual([hasOrderId.id]);
  });

  it("contributes no constraint when unset", async () => {
    // `orderIdPresence` returns undefined for an absent filter rather than an
    // always-true clause, so an unfiltered ledger query still sees everything.
    const { hasOrderId, chargeWithoutOrderId, noCharge } = await seed();

    const { data } = await expenseList(ctx.db, {}, [], pagination);
    expect(data.map((p) => p.id).sort()).toEqual(
      [hasOrderId.id, chargeWithoutOrderId.id, noCharge.id].sort(),
    );
  });
});

/**
 * The reconciliation matcher. Read-only — every assertion here is about what
 * gets RANKED and how it's explained, never about anything being applied.
 */
describe("expense repository — matchExpenses", () => {
  const ctx = withTestDb();

  /** `matchExpenses` takes the post-parse shape, so defaults come from zod. */
  const run = (
    rows: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ) => matchExpenses(ctx.db, expenseMatchInput.parse({ rows, ...overrides }));

  const line = (
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<ExpenseOut> =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "tools",
          name,
          ...extra,
        }),
        ctx.actor,
      ),
    );

  it("matches on amount+date with ZERO token overlap — the trap the matcher exists for", async () => {
    // The real case: a Festool vacuum was booked as `dust extractor`, so every
    // keyword search missed it and a duplicate row was added. Amount+date finds
    // it; the name is only used to grade afterwards.
    const extractor = await line("dust extractor", {
      cost: 599,
      date: "2024-06-10",
    });

    const result = await run([
      {
        key: "export-1",
        date: "2024-06-10",
        amount: 599,
        label: "Festool Vacuum CT 36 AC",
      },
    ]);

    const candidates = result.matches[0]?.candidates ?? [];
    expect(candidates.map((c) => c.expenseId)).toContain(extractor.id);

    const hit = candidates.find((c) => c.expenseId === extractor.id);
    expect(hit).toMatchObject({
      matchedOn: "amount_date",
      dayDelta: 0,
      amountDelta: 0,
      ratioLabel: "exact",
      // Zero shared tokens on a TRUE positive. This is exactly why overlap
      // grades and must never filter.
      tokenOverlap: 0,
    });
    expect(result.summary).toEqual({
      rowsIn: 1,
      rowsWithCandidates: 1,
      exactOrderIdHits: 0,
    });
  });

  it("classifies a nominal one-cent float delta as exact", async () => {
    const fourCentLine = await line("four-cent line", {
      cost: 0.04,
      date: "2026-04-03",
    });

    const result = await run([
      { key: "one-cent-gap", date: "2026-04-03", amount: 0.03 },
    ]);
    const hit = result.matches[0]?.candidates.find(
      (candidate) => candidate.expenseId === fourCentLine.id,
    );

    // `0.04 - 0.03` is 0.010000000000000002 as a raw float. The documented
    // boundary is one cent, so classification must happen after cent rounding.
    expect(hit?.ratioLabel).toBe("exact");
  });

  it("computes the amount window on the SIGNED amount, so credits match credits", async () => {
    const refund = await line("festool accessory refund", {
      cost: -96.67,
      date: "2025-12-01",
    });
    const purchaseOfSameSize = await line("something bought for 96.67", {
      cost: 96.67,
      date: "2025-12-01",
    });

    const result = await run([
      { key: "credit", date: "2025-12-01", amount: -96.67 },
    ]);
    const ids = (result.matches[0]?.candidates ?? []).map((c) => c.expenseId);

    expect(ids).toContain(refund.id);
    // The window is roughly [-111, -87] — a POSITIVE row of the same magnitude
    // is nowhere near it. Getting the sign wrong here would silently break
    // every disposal reconciliation.
    expect(ids).not.toContain(purchaseOfSameSize.id);
  });

  it("excludes null-cost rows from the amount arm", async () => {
    const noCost = await line("no cost recorded", { date: "2026-03-01" });
    const real = await line("real row", { cost: 250, date: "2026-03-01" });
    expect(noCost.cost).toBeNull();

    const result = await run([{ key: "r", date: "2026-03-01", amount: 250 }]);
    const ids = (result.matches[0]?.candidates ?? []).map((c) => c.expenseId);

    expect(ids).toEqual([real.id]);
    expect(ids).not.toContain(noCost.id);
  });

  it("ranks an order-id hit above a closer amount match, and ignores the day window for it", async () => {
    // The order-id row is deliberately WORSE on both amount and date: far
    // outside the day window, and nowhere near the export amount. It must still
    // rank first, because an order id is an identifier and amount+date is a
    // guess.
    const byOrderId = await line("b&h order line", {
      cost: 203.36,
      date: "2025-01-05",
      vendor: "Matcher B&H",
      orderId: "1121197219",
    });
    const closerOnAmount = await line("coincidence", {
      cost: 306.27,
      date: "2025-06-01",
    });

    const result = await run([
      {
        key: "bh",
        date: "2025-06-01",
        amount: 306.27,
        orderId: "1121197219",
      },
    ]);

    const candidates = result.matches[0]?.candidates ?? [];
    expect(candidates[0]).toMatchObject({
      expenseId: byOrderId.id,
      matchedOn: "order_id",
      orderId: "1121197219",
      vendorName: "Matcher B&H",
      purchase: {
        orderId: "1121197219",
        vendorName: "Matcher B&H",
        expenseCount: 1,
        expenseTotal: 203.36,
        financialReconciliation: {
          status: "unknown",
          transactionCount: 0,
          postedTransactionCount: 0,
          outstandingTransactionCount: 0,
          postedTotal: 0,
          projectedTotal: 0,
          postedRefundTotal: 0,
          delta: null,
        },
      },
    });
    // 151 days apart and $103 off — well outside both windows, found anyway.
    expect(candidates[0]?.dayDelta).toBe(-147);
    expect(candidates.map((c) => c.expenseId)).toContain(closerOnAmount.id);
    expect(result.summary.exactOrderIdHits).toBe(1);
  });

  it("suppresses amount/date-only coincidences after a confirmed same-vendor order hit, while keeping all order siblings", async () => {
    const orderId = "MATCHER-CONFIRMED-SIBLINGS";
    const component = await line("order component", {
      cost: 60,
      date: "2025-01-05",
      vendor: "Matcher Confirmed Vendor",
      orderId,
    });
    const aggregate = await line("order aggregate", {
      cost: 100,
      date: "2025-01-05",
      vendor: "Matcher Confirmed Vendor",
      orderId,
    });
    const coincidence = await line("unrelated amount coincidence", {
      cost: 100,
      date: "2026-06-01",
    });

    const result = await run([
      {
        key: "confirmed",
        date: "2026-06-01",
        amount: 100,
        orderId,
        vendor: "Matcher Confirmed Vendor",
      },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];
    const ids = candidates.map((candidate) => candidate.expenseId);

    // Both lines on the exact order remain, even though neither needs to fit
    // the date/amount window. That covers aggregate-vs-components imports.
    expect(ids).toEqual(expect.arrayContaining([component.id, aggregate.id]));
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expenseId: component.id,
          matchedOn: "order_id",
          vendorMatch: true,
        }),
        expect.objectContaining({
          expenseId: aggregate.id,
          matchedOn: "order_id",
          vendorMatch: true,
        }),
      ]),
    );
    expect(ids).not.toContain(coincidence.id);
  });

  it("keeps amount/date candidates when an exact order hit conflicts with the input vendor", async () => {
    const orderId = "MATCHER-VENDOR-CONFLICT";
    const conflict = await line("other retailer's same order id", {
      cost: 500,
      date: "2024-01-01",
      vendor: "Matcher Other Retailer",
      orderId,
    });
    const amountCandidate = await line("plausible amount candidate", {
      cost: 75,
      date: "2026-06-01",
    });

    const result = await run([
      {
        key: "conflict",
        date: "2026-06-01",
        amount: 75,
        orderId,
        vendor: "Matcher Expected Retailer",
      },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expenseId: conflict.id,
          matchedOn: "order_id",
          vendorMatch: false,
        }),
        expect.objectContaining({
          expenseId: amountCandidate.id,
          matchedOn: "amount_date",
        }),
      ]),
    );
  });

  it("keeps amount/date candidates when vendor identity is unknown", async () => {
    const orderId = "MATCHER-VENDOR-UNKNOWN";
    const exact = await line("order with no input vendor", {
      cost: 500,
      date: "2024-01-01",
      vendor: "Matcher Known Vendor",
      orderId,
    });
    const amountCandidate = await line("plausible unknown-vendor candidate", {
      cost: 75,
      date: "2026-06-01",
    });

    const result = await run([
      { key: "unknown", date: "2026-06-01", amount: 75, orderId },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expenseId: exact.id,
          matchedOn: "order_id",
          vendorMatch: null,
        }),
        expect.objectContaining({
          expenseId: amountCandidate.id,
          matchedOn: "amount_date",
        }),
      ]),
    );
  });

  it("matches order ids exactly without stripping leading zeroes", async () => {
    const leadingZero = await line("leading-zero order", {
      cost: 50,
      date: "2024-01-01",
      vendor: "Matcher Zero Vendor",
      orderId: "000123",
    });
    const noLeadingZero = await line("different order without zeroes", {
      cost: 500,
      date: "2020-01-01",
      vendor: "Matcher Zero Vendor",
      orderId: "123",
    });

    const result = await run([
      {
        key: "zeroes",
        date: "2026-06-01",
        amount: 50,
        orderId: "000123",
        vendor: "Matcher Zero Vendor",
      },
    ]);
    const ids = (result.matches[0]?.candidates ?? []).map(
      (candidate) => candidate.expenseId,
    );

    expect(ids).toContain(leadingZero.id);
    expect(ids).not.toContain(noLeadingZero.id);
  });

  it("demotes a cross-vendor orderId collision below every amount+date hit", async () => {
    // An order id is unique only WITHIN a vendor — `Purchase_vendorId_orderId_key`
    // is UNIQUE(vendorId, orderId), and short ids genuinely collide across
    // retailers. Without vendor scoping the collision would take the top slot,
    // since the order-id arm ignores the day window and normally ranks first.
    const collidingId = "#11325";
    const wrongVendor = await line("metal supermarkets bar stock", {
      cost: 8000,
      date: "2020-01-01",
      vendor: "Matcher Metal Supermarkets",
      orderId: collidingId,
    });
    const rightVendor = await line("tool nirvana order line", {
      cost: 60,
      date: "2026-06-02",
      vendor: "Matcher Tool Nirvana",
      orderId: collidingId,
    });

    const result = await run([
      {
        key: "tn",
        date: "2026-06-01",
        amount: 60,
        orderId: collidingId,
        vendor: "Matcher Tool Nirvana",
      },
    ]);
    const candidates = result.matches[0]?.candidates ?? [];
    const rank = (id: string) =>
      candidates.findIndex((c) => c.expenseId === id);

    // The right vendor's row keeps the top slot and reads as a clean order-id hit.
    expect(candidates[0]).toMatchObject({
      expenseId: rightVendor.id,
      matchedOn: "order_id",
      vendorMatch: true,
    });

    // The collision is still RETURNED — spellings may merely differ, and silently
    // dropping it is how a true match gets lost — but flagged and ranked last.
    const collision = candidates.find((c) => c.expenseId === wrongVendor.id);
    expect(collision).toMatchObject({
      matchedOn: "order_id",
      vendorMatch: false,
    });
    expect(rank(wrongVendor.id)).toBeGreaterThan(rank(rightVendor.id));
  });

  it("treats a case/whitespace vendor difference as agreement, not a conflict", async () => {
    // Roster names are matched EXACTLY elsewhere, so an export spelled
    // "AMAZON " must not read as a different counterparty here — that would
    // demote a true order-id hit.
    const row = await line("amazon order line", {
      cost: 42,
      date: "2026-06-10",
      vendor: "Matcher Amazon",
      orderId: "111-CASE-TEST",
    });
    const coincidence = await line("unrelated matching amount", {
      cost: 42,
      date: "2026-06-10",
    });

    const result = await run([
      {
        key: "amz",
        date: "2026-06-10",
        amount: 42,
        orderId: "111-CASE-TEST",
        vendor: "  matcher AMAZON  ",
      },
    ]);

    const candidates = result.matches[0]?.candidates ?? [];
    expect(candidates[0]).toMatchObject({
      expenseId: row.id,
      matchedOn: "order_id",
      vendorMatch: true,
    });
    // Case/whitespace normalization confirms the vendor, so the unrelated
    // amount/date candidate is suppressed just like an exact spelling would be.
    expect(candidates.map((candidate) => candidate.expenseId)).not.toContain(
      coincidence.id,
    );
  });

  it("reports vendorMatch: null when there is nothing to compare", async () => {
    // Unknown, NOT clean: the export line carried no vendor. An order-id hit
    // keeps its top slot here, since nothing contradicts it.
    const row = await line("no vendor on the export line", {
      cost: 15,
      date: "2026-06-20",
      vendor: "Matcher Somewhere",
      orderId: "NV-1",
    });

    const result = await run([
      { key: "nv", date: "2026-06-20", amount: 15, orderId: "NV-1" },
    ]);

    expect(result.matches[0]?.candidates[0]).toMatchObject({
      expenseId: row.id,
      matchedOn: "order_id",
      vendorMatch: null,
    });
  });

  it("explains each hit instead of enumerating tax hypotheses", async () => {
    const exact = await line("exact", { cost: 100, date: "2026-05-01" });
    const plusTax = await line("plus tax", {
      cost: 108.63,
      date: "2026-05-01",
    });
    const preTax = await line("pre tax", { cost: 92.06, date: "2026-05-01" });
    const shipping = await line("plus shipping", {
      cost: 109.99,
      date: "2026-05-01",
    });

    const result = await run([{ key: "r", date: "2026-05-01", amount: 100 }]);
    const byId = new Map(
      (result.matches[0]?.candidates ?? []).map((c) => [c.expenseId, c]),
    );

    expect(byId.get(exact.id)?.ratioLabel).toBe("exact");
    expect(byId.get(plusTax.id)?.ratioLabel).toBe("plus_tax");
    expect(byId.get(preTax.id)?.ratioLabel).toBe("pre_tax");

    // The whole point of the design: an ADDITIVE $9.99 fee is not a tax
    // hypothesis and is not supposed to be labelled as one. It comes back as
    // `other` with the residual sitting right there as a plain number a human
    // recognizes as shipping — where a discrete `cost x 1.08625` check would
    // have rejected it outright.
    const fee = byId.get(shipping.id);
    expect(fee?.ratioLabel).toBe("other");
    expect(fee?.amountDelta).toBeCloseTo(9.99, 2);
  });

  it("caps candidates per row and orders by closeness", async () => {
    for (let i = 0; i < 6; i += 1) {
      await line(`bulk ${i}`, { cost: 200 + i * 0.5, date: "2026-07-01" });
    }

    const result = await run([{ key: "r", date: "2026-07-01", amount: 200 }], {
      maxCandidatesPerRow: 3,
    });
    const candidates = result.matches[0]?.candidates ?? [];

    expect(candidates).toHaveLength(3);
    const deltas = candidates.map((c) => Math.abs(c.amountDelta ?? 0));
    expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
  });

  it("excludes soft-deleted expenses, and reports unmatched keys", async () => {
    const deleted = await line("deleted row", {
      cost: 777,
      date: "2026-08-01",
    });
    await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

    const result = await run([
      { key: "gone", date: "2026-08-01", amount: 777 },
      { key: "never-existed", date: "2026-08-01", amount: 123456 },
    ]);

    expect(result.matches).toEqual([]);
    expect(result.unmatched.sort()).toEqual(["gone", "never-existed"]);
    expect(result.summary).toEqual({
      rowsIn: 2,
      rowsWithCandidates: 0,
      exactOrderIdHits: 0,
    });
  });

  /**
   * The sub-$20 hazard, pinned as behavior rather than wished away.
   *
   * A $0.93 order once false-matched a $1.00 `5 yd nursery mix` row and had to
   * be reverted. It is INSIDE any sane relative band (the two are 7.5% apart,
   * against a 10%/15% default), and the absolute floor widens the band further
   * so small amounts get a usable one at all. So the matcher returns it — that
   * is correct for a tool that ranks rather than decides.
   *
   * What protects against it is the grading signal plus the tool description's
   * instruction to read the line descriptions under ~$20, NOT a filter.
   */
  it("still surfaces the small-amount false positive, with zero overlap to grade it down", async () => {
    const nurseryMix = await line("5 yd nursery mix", {
      cost: 1.0,
      date: "2024-04-01",
    });

    const result = await run([
      {
        key: "screws",
        date: "2024-04-01",
        amount: 0.93,
        label: "wood screws",
      },
    ]);
    const hit = (result.matches[0]?.candidates ?? []).find(
      (c) => c.expenseId === nurseryMix.id,
    );

    expect(hit).toBeDefined();
    expect(hit?.tokenOverlap).toBe(0);
    expect(hit?.ratioLabel).toBe("other");
    expect(hit?.amountDelta).toBeCloseTo(0.07, 2);
  });

  it("scores token overlap when the names DO agree", async () => {
    const milwaukee = await line("milwaukee packout rolling toolbox", {
      cost: 149,
      date: "2026-09-01",
    });

    const result = await run([
      {
        key: "r",
        date: "2026-09-01",
        amount: 149,
        label: "Milwaukee PACKOUT Rolling Tool Box",
      },
    ]);
    const hit = (result.matches[0]?.candidates ?? []).find(
      (c) => c.expenseId === milwaukee.id,
    );

    // "milwaukee", "packout", "rolling" — "tool"/"box" vs "toolbox" is the
    // compound-word gap the description warns about, not something scored away.
    expect(hit?.tokenOverlap).toBe(3);
  });
});
