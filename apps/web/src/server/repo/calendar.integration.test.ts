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
    const { output: project } = await createProject(
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

  it("narrows to the requested kinds", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Deck rebuild",
        kind: "renovation",
        startDate: "2026-09-01",
        endDate: "2026-09-05",
      }),
      ctx.actor,
    );
    await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-09-02", name: "Chili" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Stain boards",
        trade: "finishes",
        projectId: project.id,
        dueDate: "2026-09-03",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Lumber",
        date: "2026-09-02",
        cost: 40,
        trade: "building",
        costType: "materials",
      }),
      ctx.actor,
    );

    const range = { startDate: "2026-09-01", endDateExclusive: "2026-09-10" };
    const all = await getCalendarRange(ctx.db, range);
    expect(new Set(all.items.map((item) => item.kind))).toEqual(
      new Set(["meal", "task", "expense", "project"]),
    );

    // What the ICS feed asks for: the expense and project reads are skipped
    // entirely, not filtered out afterwards.
    const feed = await getCalendarRange(ctx.db, {
      ...range,
      kinds: ["meal", "task"],
    });
    expect(new Set(feed.items.map((item) => item.kind))).toEqual(
      new Set(["meal", "task"]),
    );
    expect(feed.days["2026-09-02"]).toMatchObject({
      mealCount: 1,
      expenseCount: 0,
      projectCount: 0,
      actualSpend: 0,
    });
  });
  it("orders a day's meals by slot, not by title", async () => {
    // The exact case that was wrong before mealType existed: sorting fell
    // through to the title, so a breakfast named "Oatmeal" landed after a
    // dinner named "Chili".
    await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-10-05",
        name: "Chili",
        mealType: "dinner",
      }),
      ctx.actor,
    );
    await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-10-05",
        name: "Oatmeal",
        mealType: "breakfast",
      }),
      ctx.actor,
    );
    // Unslotted sorts last regardless of where its title falls alphabetically.
    await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-10-05", name: "Anytime" }),
      ctx.actor,
    );

    const { items } = await getCalendarRange(ctx.db, {
      startDate: "2026-10-05",
      endDateExclusive: "2026-10-06",
      kinds: ["meal"],
    });

    expect(items.map((item) => item.title)).toEqual([
      "Oatmeal",
      "Chili",
      "Anytime",
    ]);
  });

  it("titles an unnamed meal by its slot", async () => {
    await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-10-06", mealType: "breakfast" }),
      ctx.actor,
    );
    await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-10-07" }),
      ctx.actor,
    );

    const { items } = await getCalendarRange(ctx.db, {
      startDate: "2026-10-06",
      endDateExclusive: "2026-10-08",
      kinds: ["meal"],
    });

    // Unslotted keeps the old generic fallback — there is nothing better to say.
    expect(items.map((item) => item.title)).toEqual(["Breakfast", "Meal"]);
  });
});
