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
});

describe("buildAutoFixPlan", () => {
  it("counts the true backlog behind a sampled section and keeps upkeep out of it", () => {
    const plan = buildAutoFixPlan(
      problems({
        entitiesMissingEmbeddings: fromPartial<
          AllProblems["entitiesMissingEmbeddings"]
        >([{ entityId: "sample" }]),
        sectionTotals: { entitiesMissingEmbeddings: 6238 },
      }),
      maintenanceCountsSchema.parse({
        cullablePendingImages: 4,
        entitiesMissingEmbeddings: 6238,
        staleRecipeTotals: 3,
        productsWithNoImages: 0,
        locationsWithoutAiDescription: 0,
      }),
    );

    expect(plan.issues).toBe(6238);
    expect(plan.tasks.map((task) => task.key)).toEqual([
      "cullPendingImages",
      "missingEmbeddings",
      "staleRecipeTotals",
    ]);
  });

  it("does not run always-run tail work without an actionable task", () => {
    const plan = buildAutoFixPlan(
      problems(),
      maintenanceCountsSchema.parse({
        cullablePendingImages: 0,
        entitiesMissingEmbeddings: 0,
        staleRecipeTotals: 0,
        productsWithNoImages: 0,
        locationsWithoutAiDescription: 0,
      }),
    );

    expect(plan).toMatchObject({ issues: 0, tasks: [] });
  });
});
