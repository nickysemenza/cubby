import {
  type AllProblems,
  EMPTY_PROBLEM_ARRAYS,
  maintenanceCountsSchema,
} from "@cubby/schemas/problems";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { buildAutoFixPlan } from "./auto-fix-registry";

const problems = (overrides: Partial<AllProblems> = {}): AllProblems => ({
  ...EMPTY_PROBLEM_ARRAYS,
  sectionTotals: {},
  totalProblems: 0,
  ...overrides,
  incompleteProjectIds: overrides.incompleteProjectIds ?? [],
});

describe("buildAutoFixPlan", () => {
  it("counts the true backlog behind a sampled section and keeps upkeep out of it", () => {
    const plan = buildAutoFixPlan(
      problems({
        locationsWithoutAiDescription: fromPartial<
          AllProblems["locationsWithoutAiDescription"]
        >([{ id: "sample" }]),
        sectionTotals: { locationsWithoutAiDescription: 6238 },
      }),
      maintenanceCountsSchema.parse({
        cullablePendingImages: 4,
        staleRecipeTotals: 3,
        productsWithNoImages: 0,
        locationsWithoutAiDescription: 0,
      }),
    );

    expect(plan.issues).toBe(6238);
    expect(plan.tasks.map((task) => task.key)).toEqual([
      "cullPendingImages",
      "locationDescriptions",
      "staleRecipeTotals",
    ]);
  });

  it("does not run always-run tail work without an actionable task", () => {
    const plan = buildAutoFixPlan(
      problems(),
      maintenanceCountsSchema.parse({
        cullablePendingImages: 0,
        staleRecipeTotals: 0,
        productsWithNoImages: 0,
        locationsWithoutAiDescription: 0,
      }),
    );

    expect(plan).toMatchObject({ issues: 0, tasks: [] });
  });
});
