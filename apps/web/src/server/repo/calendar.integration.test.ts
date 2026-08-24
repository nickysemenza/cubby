import type { CalendarItemKind } from "@cubby/schemas/calendar";
import { unsafeProjectShortcode } from "@cubby/schemas/identifiers";
import { mealCreateInput } from "@cubby/schemas/meal";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { productImage, recipeImage } from "~/server/db/schema";
import { getCalendarRange } from "./calendar";
import { insertAndReturn } from "./database-helpers";
import { createExpense } from "./expense";
import { createMeal } from "./meal";
import { createProject } from "./project";
import {
  createImageFixture,
  createProductFixture,
  createRecipeFixture,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { createTask } from "./task";

/** A well-formed project shortcode that resolves to no row. */
const MISSING_PROJECT = unsafeProjectShortcode("PRJ-ZZZZ");

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
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Cabinet paint tin" }),
      ctx.actor,
    );
    const productCover = await createImageFixture(ctx.db, "cabinet-paint");
    await insertAndReturn(ctx.db, productImage, {
      productId: product.entityId,
      imageId: productCover.id,
    });
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Weeknight tacos" }),
      ctx.actor,
    );
    const recipeCover = await createImageFixture(ctx.db, "weeknight-tacos");
    await insertAndReturn(ctx.db, recipeImage, {
      recipeId: recipe.entityId,
      imageId: recipeCover.id,
    });
    await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-07-10",
        name: "Tacos",
        sortOrder: 2,
        recipes: [{ recipeId: recipe.id }],
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Paint cabinets",
        trade: "finishes",
        projectId: project.id,
        subjectProductId: product.id,
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
        productId: product.id,
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
    expect(result.items.find((item) => item.kind === "meal")).toMatchObject({
      name: "Tacos",
      recipeNames: ["Weeknight tacos"],
      coverImageUrl: recipeCover.url,
    });
    expect(result.items.find((item) => item.kind === "task")).toMatchObject({
      dueDate: "2026-07-10",
      dueEndDate: "2026-07-11",
      subjectProductName: "Cabinet paint tin",
      coverImageUrl: productCover.url,
    });
    expect(
      result.items.find((item) => item.kind === "expense" && !item.future),
    ).toMatchObject({
      productName: "Cabinet paint tin",
      coverImageUrl: productCover.url,
    });
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
  describe("filters", () => {
    const range = { startDate: "2026-10-01", endDateExclusive: "2026-10-15" };

    const seed = async () => {
      const { output: parent } = await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "Bath remodel",
          kind: "renovation",
          status: "in_progress",
          startDate: "2026-10-03",
          endDate: "2026-10-09",
        }),
        ctx.actor,
      );
      const { output: child } = await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "Bath remodel: tiling",
          kind: "renovation",
          status: "done",
          parentProjectId: parent.id,
          startDate: "2026-10-06",
          endDate: "2026-10-08",
        }),
        ctx.actor,
      );
      await createMeal(
        ctx.db,
        mealCreateInput.parse({ date: "2026-10-05", name: "Soup" }),
        ctx.actor,
      );
      await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Seal grout",
          trade: "finishes",
          status: "blocked",
          projectId: parent.id,
          dueDate: "2026-10-05",
        }),
        ctx.actor,
      );
      await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Order tile",
          trade: "finishes",
          status: "not_started",
          projectId: child.id,
          dueDate: "2026-10-06",
        }),
        ctx.actor,
      );
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          name: "Grout",
          trade: "finishes",
          costType: "materials",
          date: "2026-10-05",
          cost: 30,
          future: false,
          projectId: parent.id,
        }),
        ctx.actor,
      );
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          name: "Unassigned sundries",
          trade: "finishes",
          costType: "materials",
          date: "2026-10-05",
          cost: 12,
          future: false,
        }),
        ctx.actor,
      );
      return { parent, child };
    };

    const countByKind = async (
      filters: Partial<Parameters<typeof getCalendarRange>[1]>,
    ) => {
      const result = await getCalendarRange(ctx.db, { ...range, ...filters });
      const counts: Record<CalendarItemKind, number> = {
        meal: 0,
        task: 0,
        expense: 0,
        project: 0,
      };
      for (const item of result.items) counts[item.kind] += 1;
      return counts;
    };

    it("scopes a kind-specific filter to that kind ALONE", async () => {
      await seed();
      const baseline = await countByKind({});
      expect(baseline).toEqual({ meal: 1, task: 2, expense: 2, project: 2 });

      // The whole point of naming these `taskStatus` rather than `status`: a
      // task filter must not empty the month of everything without a status.
      expect(await countByKind({ taskStatus: ["blocked"] })).toEqual({
        ...baseline,
        task: 1,
      });
      expect(await countByKind({ taskTrade: ["plumbing"] })).toEqual({
        ...baseline,
        task: 0,
      });
      expect(await countByKind({ expenseFuture: true })).toEqual({
        ...baseline,
        expense: 0,
      });
      expect(await countByKind({ projectStatus: ["done"] })).toEqual({
        ...baseline,
        project: 1,
      });
    });

    it("expands a project scope to its live subtree when asked", async () => {
      const { parent } = await seed();

      expect(await countByKind({ projectId: [parent.id] })).toEqual({
        meal: 0,
        task: 1,
        expense: 1,
        project: 1,
      });
      expect(
        await countByKind({
          projectId: [parent.id],
          includeSubProjects: true,
        }),
      ).toEqual({ meal: 0, task: 2, expense: 1, project: 2 });
    });

    it("treats meals as permanently unassigned rows under a project scope", async () => {
      const { parent } = await seed();

      expect((await countByKind({ projectId: [parent.id] })).meal).toBe(0);
      expect((await countByKind({ projectPresenceFilter: "has" })).meal).toBe(
        0,
      );
      expect((await countByKind({ projectPresenceFilter: "none" })).meal).toBe(
        1,
      );
      expect(
        (
          await countByKind({
            projectId: [parent.id],
            projectPresenceFilter: "none",
          })
        ).meal,
      ).toBe(1);
    });

    it("makes an unresolvable project code match nothing, never everything", async () => {
      await seed();
      // "A requested but unresolved id must fail or match nothing; it must
      // never widen to an unfiltered query."
      expect(await countByKind({ projectId: [MISSING_PROJECT] })).toEqual({
        meal: 0,
        task: 0,
        expense: 0,
        project: 0,
      });
      expect(
        await countByKind({
          projectId: [MISSING_PROJECT],
          projectPresenceFilter: "none",
        }),
      ).toEqual({ meal: 1, task: 0, expense: 1, project: 0 });
    });

    it("keeps the day summary consistent with the filtered items", async () => {
      await seed();
      const filtered = await getCalendarRange(ctx.db, {
        ...range,
        projectPresenceFilter: "none",
      });
      expect(filtered.days["2026-10-05"]).toMatchObject({
        mealCount: 1,
        taskCount: 0,
        expenseCount: 1,
        actualSpend: 12,
      });
    });
  });

  it("orders a day's meals by slot, not by title", async () => {
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

    expect(items.map((item) => item.title)).toEqual(["Breakfast", "Meal"]);
  });
});
