import { calendarRangeInput } from "@cubby/schemas/calendar";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { createMealWithEntityId } from "~/server/domains/meal/repo/crud";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductIdentityFixture,
  makeProductInput,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";

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
    const beneficiary = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic calendar beneficiary",
    });
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic calendar charge",
      trade: "other",
      purchaseId: purchase.output.id,
      date,
      cost: 5,
      beneficiaries: [{ partyId: beneficiary.output.id, weight: 1 }],
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
        kinds: ["meal", "task", "spending", "project"],
      }),
    );
    const covers = new Map(
      range.items.map((item) => [item.id, item.displayImages[0]?.id]),
    );
    expect(covers.get(project.output.id)).toBe(expected.get(project.output.id));
    expect(covers.get(task.output.id)).toBe(expected.get(project.output.id));
    expect(
      range.items.find((item) => item.id === task.output.id),
    ).toMatchObject({ assignedProjectName: "Synthetic garden season" });
    expect(covers.get(purchase.output.id)).toBe(expected.get(seller.output.id));
    expect(
      range.items.find((item) => item.id === purchase.output.id),
    ).toMatchObject({
      spendingContext: {
        parties: [
          {
            id: beneficiary.output.id,
            name: "Synthetic calendar beneficiary",
            inherited: false,
          },
        ],
      },
    });
    expect(covers.get(meal.id)).toBe(expected.get(meal.id));
  });

  it("coalesces purchase lines and keeps later refunds, standalone charges and plans", async () => {
    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic rollup seller",
    });
    const household = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic household",
      kind: "household",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: seller.output.id,
      date: "2026-09-19",
      statedTotal: 11,
    });
    for (const line of [
      { name: "Synthetic item", cost: 10, lineKind: "principal" as const },
      { name: "Synthetic tax", cost: 2, lineKind: "tax" as const },
      { name: "Synthetic discount", cost: -1, lineKind: "discount" as const },
    ]) {
      await createRepoEntity(ctx, "expense", {
        ...line,
        purchaseId: purchase.output.id,
        date: "2026-09-19",
        trade: "other",
      });
    }
    const refund = await createRepoEntity(ctx, "expense", {
      name: "Synthetic return",
      cost: -4,
      lineKind: "principal",
      purchaseId: purchase.output.id,
      date: "2026-09-21",
      trade: "other",
    });
    const plan = await createRepoEntity(ctx, "expense", {
      name: "Synthetic planned charge",
      cost: 3,
      future: true,
      purchaseId: purchase.output.id,
      date: "2026-09-21",
      trade: "other",
    });
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic direct project",
    });
    const beneficiary = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic beneficiary",
    });
    const standalone = await createRepoEntity(ctx, "expense", {
      name: "Synthetic standalone charge",
      cost: 5,
      date: "2026-09-21",
      trade: "other",
      projectId: project.output.id,
      beneficiaries: [{ partyId: beneficiary.output.id, weight: 1 }],
    });
    const unknown = await createRepoEntity(ctx, "expense", {
      name: "Synthetic explicitly unknown beneficiary",
      date: "2026-09-19",
      cost: 0,
      trade: "other",
      beneficiaries: [{ partyId: null, weight: 1 }],
    });
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic discarded item" }),
      ctx.actor,
    );
    const discardedPurchase = await createRepoEntity(ctx, "purchase", {
      vendorId: seller.output.id,
      date: "2026-09-21",
    });
    for (const purchaseId of [null, discardedPurchase.output.id]) {
      for (const cost of [0, null]) {
        await createRepoEntity(ctx, "expense", {
          name: "Synthetic discard",
          trade: "other",
          date: "2026-09-21",
          productId: product.id,
          productQuantity: -1,
          cost,
          purchaseId,
        });
      }
    }
    const range = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-19",
        endDateExclusive: "2026-09-22",
        kinds: ["spending"],
      }),
    );
    const originals = range.items.filter(
      (item) => item.kind === "purchase" && item.occurrence === "original",
    );
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      id: purchase.output.id,
      cost: 11,
      ledgerAmount: 11,
      startDate: "2026-09-19",
      spendingContext: {
        parties: [
          {
            id: household.output.id,
            name: "Synthetic household",
            inherited: true,
          },
        ],
      },
    });
    expect(
      range.items.find((item) => item.id === unknown.output.id),
    ).toMatchObject({ spendingContext: { parties: [] } });
    const later = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-21",
        endDateExclusive: "2026-09-22",
        kinds: ["spending"],
      }),
    );
    expect(later.items).toHaveLength(3);
    expect(
      later.items.find((item) => item.id === plan.output.id),
    ).toMatchObject({
      spendingContext: {
        parties: [{ id: household.output.id, inherited: true }],
      },
    });
    expect(
      later.items.find((item) => item.id === standalone.output.id),
    ).toMatchObject({
      spendingContext: {
        projectNames: ["Synthetic direct project"],
        parties: [
          {
            id: beneficiary.output.id,
            name: "Synthetic beneficiary",
            inherited: false,
          },
        ],
      },
    });
    expect(later.items.find((item) => item.kind === "purchase")).toMatchObject({
      occurrence: "refund",
      cost: -4,
      lines: [{ id: refund.output.id }],
    });
    expect(
      later.items
        .filter((item) => item.kind === "expense")
        .map((item) => item.id)
        .sort(),
    ).toEqual([plan.output.id, standalone.output.id].sort());
    expect(later.days["2026-09-21"]).toMatchObject({
      actualSpend: 1,
      plannedSpend: 3,
    });
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
    expect(range.days["2026-09-20"]?.itemIds).toEqual([
      `task:${task.shortcode}`,
    ]);
    expect([...(range.days["2026-09-21"]?.itemIds ?? [])].sort()).toEqual(
      [`meal:${meal.id}`, `task:${task.shortcode}`].sort(),
    );
    expect(range.days["2026-09-22"]?.itemIds).toEqual([
      `task:${task.shortcode}`,
    ]);
    // The end date is inclusive for a task, so the day after is empty.
    expect(range.days["2026-09-23"]?.itemIds).toEqual([]);
    expect(range.days["2026-09-21"]?.mealCount).toBe(1);
  });
});
