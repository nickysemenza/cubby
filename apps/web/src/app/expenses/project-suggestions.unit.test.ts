import { describe, expect, it } from "vitest";

import {
  rankProjectSuggestions,
  type SuggestableProject,
  type TradeAffinityCell,
} from "./project-suggestions";

const TODAY = "2026-07-27";

/**
 * The real shape this exists to solve: a long parent renovation with many
 * trade-specific sub-projects all live at once, so date overlap alone leaves
 * ~9 candidates and only trade history separates them.
 */
const KITCHEN_SUBPROJECTS = [
  "cabinetry",
  "building",
  "electrical",
  "drywall",
  "plumbing",
  "demolition",
  "millwork",
  "finishes",
] as const;

const projects: SuggestableProject[] = [
  {
    id: "kitchen-remodel",
    name: "Kitchen Remodel",
    effectiveStart: "2024-01-01",
    effectiveEnd: "2025-06-30",
  },
  ...KITCHEN_SUBPROJECTS.map((trade) => ({
    id: `kitchen-${trade}`,
    name: `Kitchen: ${trade}`,
    effectiveStart: "2024-05-01",
    effectiveEnd: "2024-08-31",
  })),
  {
    id: "landscaping",
    name: "2025 backyard landscaping",
    effectiveStart: "2025-04-01",
    effectiveEnd: "2025-11-30",
  },
];

const affinity: TradeAffinityCell[] = KITCHEN_SUBPROJECTS.flatMap((trade) => [
  { projectId: `kitchen-${trade}`, trade, count: 40 },
  { projectId: "kitchen-remodel", trade, count: 5 },
]);

describe("rankProjectSuggestions", () => {
  it("picks the trade-matched sub-project out of many concurrent candidates", () => {
    const overlapping = projects.filter(
      (p) =>
        p.effectiveStart! <= "2024-06-15" &&
        (p.effectiveEnd ?? TODAY) >= "2024-06-15",
    );
    // Guard the premise: date overlap alone leaves a wide field.
    expect(overlapping.length).toBe(9);

    const suggestions = rankProjectSuggestions(
      { date: "2024-06-15", trade: "drywall" },
      projects,
      affinity,
      TODAY,
    );

    expect(suggestions[0]?.id).toBe("kitchen-drywall");
    expect(suggestions[0]?.affinity).toBe(40);
    expect(suggestions).toHaveLength(3);
  });

  it("excludes projects whose window does not contain the expense date", () => {
    const suggestions = rankProjectSuggestions(
      { date: "2024-06-15", trade: "landscaping" },
      projects,
      affinity,
      TODAY,
    );
    expect(suggestions.map((s) => s.id)).not.toContain("landscaping");
  });

  it("prefers the tighter window when trade history ties", () => {
    const suggestions = rankProjectSuggestions(
      { date: "2024-06-15", trade: "auto" },
      projects,
      affinity,
      TODAY,
    );
    expect(suggestions[0]?.affinity).toBe(0);
    expect(suggestions.map((s) => s.id)).not.toContain("kitchen-remodel");
  });

  it("treats an open-ended project as still running but ranks it last", () => {
    const openEnded: SuggestableProject[] = [
      {
        id: "ongoing",
        name: "Ongoing maintenance",
        effectiveStart: "2024-01-01",
        effectiveEnd: null,
      },
      {
        id: "bounded",
        name: "Bounded job",
        effectiveStart: "2024-06-01",
        effectiveEnd: "2024-07-01",
      },
    ];
    const suggestions = rankProjectSuggestions(
      { date: "2024-06-15", trade: "auto" },
      openEnded,
      [],
      TODAY,
    );
    expect(suggestions.map((s) => s.id)).toEqual(["bounded", "ongoing"]);
  });

  it("returns nothing for an expense with no date", () => {
    expect(
      rankProjectSuggestions(
        { date: null, trade: "drywall" },
        projects,
        affinity,
        TODAY,
      ),
    ).toEqual([]);
  });

  // No override AND no dated tasks/expenses/sub-projects — there is no
  // window for the expense to fall inside, so the project can't be suggested.
  it("ignores projects with no effective start", () => {
    const undated: SuggestableProject[] = [
      {
        id: "undated",
        name: "Undated",
        effectiveStart: null,
        effectiveEnd: null,
      },
    ];
    expect(
      rankProjectSuggestions(
        { date: "2024-06-15", trade: "drywall" },
        undated,
        [],
        TODAY,
      ),
    ).toEqual([]);
  });
});
