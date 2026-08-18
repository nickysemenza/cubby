import { describe, expect, it } from "vitest";
import {
  expenseAnalyzeInput,
  expenseCreateInput,
  expenseFiltersSchema,
  expenseSortableFields,
  projectCreateInput,
  projectOut,
  projectUpdateData,
} from "./project";

describe("expense analyzer input", () => {
  it("rejects the same dimension on both axes", () => {
    expect(
      expenseAnalyzeInput.safeParse({
        filters: {},
        rowDimension: "trade",
        columnDimension: "trade",
        comparison: "none",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit bounded range for previous-period comparison", () => {
    expect(
      expenseAnalyzeInput.safeParse({
        filters: { dateFrom: "2026-06-01" },
        rowDimension: "project",
        comparison: "previousPeriod",
      }).success,
    ).toBe(false);
    expect(
      expenseAnalyzeInput.safeParse({
        filters: { dateFrom: "2026-06-01", dateTo: "2026-06-15" },
        rowDimension: "project",
        comparison: "previousPeriod",
      }).success,
    ).toBe(true);
  });

  it("rejects previous-period comparison when Month is either axis", () => {
    const filters = { dateFrom: "2026-06-01", dateTo: "2026-06-15" };
    expect(
      expenseAnalyzeInput.safeParse({
        filters,
        rowDimension: "month",
        comparison: "previousPeriod",
      }).success,
    ).toBe(false);
    expect(
      expenseAnalyzeInput.safeParse({
        filters,
        rowDimension: "project",
        columnDimension: "month",
        comparison: "previousPeriod",
      }).success,
    ).toBe(false);
  });
});

describe("project resource URLs", () => {
  it("accepts and preserves complete Google Drive folder URLs", () => {
    const standard =
      "https://drive.google.com/drive/folders/abc123?usp=sharing#details";
    const accountPrefixed =
      "https://drive.google.com/drive/u/2/folders/def456?resourcekey=key";

    expect(
      projectCreateInput.parse({
        name: "Drive links",
        googleDriveFolderUrl: standard,
      }).googleDriveFolderUrl,
    ).toBe(standard);
    expect(
      projectUpdateData.parse({
        googleDriveFolderUrl: accountPrefixed,
      }).googleDriveFolderUrl,
    ).toBe(accountPrefixed);
  });

  it("accepts and preserves supported Notion page URLs", () => {
    const urls = [
      "https://notion.so/Project-0123456789abcdef",
      "https://www.notion.so/workspace/Project-0123456789abcdef?pvs=4",
      "https://cubby.notion.site/Project-0123456789abcdef#section",
      "https://docs.team.notion.site/Project-0123456789abcdef",
      "https://app.notion.com/p/nickysemenza/d4ffaba2e4b240ebb4aa8b7d80a7aabb",
      "https://app.notion.com/p/nickysemenza/Backyard-Project-Main-Page-d4ffaba2e4b240ebb4aa8b7d80a7aabb?source=copy_link",
    ];

    for (const notionPageUrl of urls) {
      expect(projectUpdateData.parse({ notionPageUrl }).notionPageUrl).toBe(
        notionPageUrl,
      );
    }
  });

  it("rejects invalid, insecure, and mismatched-provider URLs", () => {
    const invalidDriveUrls = [
      "not a URL",
      "http://drive.google.com/drive/folders/abc123",
      "https://drive.google.com/drive/my-drive",
      "https://notion.so/Project-0123456789abcdef",
    ];
    const invalidNotionUrls = [
      "not a URL",
      "http://notion.so/Project-0123456789abcdef",
      "https://notion.so/",
      "https://notion.so.evil.example/Project-0123456789abcdef",
      "https://notion.com/Project-0123456789abcdef",
      "https://evil.notion.com/Project-0123456789abcdef",
      "https://drive.google.com/drive/folders/abc123",
    ];

    for (const googleDriveFolderUrl of invalidDriveUrls) {
      expect(
        projectUpdateData.safeParse({ googleDriveFolderUrl }).success,
      ).toBe(false);
    }
    for (const notionPageUrl of invalidNotionUrls) {
      expect(projectUpdateData.safeParse({ notionPageUrl }).success).toBe(
        false,
      );
    }
  });

  it("normalizes empty input to null and exposes both fields in ProjectOut", () => {
    expect(
      projectCreateInput.parse({
        name: "Clear links",
        googleDriveFolderUrl: "",
        notionPageUrl: "   ",
      }),
    ).toMatchObject({
      googleDriveFolderUrl: null,
      notionPageUrl: null,
    });
    expect(
      projectUpdateData.parse({
        googleDriveFolderUrl: " ",
        notionPageUrl: "",
      }),
    ).toEqual({
      googleDriveFolderUrl: null,
      notionPageUrl: null,
    });
    expect(projectOut.shape.googleDriveFolderUrl).toBeDefined();
    expect(projectOut.shape.notionPageUrl).toBeDefined();
  });
});

describe("expense quantity filters", () => {
  it("coerces positive whole-unit URL/MCP bounds and accepts presence", () => {
    expect(
      expenseFiltersSchema.parse({
        productQuantityPresenceFilter: "has",
        productQuantityMin: "2",
        productQuantityMax: "5",
      }),
    ).toMatchObject({
      productQuantityPresenceFilter: "has",
      productQuantityMin: 2,
      productQuantityMax: 5,
    });
  });

  it.each([1.5, "not-a-number"])(
    "rejects an invalid productQuantityMin of %s",
    (productQuantityMin) => {
      expect(
        expenseFiltersSchema.safeParse({ productQuantityMin }).success,
      ).toBe(false);
    },
  );

  // Signed, like `costMin`/`costMax` — `productQuantityMax: -1` is the
  // "everything written off" worklist, and clamping the bound at zero would
  // make discards unreachable through the filter.
  it.each([0, -1, -8])(
    "accepts a signed productQuantityMin of %s",
    (productQuantityMin) => {
      expect(
        expenseFiltersSchema.safeParse({ productQuantityMin }).success,
      ).toBe(true);
    },
  );

  it.each([
    ["a discard", -1],
    ["a normal buy", 3],
  ])("accepts %s quantity on an expense", (_label, productQuantity) => {
    expect(
      expenseCreateInput.safeParse({
        name: "line",
        date: "2026-06-03",
        costType: "materials",
        trade: "other",
        productId: "PRD-4K7M",
        productQuantity,
      }).success,
    ).toBe(true);
  });

  // Zero used to be refused right here. It now means "money moved, no unit did"
  // — a price concession with the item kept — which is only coherent against a
  // NEGATIVE cost, and this schema cannot see `cost`. Enforcing it here would
  // reject the legal case along with the illegal ones, so the cross-field rule
  // moved to `assertQuantitySignMatchesCost` on the write path and is pinned in
  // `expense.integration.test.ts`, where a cost is actually in scope.
  it("accepts a zero product quantity — the cost decides, and it is not visible here", () => {
    expect(
      expenseCreateInput.safeParse({
        name: "line",
        date: "2026-06-03",
        costType: "materials",
        trade: "other",
        productId: "PRD-4K7M",
        productQuantity: 0,
      }).success,
    ).toBe(true);
  });

  it("allows direct sorting on the physical quantity column", () => {
    expect(expenseSortableFields).toContain("productQuantity");
  });
});
