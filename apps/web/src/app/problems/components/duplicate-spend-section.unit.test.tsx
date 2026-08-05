import {
  unsafeExpenseShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type {
  AllProblems,
  DuplicateSpendCandidate,
} from "@cubby/schemas/problems";
import { PROBLEM_CLASS } from "@cubby/schemas/problems";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PROBLEM_SECTIONS } from "./problem-sections";

// Router-free render, the same shape the expense-section tests use: resolve
// `to`/`params` into a plain href so the route a card points at is assertable.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    className,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    params?: Record<string, string>;
    className?: string;
  }) => {
    const href = params
      ? Object.entries(params).reduce(
          (path, [key, value]) => path.replace(`$${key}`, value),
          to,
        )
      : to;
    return (
      <a href={href} className={className} {...props}>
        {children}
      </a>
    );
  },
}));

/**
 * The section is a registry entry, so nothing type-level proves it was actually
 * registered, that it declares `coverage` (the marker that keeps it out of the
 * defect list and out of the red), or that `renderItem` survives a real row.
 * These assert exactly that — the checks a look at /problems would have made.
 */

const candidate = (
  overrides: Partial<DuplicateSpendCandidate> = {},
): DuplicateSpendCandidate => ({
  id: unsafeExpenseShortcode("EXP-VF9A"),
  expenseName: "washer stacking bracket",
  cost: 43.44,
  expenseDate: "2024-05-06",
  purchaseId: unsafePurchaseShortcode("PUR-YUKU"),
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

const problems = (rows: DuplicateSpendCandidate[]): AllProblems =>
  ({ duplicateSpendCandidates: rows }) as AllProblems;

const entry = () =>
  PROBLEM_SECTIONS.find((s) => s.id === "duplicate-spend-candidates");

describe("duplicate spend section", () => {
  it("is registered and reads its own problem key", () => {
    const section = entry();
    expect(section).toBeDefined();
    expect(section?.count(problems([candidate(), candidate()]))).toBe(2);
    expect(section?.count(problems([]))).toBe(0);
  });

  it("declares coverage, so it groups as advisory rather than as a defect", () => {
    // Forwarding `coverage` is what the page groups on. Omitting it renders a
    // correct-looking section that silently sits in the defect list.
    expect(entry()?.coverage).toBeDefined();
    expect(PROBLEM_CLASS.duplicateSpendCandidates).not.toBe("defect");
  });

  it("renders a row naming the expense, the collision, and the day gap", () => {
    const node = entry()?.node(
      problems([
        candidate({
          matchedOn: "stated_total",
          purchaseStatedTotal: 50.71,
          purchaseExpenseTotal: 47.47,
          dayDelta: 2,
          alternateMatchCount: 1,
        }),
      ]),
      undefined as never,
    );
    // biome-ignore lint/complexity/noUselessFragments: `node` is a ReactNode; the fragment is what makes it a ReactElement for render()
    const { container } = render(<>{node}</>);

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

  it("renders the empty state when nothing is flagged", () => {
    // biome-ignore lint/complexity/noUselessFragments: as above — ReactNode to ReactElement
    render(<>{entry()?.node(problems([]), undefined as never)}</>);
    expect(
      screen.getByText(/No unlinked expense duplicates a purchase's total/),
    ).toBeTruthy();
  });
});
