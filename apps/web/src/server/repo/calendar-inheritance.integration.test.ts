import { calendarRangeInput } from "@cubby/schemas/calendar";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getCalendarRange } from "./calendar";
import { insertWithShortcode } from "./shortcode-utils";

describe("calendar effective attribution", () => {
  const ctx = withTestDb();
  it("filters after full-purchase allocation and counts a shared charge once", async () => {
    const first = await insertWithShortcode(ctx.db, "project", {
      name: "Calendar first project",
      defaultTrade: "building",
    });
    const second = await insertWithShortcode(ctx.db, "project", {
      name: "Calendar second project",
      defaultTrade: "building",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Calendar fixture vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-19",
      defaultProjectId: first.id,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Outside visible dates",
      cost: 2,
      date: "2026-09-19",
      lineKind: "principal",
      costType: "materials",
      trade: null,
      purchaseId: purchase.id,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Other project item",
      cost: 8,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: null,
      projectId: second.id,
      purchaseId: purchase.id,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Shared tax",
      cost: 1,
      date: "2026-09-20",
      lineKind: "tax",
      costType: "services",
      trade: null,
      purchaseId: purchase.id,
    });
    const scoped = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-20",
        endDateExclusive: "2026-09-21",
        kinds: ["expense"],
        projectId: first.shortcode,
      }),
    );
    expect(scoped.items).toHaveLength(1);
    expect(scoped.items[0]).toMatchObject({ title: "Shared tax", cost: 0.2 });
    expect(scoped.days["2026-09-20"]).toMatchObject({
      actualSpend: 0.2,
      expenseCount: 1,
    });
    const all = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-19",
        endDateExclusive: "2026-09-21",
        kinds: ["expense"],
      }),
    );
    expect(all.items).toHaveLength(3);
    expect(
      Object.values(all.days).reduce((sum, day) => sum + day.actualSpend, 0),
    ).toBe(11);
  });

  it("uses inherited task projects and trades in both filters and returned rows", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Calendar task project",
      defaultTrade: "building",
    });
    const parent = await insertWithShortcode(ctx.db, "task", {
      name: "Calendar parent",
      projectId: project.id,
      projectMode: "explicit",
      trade: null,
    });
    await insertWithShortcode(ctx.db, "task", {
      name: "Calendar child",
      parentTaskId: parent.id,
      projectMode: "inherit",
      trade: null,
      dueDate: "2026-09-20",
    });
    const result = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-20",
        endDateExclusive: "2026-09-21",
        kinds: ["task"],
        projectId: project.shortcode,
        taskTrade: "building",
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: "Calendar child",
      projectName: project.name,
      trade: "building",
    });
  });
});
