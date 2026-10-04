import { parseShortcodeFor, type PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense, expenseAttribution } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { splitExpense } from "~/server/repo/purchase";

import { notDeleted } from "./database-helpers";
import {
  checkLinkExpensesFor,
  explicitlyAttachedProductIds,
  listLinkExpenseCandidates,
  loadSplitOriginal,
} from "./purchase-finance-actions";
import { attachPurchaseProducts } from "./purchase-products";
import { checkSplitDraft } from "./purchase-split-draft";
import { insertWithShortcode } from "./shortcode-utils";

const line = {
  date: "2026-09-01",
  lineKind: "principal",
  economicRole: "vendor",
  costType: "materials",
  trade: "other",
} as const;

describe("split and attach checks against the ledger", () => {
  const ctx = withTestDb();

  async function world() {
    const [vendor, otherVendor] = await Promise.all([
      insertWithShortcode(ctx.db, "vendor", { name: "Synthetic Supply" }),
      insertWithShortcode(ctx.db, "vendor", { name: "Synthetic Other Shop" }),
    ]);
    const [target, sameVendor, elsewhere] = await Promise.all([
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-01",
      }),
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-08-01",
      }),
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: otherVendor.id,
        date: "2026-08-02",
      }),
    ]);
    const make = (name: string, cost: number | null, purchaseId?: PurchaseId) =>
      insertWithShortcode(ctx.db, "expense", {
        ...line,
        name,
        cost,
        purchaseId: purchaseId ?? null,
      });
    const [here, free, sibling, foreign, unpriced] = await Promise.all([
      make("Board on this order", 5, target.id),
      make("Free board", 12.5),
      make("Board on another order of this vendor", 0.1, sameVendor.id),
      make("Board from a different vendor", 0.2, elsewhere.id),
      make("Unpriced board", null),
    ]);
    return { vendor, target, here, free, sibling, foreign, unpriced };
  }

  it("scopes attach candidates the way the dialog always has", async () => {
    const { target, here, free, sibling, foreign } = await world();
    const names = async (scope: "vendorOrUnattached" | "unattached" | "any") =>
      (
        await listLinkExpenseCandidates(ctx.db, {
          purchaseId: parseShortcodeFor("purchase", target.shortcode),
          scope,
        })
      ).candidates
        .map((candidate) => candidate.name)
        .sort();

    const vendorOrFree = await names("vendorOrUnattached");
    expect(vendorOrFree).toContain(free.name);
    expect(vendorOrFree).toContain(sibling.name);
    expect(vendorOrFree).not.toContain(foreign.name);
    expect(vendorOrFree).not.toContain(here.name);

    const unattached = await names("unattached");
    expect(unattached).toContain(free.name);
    expect(unattached).not.toContain(sibling.name);

    const any = await names("any");
    expect(any).toContain(foreign.name);
    expect(any).not.toContain(here.name);
  });

  it("words filed and unattached candidates and narrows by search", async () => {
    const { target, sibling } = await world();
    const result = await listLinkExpenseCandidates(ctx.db, {
      purchaseId: parseShortcodeFor("purchase", target.shortcode),
      scope: "any",
      search: "another order",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      id: sibling.shortcode,
      filed: true,
      current: "Synthetic Supply",
    });
  });

  it("totals an attach selection in whole cents and flags what would move", async () => {
    const { target, free, sibling, foreign, unpriced } = await world();
    const check = await checkLinkExpensesFor(ctx.db, {
      purchaseId: parseShortcodeFor("purchase", target.shortcode),
      expenseIds: [free, sibling, foreign, unpriced].map((row) =>
        parseShortcodeFor("expense", row.shortcode),
      ),
    });
    expect(check.reason).toBeNull();
    expect(check.selectedTotal).toBe(12.8);
    expect(check.resultingTotal).toBe(17.8);
    expect(check.movedCount).toBe(2);
    expect(check.note).toMatch(/1 without a cost/);
    expect(check.confirm).toMatch(/2 expenses/);
  });

  it("refuses an expense already on the purchase or no longer there", async () => {
    const { target, here } = await world();
    const already = await checkLinkExpensesFor(ctx.db, {
      purchaseId: parseShortcodeFor("purchase", target.shortcode),
      expenseIds: [parseShortcodeFor("expense", here.shortcode)],
    });
    expect(already.expenseIds).toBeNull();
    expect(already.reason).toMatch(/already on this purchase/);
  });

  it("hides only explicitly attached products, not ones derived from expenses", async () => {
    const { target } = await world();
    const [attached, derived] = await Promise.all([
      insertWithShortcode(ctx.db, "product", {
        name: "Attached sample",
        manufacturer: "Synthetic",
      }),
      insertWithShortcode(ctx.db, "product", {
        name: "Derived sample",
        manufacturer: "Synthetic",
      }),
    ]);
    await insertWithShortcode(ctx.db, "expense", {
      ...line,
      name: "Itemized line",
      cost: 3,
      purchaseId: target.id,
      productId: derived.id,
      productQuantity: 1,
    });
    await attachPurchaseProducts(ctx.db, target.id, [attached.id], ctx.actor);
    const hidden = await explicitlyAttachedProductIds(
      ctx.db,
      parseShortcodeFor("purchase", target.shortcode),
    );
    expect([...hidden]).toEqual([attached.shortcode]);
  });

  describe("a split the form accepts is a split the write accepts", () => {
    async function original(cost: number) {
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic split vendor",
      });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-01",
      });
      return insertWithShortcode(ctx.db, "expense", {
        ...line,
        name: "Sample kit",
        cost,
        purchaseId: purchase.id,
      });
    }
    const draft = (name: string, cost: string) => ({
      name,
      cost,
      costType: "materials" as const,
      trade: "other" as const,
      projectId: "",
      keepProduct: false,
      productQuantity: "",
    });

    it("conserves cents where floating point would not (0.1 + 0.2)", async () => {
      const source = await original(0.3);
      const check = checkSplitDraft(
        await loadSplitOriginal(
          ctx.db,
          parseShortcodeFor("expense", source.shortcode),
        ),
        {
          expenseId: parseShortcodeFor("expense", source.shortcode),
          parts: [draft("A", "0.1"), draft("B", "0.2")],
        },
      );
      expect(check.reason).toBeNull();
      if (!check.split) throw new Error("expected a split body");
      const result = await splitExpense(ctx.db, check.split, ctx.actor);
      expect(
        result.items.reduce(
          (sum, item) => sum + Math.round((item.cost ?? 0) * 100),
          0,
        ),
      ).toBe(30);
    });

    it("refuses a one-cent mismatch in the check and in the write alike", async () => {
      const source = await original(0.3);
      const code = parseShortcodeFor("expense", source.shortcode);
      const check = checkSplitDraft(await loadSplitOriginal(ctx.db, code), {
        expenseId: code,
        parts: [draft("A", "0.1"), draft("B", "0.21")],
      });
      expect(check.split).toBeNull();
      expect(check.delta).toBe(0.01);
      await expect(
        splitExpense(
          ctx.db,
          {
            expenseId: code,
            parts: [
              {
                ...draft("A", "0.1"),
                cost: 0.1,
                projectId: null,
                productId: null,
                productQuantity: null,
              },
              {
                ...draft("B", "0.21"),
                cost: 0.21,
                projectId: null,
                productId: null,
                productQuantity: null,
              },
            ],
          },
          ctx.actor,
        ),
      ).rejects.toThrow(/exactly/);
      const live = await unwrapDb(ctx.db)
        .select({ id: expense.id })
        .from(expense)
        .where(
          and(eq(expense.shortcode, source.shortcode), notDeleted(expense)),
        );
      expect(live).toHaveLength(1);
    });

    it("asks for an attribution choice instead of defaulting one", async () => {
      const source = await original(10);
      const code = parseShortcodeFor("expense", source.shortcode);
      const person = await createLedgerParty(
        ctx.db,
        { name: "Synthetic member", kind: "member", notes: null },
        ctx.actor,
      );
      if (!person.entityId) throw new Error("expected party");
      await unwrapDb(ctx.db).insert(expenseAttribution).values({
        expenseId: source.id,
        role: "funder",
        ledgerPartyId: person.entityId,
        weight: 1,
      });
      const loaded = await loadSplitOriginal(ctx.db, code);
      expect(loaded.hasAttribution).toBe(true);
      const parts = [draft("A", "4"), draft("B", "6")];
      const undecided = checkSplitDraft(loaded, { expenseId: code, parts });
      expect(undecided.needsAttributionPolicy).toBe(true);
      expect(undecided.split).toBeNull();
      const decided = checkSplitDraft(loaded, {
        expenseId: code,
        parts,
        attributionPolicy: "inherit",
      });
      if (!decided.split) throw new Error("expected a split body");
      const result = await splitExpense(ctx.db, decided.split, ctx.actor);
      expect(result.items).toHaveLength(2);
    });
  });
});
