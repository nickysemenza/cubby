import type { AllProblems, MaintenanceCounts } from "@cubby/schemas/problems";
import { describe, expect, it } from "vitest";
import { AUTO_FIX_SECTION_IDS, buildAutoFixPlan } from "./auto-fix-registry";

const problems = (overrides: Partial<AllProblems> = {}): AllProblems =>
  ({
    orphanedEntityEmbeddings: [],
    locationsWithoutAiDescription: [],
    entitiesMissingEmbeddings: [],
    ...overrides,
  }) as AllProblems;

describe("buildAutoFixPlan", () => {
  it("keeps maintenance work out of the listed-problems count", () => {
    const plan = buildAutoFixPlan(
      problems({
        orphanedEntityEmbeddings: [{ id: "orphan" }] as never,
        entitiesMissingEmbeddings: [{ entityId: "sample" }] as never,
      }),
      {
        cullablePendingImages: 4,
        entitiesMissingEmbeddings: 12,
        staleRecipeTotals: 3,
      } as MaintenanceCounts,
    );

    expect(plan.items).toBe(20);
    expect(plan.listedItems).toBe(2);
    expect(plan.tasks.map((task) => task.key)).toEqual([
      "orphanedEmbeddings",
      "cullPendingImages",
      "missingEmbeddings",
      "staleRecipeTotals",
      "locationValuations",
    ]);
  });

  it("does not run always-run tail work without an actionable task", () => {
    const plan = buildAutoFixPlan(problems(), {
      cullablePendingImages: 0,
      entitiesMissingEmbeddings: 0,
      staleRecipeTotals: 0,
    } as MaintenanceCounts);

    expect(plan).toMatchObject({ items: 0, listedItems: 0, tasks: [] });
  });

  it("derives collapsed Problems sections from the task registry", () => {
    expect([...AUTO_FIX_SECTION_IDS].sort()).toEqual([
      "ai-descriptions",
      "missing-embeddings",
      "orphaned-embeddings",
    ]);
  });
});
