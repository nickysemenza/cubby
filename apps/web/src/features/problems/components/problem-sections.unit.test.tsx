import {
  type AllProblems,
  EMPTY_PROBLEM_ARRAYS,
  isAutoFixProblemKey,
  PROBLEM_CLASS,
  problemRowSchema,
  type ProblemKey,
  splitDefects,
  understatedCostMealSchema,
} from "@cubby/schemas/problems";
import { testShortcode } from "@cubby/schemas/testing";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { PROBLEM_SECTIONS } from "./problem-sections";

type Section = (typeof PROBLEM_SECTIONS)[number];

const ALL_PROBLEM_KEYS = Object.keys(PROBLEM_CLASS).filter(
  (key): key is ProblemKey => key in PROBLEM_CLASS,
);
const isStringProperty = (property: PropertyKey): property is string =>
  typeof property === "string";

/**
 * The detector keys a section actually renders, taken from the section itself
 * rather than from a second hand-written list: `rows` runs the section's own
 * `select` over a probe that records every key it touches. That is what makes
 * this file a check on `coverage.keys` and not just a restatement of it — a
 * section whose declared keys drift from its `select` fails here.
 */
function keysReadBy(section: Section): ProblemKey[] {
  const read = new Set<string>();
  const probe: AllProblems = {
    ...EMPTY_PROBLEM_ARRAYS,
    sectionTotals: {},
    totalProblems: 0,
  };
  const proxied = new Proxy(probe, {
    get: (_target, property) => {
      if (isStringProperty(property) && property !== "sectionTotals") {
        read.add(property);
      }
      return [];
    },
  });
  section.rows(proxied);
  return [...read].filter((key): key is ProblemKey => key in PROBLEM_CLASS);
}

const sorted = (keys: readonly string[]) => [...keys].sort();

