import { describe, expect, it } from "vitest";
import {
  describeAttentionItem,
  expenseAnalyzeInput,
  expenseCreateInput,
  expenseFiltersSchema,
  expenseSortableFields,
  projectCreateInput,
  projectOut,
  type ProjectAttentionDescribable,
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
  it("coerces positive URL/MCP bounds and accepts presence", () => {
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

  // Fractional since 2026-08-22. A bound that could only be whole could not
  // bracket a fractional quantity at all — half a coil binned is -0.5 — so the
  // filter would silently exclude the rows it exists to find. The string case
  // is the URL/MCP path, which coerces.
  it.each([[1.5, 1.5] as const, ["0.5", 0.5] as const])(
    "accepts a fractional productQuantityMin of %s",
    (productQuantityMin, expected) => {
      expect(expenseFiltersSchema.parse({ productQuantityMin })).toMatchObject({
        productQuantityMin: expected,
      });
    },
  );

  it("rejects a productQuantityMin that is not a number at all", () => {
    expect(
      expenseFiltersSchema.safeParse({ productQuantityMin: "not-a-number" })
        .success,
    ).toBe(false);
  });

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

describe("describeAttentionItem", () => {
  /**
   * The sentence every prose consumer reads (MCP `get_house_status`,
   * `list_problems`). Two properties are load-bearing and asserted here:
   *
   * 1. Every rule NAMES its entity. The two `date_window_drift` sentences did
   *    not, so a drift row was unactionable without opening the project.
   * 2. The sentence stays unformatted — ISO dates, whole dollars. Its readers
   *    are agents, for whom `2022-06-05` is parseable and `Jun 5` is not, and
   *    this package deliberately carries no display-locale dependency.
   */
  const cases: Array<[string, ProjectAttentionDescribable, string]> = [
    [
      "overdue_task",
      {
        name: "Order countertop",
        type: "overdue_task",
        facts: { due: "2026-06-04", daysOverdue: 78 },
      },
      '"Order countertop" was due 2026-06-04 and is still open',
    ],
    [
      "stalled_project",
      {
        name: "Garage floor",
        type: "stalled_project",
        facts: {
          lastActivity: "2022-06-04",
          daysSinceActivity: 1174,
          thresholdDays: 30,
        },
      },
      '"Garage floor" has had no project, task, or expense activity in 30+ days',
    ],
    [
      "missing_budget",
      {
        name: "Backyard fence",
        type: "missing_budget",
        facts: { spend: 36291.4, actualSpend: 34120, committedSpend: 2171.4 },
      },
      '"Backyard fence" has $36291 in spend but no budget estimate',
    ],
    [
      "past_due_planned_expense",
      {
        name: "Quartz deposit",
        type: "past_due_planned_expense",
        facts: { plannedFor: "2026-06-04", daysPastDue: 78, cost: 2400 },
      },
      '"Quartz deposit" was planned for 2026-06-04 but hasn\'t been logged as spent',
    ],
    [
      "unclassified_expense",
      {
        name: "Hardware store run",
        type: "unclassified_expense",
        facts: { date: null },
      },
      '"Hardware store run" has no trade or cost recorded',
    ],
    [
      "blocked_work singular",
      {
        name: "Kitchen remodel",
        type: "blocked_work",
        facts: { blockedTasks: 1 },
      },
      '"Kitchen remodel" has 1 blocked task and no unblocked next action',
    ],
    [
      "blocked_work plural",
      {
        name: "Kitchen remodel",
        type: "blocked_work",
        facts: { blockedTasks: 3 },
      },
      '"Kitchen remodel" has 3 blocked tasks and no unblocked next action',
    ],
    [
      "date_window_drift start",
      {
        name: "Kitchen remodel",
        type: "date_window_drift",
        facts: {
          side: "start",
          override: "2022-06-05",
          derived: "2022-06-04",
          daysHidden: 1,
        },
      },
      '"Kitchen remodel" start date 2022-06-05 is after the earliest dated work (2022-06-04)',
    ],
    [
      "date_window_drift end",
      {
        name: "Kitchen remodel",
        type: "date_window_drift",
        facts: {
          side: "end",
          override: "2022-06-05",
          derived: "2022-06-20",
          daysHidden: 15,
        },
      },
      '"Kitchen remodel" end date 2022-06-05 is before the latest dated work (2022-06-20)',
    ],
  ];

  it.each(cases)("%s", (_label, item, expected) => {
    expect(describeAttentionItem(item)).toBe(expected);
  });

  it("names its entity in every rule's sentence", () => {
    for (const [label, item] of cases) {
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(describeAttentionItem(item), label).toContain(`"${item.name}"`);
    }
  });
});
