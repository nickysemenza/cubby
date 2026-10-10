import {
  expenseShortcode,
  productShortcode,
  purchaseShortcode,
} from "@cubby/schemas/identifiers";
import type { SplitPartDraft } from "@cubby/schemas/purchase";
import { describe, expect, it } from "vitest";

import {
  checkSplitDraft,
  type SplitOriginal,
  startSplitDraft,
} from "./purchase-split-draft";

const original = (overrides: Partial<SplitOriginal> = {}): SplitOriginal => ({
  name: "Sample combo kit",
  cost: 30,
  costType: "materials",
  trade: "other",
  spendingCategoryId: null,
  projectId: null,
  productId: null,
  productName: null,
  productQuantity: null,
  purchaseId: purchaseShortcode.parse("PUR-4K7M"),
  unitemized: false,
  hasAttribution: false,
  imported: false,
  ...overrides,
});

const part = (overrides: Partial<SplitPartDraft> = {}): SplitPartDraft => ({
  name: "Part",
  cost: "10.00",
  costType: "materials",
  trade: "other",
  projectId: "",
  keepProduct: false,
  productQuantity: "",
  ...overrides,
});

const check = (
  parts: SplitPartDraft[],
  base: SplitOriginal = original(),
  attributionPolicy?: "inherit" | "clear",
) =>
  checkSplitDraft(base, {
    expenseId: expenseShortcode.parse("EXP-4K7M"),
    attributionPolicy,
    parts,
  });

describe("startSplitDraft", () => {
  it("puts the whole cost on the first part and leaves the second empty", () => {
    const start = startSplitDraft(original({ cost: 12.5 }));
    expect(start.parts).toHaveLength(2);
    expect(start.parts[0]).toMatchObject({
      name: "Sample combo kit",
      cost: "12.5",
    });
    expect(start.parts[1]).toMatchObject({ name: "", cost: "" });
    expect(start.originalCost).toBe(12.5);
  });

  it("leaves the cost blank when the original has none, never inventing $0", () => {
    expect(startSplitDraft(original({ cost: null })).parts[0]?.cost).toBe("");
  });

  it("offers the product note only when the original links a product", () => {
    expect(startSplitDraft(original()).productNote).toBeNull();
    const linked = startSplitDraft(
      original({
        productId: productShortcode.parse("PRD-4K7M"),
        productName: "Sample saw",
      }),
    );
    expect(linked.productName).toBe("Sample saw");
    expect(linked.productNote).toContain("Sample saw");
  });

  it("says in the confirmation that the expense is deleted", () => {
    expect(startSplitDraft(original()).confirm).toMatch(/deleted/);
  });
});

