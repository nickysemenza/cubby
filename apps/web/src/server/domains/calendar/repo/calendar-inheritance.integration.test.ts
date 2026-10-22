import { calendarRangeInput } from "@cubby/schemas/calendar";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { getCalendarRange, getCalendarSchedule } from "./calendar";

describe("calendar effective attribution", () => {
  const ctx = withTestDb();
  it("selects expenses through allocation membership and shows whole-record amounts", async () => {
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
        filters: { expense: { projectId: [first.shortcode] } },
      }),
    );
    expect(scoped.items).toHaveLength(1);
    expect(scoped.items[0]).toMatchObject({ title: "Shared tax", cost: 1 });
    expect(scoped.days["2026-09-20"]).toMatchObject({
      actualSpend: 1,
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
        filters: {
          task: { projectId: [project.shortcode], trade: ["building"] },
        },
      }),
    );
    const conflicting = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-20",
        endDateExclusive: "2026-09-21",
        filters: { task: { trade: ["building"] }, expense: { future: false } },
      }),
    );
    expect(conflicting.items).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: "Calendar child",
      projectName: project.name,
      trade: "building",
    });
  });

  it("uses planting list filters, excludes other kinds, and retains existing schedule rows", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Calendar garden project",
      defaultTrade: "building",
    });
    const parent = await insertWithShortcode(ctx.db, "task", {
      name: "Parent garden work",
      projectId: project.id,
      projectMode: "explicit",
    });
    const linkedTask = await insertWithShortcode(ctx.db, "task", {
      name: "Undated linked work",
      parentTaskId: parent.id,
      projectMode: "inherit",
    });
    const crop = await insertWithShortcode(ctx.db, "plant", {
      name: "Example crop",
    });
    const linked = await insertWithShortcode(ctx.db, "planting", {
      plantId: crop.id,
      taskId: linkedTask.id,
      status: "planned",
      sowedOn: "2026-09-20",
      transplantedOn: "2026-09-22",
    });
    const unlinked = await insertWithShortcode(ctx.db, "planting", {
      plantId: crop.id,
      status: "planned",
      sowedOn: "2026-09-20",
    });
    const undated = await insertWithShortcode(ctx.db, "planting", {
      plantId: crop.id,
      status: "planned",
    });
    const input = calendarRangeInput.parse({
      startDate: "2026-09-20",
      endDateExclusive: "2026-09-21",
      filters: { planting: { taskId: [linkedTask.shortcode] } },
      kinds: ["task", "planting"],
    });

    const month = await getCalendarRange(ctx.db, input);
    expect(month.items.filter((item) => item.kind === "planting")).toEqual([
      expect.objectContaining({ id: linked.shortcode }),
    ]);

    const schedule = await getCalendarSchedule(ctx.db, input);
    expect(schedule.tasks).toEqual([]);
    expect(schedule.plantings).toEqual([
      expect.objectContaining({
        id: linked.shortcode,
        sowedOn: "2026-09-20",
        transplantedOn: "2026-09-22",
      }),
    ]);

    const unassigned = await getCalendarSchedule(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-20",
        endDateExclusive: "2026-09-21",
        kinds: ["planting"],
        filters: { planting: { taskIdPresenceFilter: "none" } },
      }),
    );
    expect(unassigned.plantings.map((row) => row.id).sort()).toEqual(
      [unlinked.shortcode, undated.shortcode].sort(),
    );
  });
});