describe("PROBLEM_SECTIONS", () => {
  it.each(PROBLEM_SECTIONS.map((s) => [s.id, s] as const))(
    "%s reads only known detector keys",
    (_id, section) => {
      const keys = keysReadBy(section);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => !ALL_PROBLEM_KEYS.includes(key))).toEqual([]);
    },
  );

  it.each(PROBLEM_SECTIONS.map((s) => [s.id, s] as const))(
    "%s renders keys of a single class",
    (_id, section) => {
      const classes = new Set(
        keysReadBy(section).map((key) => PROBLEM_CLASS[key]),
      );
      expect([...classes]).toHaveLength(1);
    },
  );

  it.each(PROBLEM_SECTIONS.map((s) => [s.id, s] as const))(
    "%s declares coverage exactly when its keys are classed coverage",
    (_id, section) => {
      const keys = keysReadBy(section);
      const isCoverageClassed = keys.every(
        (key) => PROBLEM_CLASS[key] === "coverage",
      );
      expect(section.coverage != null).toBe(isCoverageClassed);
      if (section.coverage) {
        // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
        expect(sorted(section.coverage.keys)).toEqual(sorted(keys));
      }
    },
  );

  it("sums section counts to the split headline when lanes return samples", () => {
    // Every lane returns a one-row sample of a much larger true population —
    // the shape that made the summary chips count samples while the headline
    // counted the backlog.
    const sections = Object.fromEntries(
      ALL_PROBLEM_KEYS.map((key) => [key, [{}]]),
    );
    const sectionTotals = Object.fromEntries(
      ALL_PROBLEM_KEYS.map((key, index) => [key, 100 + index]),
    );
    const problems: AllProblems = {
      ...EMPTY_PROBLEM_ARRAYS,
      ...sections,
      sectionTotals,
      totalProblems: 0,
    };
    const sum = (sections: readonly Section[]) =>
      sections.reduce((n, section) => n + section.count(problems), 0);
    const defects = PROBLEM_SECTIONS.filter((s) => s.coverage == null);
    const autoFix = defects.filter((s) =>
      s.problemKeys.every(isAutoFixProblemKey),
    );
    const needsYou = defects.filter((s) => !autoFix.includes(s));

    expect({ needsYou: sum(needsYou), autoFix: sum(autoFix) }).toEqual(
      splitDefects(sections, sectionTotals),
    );
  });

  it("renders every detector key in exactly one section", () => {
    const rendered = PROBLEM_SECTIONS.flatMap(keysReadBy);
    expect(sorted(rendered)).toEqual(sorted(ALL_PROBLEM_KEYS));
  });

  it.each(PROBLEM_SECTIONS.map((s) => [s.id, s] as const))(
    "%s shows the assembly for exactly the detector keys it renders",
    (_id, section) => {
      expect(sorted(section.problemKeys ?? [])).toEqual(
        sorted(keysReadBy(section)),
      );
    },
  );

  it("links every affected recipe directly to its live cost-gap popover", async () => {
    const harness = createBrowserTestHarness();
    await act(async () => {
      await harness.loadRouter();
    });
    const section = PROBLEM_SECTIONS.find(
      (candidate) => candidate.id === "understated-cost-meals",
    );
    if (!section) throw new Error("Missing understated-cost Problems section");
    const meal = understatedCostMealSchema.parse({
      id: testShortcode("meal", "understated"),
      name: "Weeknight dinner",
      date: "2026-09-01",
      recipeCount: 2,
      affectedRecipes: [
        {
          id: testShortcode("recipe", "broccoli"),
          name: "Broccoli",
          costCovered: 2,
          ingredientCount: 3,
        },
        {
          id: testShortcode("recipe", "carrots"),
          name: "Carrots",
          costCovered: 0,
          ingredientCount: 2,
        },
      ],
    });
    const problems: AllProblems = {
      ...EMPTY_PROBLEM_ARRAYS,
      understatedCostMeals: [meal],
      sectionTotals: {},
      totalProblems: 1,
    };

    render(section.node(problems, undefined), { wrapper: harness.wrapper });

    const link = screen.getByRole("link", {
      name: "Broccoli — 2 of 3 ingredients priced",
    });
    expect(link).toHaveAttribute(
      "href",
      `/recipes/${meal.affectedRecipes[0]!.id}?costingGap=true`,
    );
    // A recipe with nothing priced (unavailable cost, 0 of N) renders the same line.
    expect(
      screen.getByRole("link", { name: "Carrots — 0 of 2 ingredients priced" }),
    ).toHaveAttribute(
      "href",
      `/recipes/${meal.affectedRecipes[1]!.id}?costingGap=true`,
    );
    harness.dispose();
  });

  it("renders a uniform problem row as a titled entity link with its facts", async () => {
    const harness = createBrowserTestHarness();
    await act(async () => {
      await harness.loadRouter();
    });
    const section = PROBLEM_SECTIONS.find(
      (candidate) => candidate.id === "image-processing",
    );
    if (!section) throw new Error("Missing image-processing Problems section");
    const issue = problemRowSchema.parse({
      entity: "image",
      id: testShortcode("image", "needs-review"),
      name: "garden-photo.jpg",
      fields: [
        {
          label: "Issue",
          value: "Cutout eligibility needs review",
          tone: "warning",
        },
      ],
      badges: [],
    });
    const problems: AllProblems = {
      ...EMPTY_PROBLEM_ARRAYS,
      imageProcessingIssues: [issue],
      sectionTotals: {},
      totalProblems: 0,
    };

    render(section.node(problems, undefined), { wrapper: harness.wrapper });

    expect(
      screen.getByText("Cutout eligibility needs review"),
    ).toBeInTheDocument();
    // The title is the way in, so the row drops its icon-only Open button.
    expect(
      screen.getByRole("link", { name: "garden-photo.jpg" }),
    ).toHaveAttribute("href", `/images/${issue.id}`);
    expect(screen.queryByRole("button", { name: "Open image" })).toBeNull();
    // The card names its record by a copyable shortcode read off the route.
    expect(screen.getByRole("button", { name: issue.id })).toHaveAttribute(
      "title",
      "Copy shortcode",
    );
    harness.dispose();
  });

  it("links and names an Email-targeted import finding", async () => {
    const harness = createBrowserTestHarness();
    await act(async () => {
      await harness.loadRouter();
    });
    const section = PROBLEM_SECTIONS.find(
      (candidate) => candidate.id === "import-findings",
    );
    if (!section) throw new Error("Missing import-findings Problems section");
    const email = testShortcode("email", "unclassified-vendor");
    const problems: AllProblems = {
      ...EMPTY_PROBLEM_ARRAYS,
      runFindings: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          targetId: email,
          kind: "unclassified_vendor",
          summary: "Purchase mail from Example Shop does not match a vendor",
          probability: null,
          proposedFix: null,
          createdAt: new Date("2026-01-02T03:04:05Z"),
        },
      ],
      sectionTotals: {},
      totalProblems: 1,
    };

    render(section.node(problems, undefined), { wrapper: harness.wrapper });

    expect(
      screen.getByRole("link", {
        name: "Purchase mail from Example Shop does not match a vendor",
      }),
    ).toHaveAttribute("href", `/emails/${email}`);
    expect(screen.getByRole("button", { name: email })).toBeInTheDocument();
    harness.dispose();
  });
});
