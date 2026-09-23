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
  it("keeps maintenance work out of the listed-problems count", () => {
    const plan = buildAutoFixPlan(
      problems({
        entitiesMissingEmbeddings: fromPartial<
          AllProblems["entitiesMissingEmbeddings"]
        >([{ entityId: "sample" }]),
      }),
      maintenanceCountsSchema.parse({
        cullablePendingImages: 4,
        entitiesMissingEmbeddings: 12,
        staleRecipeTotals: 3,
        productsWithNoImages: 0,
        locationsWithoutAiDescription: 0,
      }),
    );

    expect(plan.items).toBe(19);
    expect(plan.listedItems).toBe(1);
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

    expect(plan).toMatchObject({ items: 0, listedItems: 0, tasks: [] });
  });
});
