import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type {
  CalDavResource,
  CalendarProjection,
} from "~/server/calendar/caldav-types";
import { calendarWriteReceipt } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createMeal, getMealByID } from "~/server/repo/meal";
import { updateTask } from "~/server/repo/task";

import {
  executeCalDavWrite,
  getCalDavWriteReceipt,
  loadCalDavProjection,
} from "./calendar-caldav";

const expectedResource = (
  projection: CalendarProjection,
  collection: "tasks" | "completed-tasks" | "meals",
) =>
  ({
    collection,
    filename: "existing.ics",
    uid: "existing@example.test",
    body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    etag: '"existing"',
    start: "2026-09-07T00:00:00.000Z",
    end: "2026-09-08T00:00:00.000Z",
    projection,
  }) satisfies CalDavResource;

describe("CalDAV canonical mutation seam", () => {
  const ctx = withTestDb();

  it("creates once, records a recovery receipt, and projects the canonical Task", async () => {
    const write = {
      operationId: crypto.randomUUID(),
      actorId: ctx.actor.userId,
      collection: "tasks" as const,
      filename: "calendar-contract.ics",
      expected: null,
      event: {
        uid: "calendar-contract@example.test",
        summary: "CalDAV task",
        startDate: "2026-09-07",
        endDateExclusive: "2026-09-08",
        mealType: null,
      },
    };
    const first = await executeCalDavWrite(ctx.db, write);
    const retry = await executeCalDavWrite(ctx.db, write);

    expect(retry).toEqual(first);
    expect(await getCalDavWriteReceipt(ctx.db, write.operationId)).toEqual(
      first,
    );
    const { projections, identities } = await loadCalDavProjection(ctx.db);
    expect(projections).toContainEqual(
      expect.objectContaining({
        entity: "task",
        id: first.shortcode,
        name: "CalDAV task",
        dueDate: "2026-09-07",
        dueEndDate: "2026-09-07",
      }),
    );
    expect(identities).toContainEqual(
      expect.objectContaining({
        entity: "task",
        shortcode: first.shortcode,
        filename: write.filename,
        uid: write.event.uid,
      }),
    );
    const audit = await getDb(ctx.db).query.auditLog.findMany({
      where: (row, { eq }) => eq(row.source, "caldav"),
    });
    expect(audit).toHaveLength(1);

    const projection = projections.find(
      (value) => value.entity === "task" && value.id === first.shortcode,
    );
    if (!projection) throw new Error("task projection missing");
    const expected = {
      collection: "tasks" as const,
      filename: write.filename,
      uid: write.event.uid,
      body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      etag: '"contract"',
      start: "2026-09-07T00:00:00.000Z",
      end: "2026-09-08T00:00:00.000Z",
      projection,
    };
    await executeCalDavWrite(ctx.db, {
      ...write,
      operationId: crypto.randomUUID(),
      expected,
      event: null,
    });
    await expect(
      executeCalDavWrite(ctx.db, {
        ...write,
        operationId: crypto.randomUUID(),
        expected,
        event: null,
      }),
    ).rejects.toMatchObject({ status: 412 });

    const [receipt] = await getDb(ctx.db)
      .select({ complete: calendarWriteReceipt.sideEffectsCompleted })
      .from(calendarWriteReceipt)
      .where(eq(calendarWriteReceipt.operationId, write.operationId));
    expect(receipt?.complete).toBe(true);
  });

  it("reserves Cubby's shortcode resource namespace for projected entities", async () => {
    await expect(
      executeCalDavWrite(ctx.db, {
        operationId: crypto.randomUUID(),
        actorId: ctx.actor.userId,
        collection: "tasks" as const,
        filename: "TSK-ABCD.ics",
        expected: null,
        event: {
          uid: "client@example.test",
          summary: "Rejected collision",
          startDate: "2026-09-07",
          endDateExclusive: "2026-09-08",
          mealType: null,
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps an unnamed meal unnamed when its generated title is echoed, then renames and reschedules it canonically", async () => {
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
      operationId: crypto.randomUUID(),
      actorId: ctx.actor.userId,
      collection: "meals",
      filename: "existing.ics",
      expected: expectedResource(before, "meals"),
      event: {
        uid: "existing@example.test",
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
      operationId: crypto.randomUUID(),
      actorId: ctx.actor.userId,
      collection: "meals",
      filename: "existing.ics",
      expected: expectedResource(echoed, "meals"),
      event: {
        uid: "existing@example.test",
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

  it("creates completed tasks and refuses a stale compare-and-set after a canonical UI update", async () => {
    const create = {
      operationId: crypto.randomUUID(),
      actorId: ctx.actor.userId,
      collection: "completed-tasks" as const,
      filename: "completed.ics",
      expected: null,
      event: {
        uid: "completed@example.test",
        summary: "Done task",
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
        operationId: crypto.randomUUID(),
        collection: "completed-tasks",
        expected: expectedResource(projection, "completed-tasks"),
        event: { ...create.event, summary: "Stale overwrite" },
      }),
    ).rejects.toMatchObject({ status: 412 });
  });
});
