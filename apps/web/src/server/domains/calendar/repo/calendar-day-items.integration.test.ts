import { calendarRangeInput } from "@cubby/schemas/calendar";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { createMealWithEntityId } from "~/server/domains/meal/repo/crud";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { insertEntityAttachments } from "~/server/testing/repo.fixtures";

import { getCalendarRange } from "./calendar";

describe("calendar day membership", () => {
  const ctx = withTestDb();

  it("returns canonical own and transitive images for the entire mixed calendar range", async () => {
    const date = "2026-09-21";
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic garden season",
      dates: { start: date, end: date },
    });
    const task = await createRepoEntity(ctx, "task", {
      name: "Synthetic garden task",
      projectId: project.output.id,
      due: { start: date, end: date },
      trade: "planning",
    });
    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic calendar seller",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: seller.output.id,
      date,
    });
    const expense = await createRepoEntity(ctx, "expense", {
      name: "Synthetic calendar charge",
      trade: "other",
      purchaseId: purchase.output.id,
      date,
      cost: 5,
    });
    const { entityId: mealId, output: meal } = await createMealWithEntityId(
      ctx.db,
      { date, name: "Synthetic own-photo meal", mealType: "dinner" },
      ctx.actor,
    );
    const expected = new Map<string, string>();
    for (const owner of [project, seller, { entityId: mealId, output: meal }]) {
      const image = await createUploadedImageRecord(ctx.db, {
        key: `images/${crypto.randomUUID()}.jpg`,
        filename: "synthetic.jpg",
        contentType: "image/jpeg",
        size: 100,
      });
      await insertEntityAttachments(ctx.db, {
        entityId: owner.entityId,
        imageId: image.id,
        role: owner.entityId === seller.entityId ? "logo" : "attachment",
      });
      expected.set(owner.output.id, image.shortcode);
    }
    const range = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: date,
        endDateExclusive: "2026-09-22",
        kinds: ["meal", "task", "expense", "project"],
      }),
    );
    const covers = new Map(
      range.items.map((item) => [item.id, item.displayImages[0]?.id]),
    );
    expect(covers.get(project.output.id)).toBe(expected.get(project.output.id));
    expect(covers.get(task.output.id)).toBe(expected.get(project.output.id));
    expect(covers.get(expense.output.id)).toBe(expected.get(seller.output.id));
    expect(covers.get(meal.id)).toBe(expected.get(meal.id));
  });

  // Native and web both bucket items by day; the server owns the rule so a
  // multi-day span belongs to every day it covers and nothing outside it.
  it("lists each item on every in-range day it covers, and only those days", async () => {
    const { output: meal } = await createMealWithEntityId(
      ctx.db,
      { date: "2026-09-21", name: "Synthetic supper", mealType: "dinner" },
      ctx.actor,
    );
    const task = await insertWithShortcode(ctx.db, "task", {
      name: "Synthetic multi-day task",
      trade: "planning",
      dueDate: "2026-09-20",
      dueEndDate: "2026-09-22",
    });

    const range = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-19",
        endDateExclusive: "2026-09-24",
        kinds: ["meal", "task"],
      }),
    );

    expect(Object.keys(range.days)).toHaveLength(5);
    expect(range.days["2026-09-19"]?.itemIds).toEqual([]);
    expect(range.days["2026-09-20"]?.itemIds).toEqual([task.shortcode]);
    expect([...(range.days["2026-09-21"]?.itemIds ?? [])].sort()).toEqual(
      [meal.id, task.shortcode].sort(),
    );
    expect(range.days["2026-09-22"]?.itemIds).toEqual([task.shortcode]);
    // The end date is inclusive for a task, so the day after is empty.
    expect(range.days["2026-09-23"]?.itemIds).toEqual([]);
    expect(range.days["2026-09-21"]?.mealCount).toBe(1);
  });
});
