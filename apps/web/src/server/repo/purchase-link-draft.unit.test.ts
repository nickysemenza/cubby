import {
  expenseShortcode,
  productShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import {
  checkLinkExpenses,
  composeLinkExpenseCandidates,
  composeLinkProductCandidates,
  expenseFiltersForScope,
  LINK_EXPENSE_SCOPES,
  type LinkExpenseRow,
} from "./purchase-link-draft";

const exp = (code: string) => expenseShortcode.parse(code);
const pur = (code: string) => purchaseShortcode.parse(code);
const prd = (code: string) => productShortcode.parse(code);
const ven = (code: string) => vendorShortcode.parse(code);

describe("expenseFiltersForScope", () => {
  it("offers this vendor's expenses or unattached ones by default", () => {
    expect(
      expenseFiltersForScope("vendorOrUnattached", ven("VEN-4K7M"), "  saw "),
    ).toEqual({
      vendorId: ven("VEN-4K7M"),
      vendorPresenceFilter: "none",
      search: "saw",
    });
  });

  it("narrows to unattached or widens to any expense", () => {
    expect(expenseFiltersForScope("unattached", ven("VEN-4K7M"), "")).toEqual({
      vendorPresenceFilter: "none",
      search: undefined,
    });
    expect(expenseFiltersForScope("any", ven("VEN-4K7M"), undefined)).toEqual({
      search: undefined,
    });
  });

  it("labels every scope", () => {
    expect(LINK_EXPENSE_SCOPES.map((scope) => scope.value)).toEqual([
      "vendorOrUnattached",
      "unattached",
      "any",
    ]);
  });
});

const row = (overrides: Partial<LinkExpenseRow> = {}): LinkExpenseRow => ({
  id: exp("EXP-AAAA"),
  name: "Sample board",
  date: "2026-01-05",
  cost: 12.5,
  trade: "other",
  projectId: null,
  projectName: null,
  purchaseId: null,
  vendor: null,
  ...overrides,
});

describe("composeLinkExpenseCandidates", () => {
  it("never offers an expense already on this purchase", () => {
    const { candidates } = composeLinkExpenseCandidates(pur("PUR-4K7M"), [
      row({ id: exp("EXP-AAAA"), purchaseId: pur("PUR-4K7M") }),
      row({ id: exp("EXP-BBBB") }),
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      exp("EXP-BBBB"),
    ]);
  });

  it("words where each is filed and flags the ones attaching would move", () => {
    const { candidates } = composeLinkExpenseCandidates(pur("PUR-4K7M"), [
      row({ id: exp("EXP-AAAA") }),
      row({
        id: exp("EXP-BBBB"),
        purchaseId: pur("PUR-ZZZZ"),
        vendor: "Sample Supply",
      }),
      row({ id: exp("EXP-CCCC"), purchaseId: pur("PUR-YYYY"), vendor: null }),
    ]);
    expect(candidates.map((c) => [c.current, c.filed])).toEqual([
      ["unattached", false],
      ["Sample Supply", true],
      ["another purchase", true],
    ]);
  });

  it("leaves an unknown cost unknown", () => {
    const { candidates } = composeLinkExpenseCandidates(pur("PUR-4K7M"), [
      row({ cost: null }),
    ]);
    expect(candidates[0]?.cost).toBeNull();
    expect(candidates[0]?.summary).not.toMatch(/\$0/);
  });

  it("explains an empty list", () => {
    const empty = composeLinkExpenseCandidates(pur("PUR-4K7M"), []);
    expect(empty.message).toMatch(/Nothing matches this scope/);
    expect(
      composeLinkExpenseCandidates(pur("PUR-4K7M"), [row()]).message,
    ).toBeNull();
  });
});

describe("checkLinkExpenses", () => {
  const purchase = { id: pur("PUR-4K7M"), expenseTotal: 100 };
  const lines = [
    { id: exp("EXP-AAAA"), cost: 12.5, purchaseId: null },
    { id: exp("EXP-BBBB"), cost: 0.1, purchaseId: pur("PUR-ZZZZ") },
    { id: exp("EXP-CCCC"), cost: 0.2, purchaseId: pur("PUR-ZZZZ") },
    { id: exp("EXP-DDDD"), cost: null, purchaseId: null },
  ];

  it("refuses an empty selection without a total", () => {
    const result = checkLinkExpenses(purchase, lines, []);
    expect(result.expenseIds).toBeNull();
    expect(result.reason).toMatch(/Select at least one/);
    expect(result.resultingTotal).toBeNull();
  });

  it("adds in whole cents, never floating point", () => {
    const result = checkLinkExpenses(purchase, lines, [
      exp("EXP-BBBB"),
      exp("EXP-CCCC"),
    ]);
    expect(result.selectedTotal).toBe(0.3);
    expect(result.resultingTotal).toBe(100.3);
  });

  it("counts the expenses that would move and asks for confirmation", () => {
    const moving = checkLinkExpenses(purchase, lines, [
      exp("EXP-AAAA"),
      exp("EXP-BBBB"),
    ]);
    expect(moving.movedCount).toBe(1);
    expect(moving.confirm).toMatch(/1 expense/);
    expect(moving.confirm).toMatch(/off its current purchase/);
    const free = checkLinkExpenses(purchase, lines, [exp("EXP-AAAA")]);
    expect(free.movedCount).toBe(0);
    expect(free.confirm).toBeNull();
  });

  it("says when a selected expense has no cost instead of counting it as $0", () => {
    const result = checkLinkExpenses(purchase, lines, [
      exp("EXP-AAAA"),
      exp("EXP-DDDD"),
    ]);
    expect(result.selectedTotal).toBe(12.5);
    expect(result.note).toMatch(/1 without a cost/);
  });

  it("refuses an expense that is gone or already here", () => {
    expect(
      checkLinkExpenses(purchase, lines, [exp("EXP-ZZZZ")]).reason,
    ).toMatch(/no longer exists/);
    const here = checkLinkExpenses(
      purchase,
      [{ id: exp("EXP-AAAA"), cost: 1, purchaseId: pur("PUR-4K7M") }],
      [exp("EXP-AAAA")],
    );
    expect(here.expenseIds).toBeNull();
    expect(here.reason).toMatch(/already on this purchase/);
  });

  it("returns the ids once, in selection order", () => {
    const result = checkLinkExpenses(purchase, lines, [
      exp("EXP-BBBB"),
      exp("EXP-AAAA"),
      exp("EXP-BBBB"),
    ]);
    expect(result.expenseIds).toEqual([exp("EXP-BBBB"), exp("EXP-AAAA")]);
    expect(result.selectedCount).toBe(2);
  });
});

describe("composeLinkProductCandidates", () => {
  const product = (id: string) => ({
    id: prd(id),
    name: id,
    manufacturer: "Sample",
    price: null,
    coverImageUrl: null,
  });

  it("hides only the products explicitly attached, not ones derived from expenses", () => {
    const result = composeLinkProductCandidates(
      [
        product(prd("PRD-AAAA")),
        product(prd("PRD-BBBB")),
        product(prd("PRD-CCCC")),
      ],
      new Set([prd("PRD-AAAA")]),
      50,
    );
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      prd("PRD-BBBB"),
      prd("PRD-CCCC"),
    ]);
  });

  it("caps the list after hiding what is attached", () => {
    const result = composeLinkProductCandidates(
      [
        product(prd("PRD-AAAA")),
        product(prd("PRD-BBBB")),
        product(prd("PRD-CCCC")),
      ],
      new Set([prd("PRD-AAAA")]),
      1,
    );
    expect(result.candidates).toHaveLength(1);
  });

  it("says the link carries no money or quantity", () => {
    const result = composeLinkProductCandidates([], new Set(), 50);
    expect(result.note).toMatch(/no money or quantity/);
    expect(result.message).toMatch(/already attached/);
  });
});
