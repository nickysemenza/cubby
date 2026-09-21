import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type {
  CalDavResource,
  CalendarProjection,
} from "~/server/calendar/caldav-types";
import { getDb } from "~/server/repo/database-helpers";
import { createMeal, getMealByID } from "~/server/repo/meal";
import { updateTask } from "~/server/repo/task";

import { executeCalDavWrite, loadCalDavProjection } from "./calendar-caldav";

const expectedResource = (
  projection: CalendarProjection,
  collection: "tasks" | "completed-tasks" | "meals",
) =>
  ({
    collection,
    filename: `${projection.id}.ics`,
    uid: `${projection.id}@cubby.nickysemenza.com`,
    body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    etag: '"existing"',
    start: "2026-09-07T00:00:00.000Z",
    end: "2026-09-08T00:00:00.000Z",
    projection,
  }) satisfies CalDavResource;

describe("CalDAV canonical mutation seam", () => {
  const ctx = withTestDb();

  it("creates a Task through the canonical kernel and preserves CalDAV attribution", async () => {
    const result = await executeCalDavWrite(ctx.db, {
      actorId: ctx.actor.userId,
      collection: "tasks",
      filename: "client-event.ics",
      expected: null,
      event: {
        uid: "client-event@example.test",
        summary: "CalDAV task",
        trade: "planning",
        startDate: "2026-09-07",
        endDateExclusive: "2026-09-08",
        mealType: null,
      },
    });

    expect((await loadCalDavProjection(ctx.db)).projections).toContainEqual(
      expect.objectContaining({
        entity: "task",
        id: result.shortcode,
        name: "CalDAV task",
        dueDate: "2026-09-07",
        dueEndDate: "2026-09-07",
      }),
    );
    const audit = await getDb(ctx.db).query.auditLog.findMany({
      where: (row, { eq }) => eq(row.source, "caldav"),
    });
    expect(audit).toHaveLength(1);
  });

  it("refuses an unclassified new task before writing", async () => {
    await expect(
      executeCalDavWrite(ctx.db, {
        actorId: ctx.actor.userId,
        collection: "tasks",
        filename: "unclassified.ics",
        expected: null,
        event: {
          uid: "unclassified@example.test",
          summary: "Needs a trade",
          startDate: "2026-09-07",
          endDateExclusive: "2026-09-08",
          mealType: null,
        },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await getDb(ctx.db).query.task.findMany()).toHaveLength(0);
  });

  it("keeps an unnamed meal unnamed when its generated title is echoed, then updates it canonically", async () => {
    const meal = await createMeal(
      ctx.db,
      { date: "2026-09-07", name: null, mealType: "breakfast" },
      ctx.actor,
    );
    const before = (await loadCalDavProjection(ctx.db)).projections.find(
      (value) => value.entity === "meal" && value.id === meal.id,
    );
    if (!before || before.entity !== "meal")
      throw new Error("meal projection missing");
    await executeCalDavWrite(ctx.db, {
      actorId: ctx.actor.userId,
      collection: "meals",
      filename: `${meal.id}.ics`,
      expected: expectedResource(before, "meals"),
      event: {
        uid: `${meal.id}@cubby.nickysemenza.com`,
        summary: "Breakfast",
        startDate: "2026-09-07",
        endDateExclusive: "2026-09-08",
        mealType: "breakfast",
      },
    });
    const mealRow = await getDb(ctx.db).query.meal.findFirst({
      where: (row, { eq }) => eq(row.shortcode, meal.id),
    });
    if (!mealRow) throw new Error("meal row missing");
    expect((await getMealByID(ctx.db, mealRow.id))?.name).toBeNull();

    const echoed = (await loadCalDavProjection(ctx.db)).projections.find(
      (value) => value.entity === "meal" && value.id === meal.id,
    );
    if (!echoed || echoed.entity !== "meal")
      throw new Error("meal projection missing");
    await executeCalDavWrite(ctx.db, {
      actorId: ctx.actor.userId,
      collection: "meals",
      filename: `${meal.id}.ics`,
      expected: expectedResource(echoed, "meals"),
      event: {
        uid: `${meal.id}@cubby.nickysemenza.com`,
        summary: "Brunch out",
        startDate: "2026-09-08",
        endDateExclusive: "2026-09-09",
        mealType: "brunch",
      },
    });
    expect((await loadCalDavProjection(ctx.db)).projections).toContainEqual(
      expect.objectContaining({
        entity: "meal",
        id: meal.id,
        name: "Brunch out",
        date: "2026-09-08",
        mealType: "brunch",
      }),
    );
  });

  it("creates completed tasks and refuses a stale compare-and-set after a canonical update", async () => {
    const create = {
      actorId: ctx.actor.userId,
      collection: "completed-tasks" as const,
      filename: "completed.ics",
      expected: null,
      event: {
        uid: "completed@example.test",
        summary: "Done task",
        trade: "planning" as const,
        startDate: "2026-09-07",
        endDateExclusive: "2026-09-08",
        mealType: null,
      },
    };
    const result = await executeCalDavWrite(ctx.db, create);
    const projection = (await loadCalDavProjection(ctx.db)).projections.find(
      (value) => value.entity === "task" && value.id === result.shortcode,
    );
    if (!projection || projection.entity !== "task")
      throw new Error("task projection missing");
    expect(projection.status).toBe("done");
    await updateTask(
      ctx.db,
      projection.id,
      { status: "not_started" },
      ctx.actor,
    );
    await expect(
      executeCalDavWrite(ctx.db, {
        ...create,
        expected: expectedResource(projection, "completed-tasks"),
        event: { ...create.event, summary: "Stale overwrite" },
      }),
    ).rejects.toMatchObject({ status: 412 });
  });
});
