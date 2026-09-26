import type { AllProblems, ProblemItem } from "@cubby/schemas/problems";
import { EMPTY_PROBLEM_ARRAYS, PROBLEM_CLASS } from "@cubby/schemas/problems";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { PROBLEM_SECTIONS } from "./problem-sections";

/**
 * The section is a registry entry, so nothing type-level proves it was actually
 * registered, that it declares `coverage` (the marker that keeps it out of the
 * defect list and out of the red), or that `renderItem` survives a real row.
 * These assert exactly that — the checks a look at /problems would have made.
 */

const candidate = (
  overrides: Partial<ProblemItem<"duplicateSpendCandidates">> = {},
): ProblemItem<"duplicateSpendCandidates"> => ({
  id: testShortcode("expense", "EXP-VF9A"),
  expenseName: "washer stacking bracket",
  cost: 43.44,
  expenseDate: "2024-05-06",
  purchaseId: testShortcode("purchase", "PUR-YUKU"),
  vendorName: "Best Buy",
  purchaseDate: "2024-05-06",
  purchaseExpenseTotal: 43.44,
  purchaseStatedTotal: null,
  purchaseExpenseCount: 2,
  matchedOn: "expense_total",
  dayDelta: 0,
  nameSimilarity: 0.217,
  alternateMatchCount: 0,
  ...overrides,
});

const problems = (
  rows: ProblemItem<"duplicateSpendCandidates">[],
): AllProblems => ({
  ...EMPTY_PROBLEM_ARRAYS,
  duplicateSpendCandidates: rows,
  sectionTotals: {},
  totalProblems: rows.length,
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function entry() {
  const section = PROBLEM_SECTIONS.find(
    (candidate) => candidate.id === "duplicate-spend-candidates",
  );
  if (!section) throw new Error("Missing duplicate-spend problem section");
  return section;
}

describe("duplicate spend section", () => {
  it("is registered and reads its own problem key", () => {
    const section = entry();
    expect(section.count(problems([candidate(), candidate()]))).toBe(2);
    expect(section.count(problems([]))).toBe(0);
  });

  it("declares coverage, so it groups as advisory rather than as a defect", () => {
    expect(entry().coverage).toBeDefined();
    expect(PROBLEM_CLASS.duplicateSpendCandidates).not.toBe("defect");
  });

  it("renders a row naming the expense, the collision, and the day gap", () => {
    const node = entry().node(
      problems([
        candidate({
          matchedOn: "stated_total",
          purchaseStatedTotal: 50.71,
          purchaseExpenseTotal: 47.47,
          dayDelta: 2,
          alternateMatchCount: 1,
        }),
      ]),
      undefined,
    );
    const { container } = render(node, { wrapper: harness.wrapper });

    expect(screen.getByText("washer stacking bracket")).toBeTruthy();
    // The stated-total arm must show the stated total, not the line sum — the
    // gap between them is the whole reason that arm exists.
    expect(screen.getByText(/\$50\.71/)).toBeTruthy();
    expect(screen.getByText(/Best Buy stated total/)).toBeTruthy();
    expect(screen.getByText("2 days apart")).toBeTruthy();
    expect(screen.getByText("+1 weaker match")).toBeTruthy();

    // The actionable row is the expense; the purchase it collides with is only
    // context, so every route out of this card points at the expense.
    const hrefs = [...container.querySelectorAll("a")]
      .map((a) => a.getAttribute("href"))
      .filter((href): href is string => href !== null);
    expect(hrefs).toContain("/expenses/EXP-VF9A");
    expect(hrefs.some((href) => href.includes("PUR-YUKU"))).toBe(false);
  });

  it("renders the common row against the purchase's line sum, with no gap or alternate badges", () => {
    render(entry().node(problems([candidate()]), undefined), {
      wrapper: harness.wrapper,
    });

    expect(screen.getByText(/Best Buy expense total of \$43\.44/)).toBeTruthy();
    expect(screen.getByText(/across 2 lines/)).toBeTruthy();
    expect(screen.queryByText(/apart/)).toBeNull();
    expect(screen.queryByText(/weaker match/)).toBeNull();
  });

  it("handles the singular and deleted-vendor wording", () => {
    const node = entry().node(
      problems([
        candidate({
          vendorName: null,
          purchaseExpenseCount: 1,
          dayDelta: 1,
          alternateMatchCount: 2,
        }),
      ]),
      undefined,
    );
    render(node, { wrapper: harness.wrapper });

    expect(screen.getByText(/deleted vendor expense total/)).toBeTruthy();
    expect(screen.getByText(/across 1 line$/)).toBeTruthy();
    expect(screen.getByText("1 day apart")).toBeTruthy();
    expect(screen.getByText("+2 weaker matches")).toBeTruthy();
  });

  it("renders the empty state when nothing is flagged", () => {
    render(entry().node(problems([]), undefined), {
      wrapper: harness.wrapper,
    });
    expect(
      screen.getByText(
        "No unlinked expense looks like a purchase already recorded.",
      ),
    ).toBeTruthy();
  });
});
