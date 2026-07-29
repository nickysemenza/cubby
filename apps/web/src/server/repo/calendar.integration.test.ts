import { mealCreateInput } from "@cubby/schemas/meal";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getCalendarRange } from "./calendar";
import { createExpense } from "./expense";
import { createMeal } from "./meal";
import { createProject } from "./project";
import { createTask } from "./task";

describe("calendar repository", () => {
  const ctx = withTestDb();

  it("combines date-only entities, project spans, and day summaries", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Kitchen refresh",
        kind: "renovation",
        startDate: "2026-07-08",
        endDate: "2026-07-12",
      }),
      ctx.actor,
    );
    await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-07-10",
        name: "Tacos",
        sortOrder: 2,
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Paint cabinets",
        trade: "finishes",
        projectId: project.id,
        dueDate: "2026-07-10",
        dueEndDate: "2026-07-11",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Cabinet paint",
        trade: "finishes",
        costType: "materials",
        date: "2026-07-10",
        cost: 75,
        future: false,
        projectId: project.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "New handles",
        trade: "cabinetry",
        costType: "materials",
        date: "2026-07-10",
        cost: 120,
        future: true,
        projectId: project.id,
      }),
      ctx.actor,
    );
    await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-08-01",
        name: "Outside range",
      }),
      ctx.actor,
    );

    const result = await getCalendarRange(ctx.db, {
      startDate: "2026-07-05",
      endDateExclusive: "2026-07-19",
    });

    expect(result.items.map((item) => item.kind)).toEqual([
      "project",
      "task",
      "meal",
      "expense",
      "expense",
    ]);
    expect(result.items.find((item) => item.kind === "project")).toMatchObject({
      title: "Kitchen refresh",
      startDate: "2026-07-08",
      endDateExclusive: "2026-07-13",
      interaction: "read-only",
      projectKind: "renovation",
    });
    expect(
      result.items.find((item) => item.kind === "expense" && item.future),
    ).toMatchObject({ interaction: "move", cost: 120 });
    expect(result.days["2026-07-10"]).toMatchObject({
      actualSpend: 75,
      plannedSpend: 120,
      mealCount: 1,
      taskCount: 1,
      expenseCount: 2,
      projectCount: 1,
    });
    expect(result.items.some((item) => item.title === "Outside range")).toBe(
      false,
    );
  });
});