describe("checkSplitDraft", () => {
  it("accepts parts that conserve the original cost and returns the exact body", () => {
    const result = check([
      part({ name: " Saw ", cost: "10" }),
      part({ name: "Blade", cost: "20.00", trade: null }),
    ]);
    expect(result.reason).toBeNull();
    expect(result.delta).toBe(0);
    expect(result.split).toMatchObject({
      expenseId: expenseShortcode.parse("EXP-4K7M"),
      parts: [
        { name: "Saw", cost: 10, productId: null, projectId: null },
        { name: "Blade", cost: 20, trade: null },
      ],
    });
    expect(result.note).toBe("Parts add up to the original cost.");
  });

  it("conserves whole cents where floating point would not (0.1 + 0.2 = 0.3)", () => {
    const result = check(
      [part({ cost: "0.1" }), part({ cost: "0.2" })],
      original({ cost: 0.3 }),
    );
    expect(result.reason).toBeNull();
    expect(result.partsTotal).toBe(0.3);
    expect(result.delta).toBe(0);
  });

  it("refuses a one-cent mismatch and says which way", () => {
    const over = check([part({ cost: "10.01" }), part({ cost: "20" })]);
    expect(over.split).toBeNull();
    expect(over.delta).toBe(0.01);
    expect(over.reason).toMatch(/exactly/);
    expect(over.note).toMatch(/\$0\.01 over/);
    const under = check([part({ cost: "10" }), part({ cost: "19.99" })]);
    expect(under.delta).toBe(-0.01);
    expect(under.note).toMatch(/\$0\.01 under/);
  });

  it("reads a blank cost as zero, as the form always has", () => {
    const result = check([part({ cost: "30" }), part({ cost: "" })]);
    expect(result.reason).toBeNull();
    expect(result.split?.parts[1]?.cost).toBe(0);
  });

  it("does not reconcile against an original with no cost", () => {
    const result = check(
      [part({ cost: "5" }), part({ cost: "7" })],
      original({ cost: null }),
    );
    expect(result.reason).toBeNull();
    expect(result.delta).toBeNull();
    expect(result.note).toMatch(/no cost recorded/);
  });

  it("refuses a blank part cost when the original has none, never inventing $0", () => {
    const result = check(
      [part({ cost: "5" }), part({ cost: "" })],
      original({ cost: null }),
    );
    expect(result.split).toBeNull();
    expect(result.reason).toMatch(/Part 2: enter a cost/);
    expect(result.reason).toMatch(/no cost recorded/);
  });

  it("does not offer a product on an unitemized allocation", () => {
    const start = startSplitDraft(
      original({
        productId: productShortcode.parse("PRD-4K7M"),
        productName: "Sample saw",
        unitemized: true,
      }),
    );
    expect(start.productNote).toBeNull();
  });

  it("allows a negative part for a credit line", () => {
    const result = check([part({ cost: "35" }), part({ cost: "-5" })]);
    expect(result.reason).toBeNull();
  });

  it.each(["abc", "1.234", "1e3", "12abc", "--1"])(
    "refuses %s as a cost rather than guessing",
    (cost) => {
      const result = check([part({ cost }), part({ cost: "30" })]);
      expect(result.split).toBeNull();
      expect(result.reason).toMatch(/Part 1: cost/);
    },
  );

  it("needs a name on every part", () => {
    const result = check([part({ name: "  " }), part({ cost: "20" })]);
    expect(result.reason).toBe("Part 1 needs a name.");
  });

  it("needs at least two parts and at most the limit", () => {
    expect(check([part({ cost: "30" })]).reason).toMatch(/at least 2/);
    const many = Array.from({ length: 101 }, () => part({ cost: "0" }));
    expect(check(many).reason).toMatch(/at most 100/);
  });

  it("refuses an expense with no purchase, with the same words the verb uses", () => {
    const result = check(
      [part({ cost: "10" }), part({ cost: "20" })],
      original({ purchaseId: null }),
    );
    expect(result.reason).toMatch(/Record this expense's vendor first/);
  });

  it("refuses an imported expense", () => {
    const result = check(
      [part({ cost: "10" }), part({ cost: "20" })],
      original({ imported: true }),
    );
    expect(result.reason).toMatch(/Imported/);
  });

  describe("product link", () => {
    const linked = original({
      productId: productShortcode.parse("PRD-4K7M"),
      productName: "Sample saw",
    });

    it("hands the product to exactly one part", () => {
      const result = check(
        [
          part({ cost: "10", keepProduct: true, productQuantity: "2" }),
          part({ cost: "20" }),
        ],
        linked,
      );
      expect(result.reason).toBeNull();
      expect(result.split?.parts[0]).toMatchObject({
        productId: "PRD-4K7M",
        productQuantity: 2,
      });
      expect(result.split?.parts[1]).toMatchObject({
        productId: null,
        productQuantity: null,
      });
    });

    it("refuses two parts keeping the product", () => {
      const result = check(
        [
          part({ cost: "10", keepProduct: true }),
          part({ cost: "20", keepProduct: true }),
        ],
        linked,
      );
      expect(result.reason).toMatch(/Only one part/);
    });

    it("ignores keepProduct when the original has no product", () => {
      const result = check([
        part({ cost: "10", keepProduct: true }),
        part({ cost: "20" }),
      ]);
      expect(result.reason).toMatch(/no product/);
    });

    it("refuses a quantity that contradicts the part's cost sign", () => {
      const result = check(
        [
          part({ cost: "10", keepProduct: true, productQuantity: "-1" }),
          part({ cost: "20" }),
        ],
        linked,
      );
      expect(result.reason).toMatch(/Part 1:/);
      expect(result.reason).toMatch(/acquisition/);
    });

    it("refuses a non-numeric quantity", () => {
      const result = check(
        [
          part({ cost: "10", keepProduct: true, productQuantity: "two" }),
          part({ cost: "20" }),
        ],
        linked,
      );
      expect(result.reason).toMatch(/Part 1: quantity/);
    });

    it("refuses a product on an unitemized allocation", () => {
      const result = check(
        [part({ cost: "10", keepProduct: true }), part({ cost: "20" })],
        { ...linked, unitemized: true },
      );
      expect(result.reason).toMatch(/Unitemized/);
    });
  });

  describe("household attribution", () => {
    const attributed = original({ hasAttribution: true });

    it("asks for a policy rather than defaulting one", () => {
      const result = check(
        [part({ cost: "10" }), part({ cost: "20" })],
        attributed,
      );
      expect(result.needsAttributionPolicy).toBe(true);
      expect(result.split).toBeNull();
      expect(result.reason).toMatch(/inherit or clear/);
    });

    it("carries the chosen policy into the body", () => {
      const result = check(
        [part({ cost: "10" }), part({ cost: "20" })],
        attributed,
        "clear",
      );
      expect(result.needsAttributionPolicy).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.split?.attributionPolicy).toBe("clear");
    });

    it("never sends a policy for an unattributed expense", () => {
      const result = check(
        [part({ cost: "10" }), part({ cost: "20" })],
        original(),
        "inherit",
      );
      expect(result.needsAttributionPolicy).toBe(false);
      expect(result.split?.attributionPolicy).toBeUndefined();
    });
  });

  it("refuses an invalid project code", () => {
    const result = check([
      part({ cost: "10", projectId: "nope" }),
      part({ cost: "20" }),
    ]);
    expect(result.reason).toMatch(/Part 1: project/);
  });

  it("accepts a project code and trims whitespace around it", () => {
    const result = check([
      part({ cost: "10", projectId: " PRJ-4K7M " }),
      part({ cost: "20" }),
    ]);
    expect(result.split?.parts[0]?.projectId).toBe("PRJ-4K7M");
  });
});
