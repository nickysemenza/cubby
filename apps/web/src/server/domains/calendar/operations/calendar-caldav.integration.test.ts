import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { testShortcode } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";
import { withInvocationDb } from "~/server/db";
import {
  getDb,
  runAfterCommit,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import type {
  CalDavResource,
  CalendarProjection,
} from "~/server/domains/calendar/repo/caldav-types";
import { readMealById } from "~/server/domains/meal/repo/crud";
import { createMealWithEntityId } from "~/server/domains/meal/repo/crud";
import { updateTask } from "~/server/domains/task/repo/crud";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";

import { scheduleCalendarFeedDirty } from "../repo/client";
import {
  executeCalDavWrite,
  hasCalDavCommitReceipt,
  visitCalDavProjection,
  type CalDavCommitReceipt,
} from "./calendar-caldav";

const loadCalDavProjection = async (
  db: Parameters<typeof visitCalDavProjection>[0],
) => {
  const projections: CalendarProjection[] = [];
  await visitCalDavProjection(db, async (page) => {
    projections.push(...page);
  });
  return { projections };
};

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
    let receipt: CalDavCommitReceipt | undefined;
    const result = await executeCalDavWrite(
      ctx.db,
      {
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
      },
      async (prepared) => {
        receipt = prepared;
      },
    );
    expect(receipt).toBeDefined();
    if (!receipt) return;
    expect(
      await hasCalDavCommitReceipt(ctx.db, { ...receipt, entity: "task" }),
    ).toBe(true);
    expect(
      await hasCalDavCommitReceipt(ctx.db, {
        ...receipt,
        shortcode: testShortcode("task", "unrelated"),
        entity: "task",
      }),
    ).toBe(false);

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
      where: {
        RAW: (row, { eq }) => relationalSql(row, eq(row.channel, "caldav")),
      },
    });
    expect(audit).toHaveLength(1);

    const unchanged = await executeCalDavWrite(ctx.db, {
      actorId: ctx.actor.userId,
      collection: "tasks",
      filename: "client-event.ics",
      expected: expectedResource(result.projection, "tasks"),
      event: {
        uid: "client-event@example.test",
        summary: "CalDAV task",
        startDate: "2026-09-07",
        endDateExclusive: "2026-09-08",
        mealType: null,
      },
    });
    expect(unchanged.shortcode).toBe(result.shortcode);
    expect(unchanged.projection).toMatchObject({
      name: "CalDAV task",
      dueDate: "2026-09-07",
    });
    expect(await getDb(ctx.db).query.auditLog.findMany()).toHaveLength(1);

    let committed: CalDavCommitReceipt | undefined;
    await expect(
      withTransactionDatabase(ctx.db, async (db) => {
        await runAfterCommit(db, async () => {
          throw new Error("synthetic effect failure after commit");
        });
        return executeCalDavWrite(
          db,
          {
            actorId: ctx.actor.userId,
            collection: "tasks",
            filename: "client-event.ics",
            expected: expectedResource(result.projection, "tasks"),
            event: {
              uid: "client-event@example.test",
              summary: "Saved despite effect failure",
              startDate: "2026-09-08",
              endDateExclusive: "2026-09-09",
              mealType: null,
            },
          },
          async (prepared) => {
            committed = prepared;
          },
        );
      }),
    ).rejects.toThrow(
      "Transaction committed, but an after-commit effect failed",
    );
    expect(committed).toBeDefined();
    if (!committed) return;
    expect(
      await hasCalDavCommitReceipt(ctx.db, { ...committed, entity: "task" }),
    ).toBe(true);
    expect((await loadCalDavProjection(ctx.db)).projections).toContainEqual(
      expect.objectContaining({
        id: result.shortcode,
        name: "Saved despite effect failure",
      }),
    );
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
    let abandoned: CalDavCommitReceipt | undefined;
    await expect(
      executeCalDavWrite(
        ctx.db,
        {
          actorId: ctx.actor.userId,
          collection: "tasks",
          filename: "abandoned.ics",
          expected: null,
          event: {
            uid: "abandoned@example.test",
            summary: "Rolled back task",
            trade: "planning",
            startDate: "2026-09-07",
            endDateExclusive: "2026-09-08",
            mealType: null,
          },
        },
        async (receipt) => {
          abandoned = receipt;
          throw new Error("synthetic interruption before commit");
        },
      ),
    ).rejects.toThrow("synthetic interruption before commit");
    expect(abandoned).toBeDefined();
    if (!abandoned) return;
    expect(
      await hasCalDavCommitReceipt(ctx.db, { ...abandoned, entity: "task" }),
    ).toBe(false);
    expect(await getDb(ctx.db).query.task.findMany()).toHaveLength(0);
  });

  it("keeps an unnamed meal unnamed when its generated title is echoed, then updates it canonically", async () => {
    const { output: meal } = await createMealWithEntityId(
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
      where: {
        RAW: (row, { eq }) => relationalSql(row, eq(row.shortcode, meal.id)),
      },
    });
    if (!mealRow) throw new Error("meal row missing");
    expect((await readMealById(ctx.db, mealRow.id))?.name).toBeNull();

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

describe("durable calendar dirty-mark fallback", () => {
  const ctx = withTestDb();
  afterEach(() => {
    setCfEnv(undefined);
    vi.useRealTimers();
  });
  it("hands one failed mark to a durable Job that survives a failed queue wake", async () =>
    withInvocationDb(ctx.databaseUrl, async () => {
      vi.useFakeTimers();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
        // SILENT: assertion target only, not the code under test.
      });
      const markDirty = vi
        .fn()
        .mockRejectedValue(new Error("stub RPC failure"));
      const sendBatch = vi.fn().mockRejectedValue(new Error("queue down"));
      setCfEnv(
        fromPartial<Env>({
          CALENDAR_FEED: { getByName: () => ({ markDirty }) },
          BACKGROUND_QUEUE: { sendBatch },
        }),
      );

      const tasks: Promise<unknown>[] = [];
      await runWithExecutionCtx(
        { waitUntil: (task) => tasks.push(task) },
        async () => {
          scheduleCalendarFeedDirty("test.write");
        },
        "https://cubby.example",
      );
      await expect(tasks[0]).resolves.toBeUndefined();
      expect(markDirty).toHaveBeenCalledTimes(1);
      // The fallback's wake is its own retained task, with its own bounded retries.
      await vi.advanceTimersByTimeAsync(5_250);
      await Promise.all(tasks);
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "calendar-feed.mark-dirty-fallback",
          error: expect.objectContaining({ message: "queue down" }),
        }),
      );
      expect(
        (await readJobs(ctx.db, {})).some(
          (row) => row.kind === "calendar-feed.mark-dirty",
        ),
      ).toBe(true);
      consoleError.mockRestore();
    }));
});

// Existing pending writes must remain unresolved when exact commit evidence is unavailable.
it("preserves populated Calendar SQLite state while adding commit evidence", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const name of [
      "20260907210455_bright_tyger_tiger",
      "20260908023453_watery_tomas",
    ])
      sqlite.exec(
        readFileSync(
          new URL(`../repo/migrations/${name}/migration.sql`, import.meta.url),
          "utf8",
        ),
      );
    sqlite.exec(`
      INSERT INTO calendar_meta (id, generation, dirty_reason, dirty_sequence) VALUES (1, 7, 'pending', 12);
      INSERT INTO calendar_credentials VALUES ('synthetic-owner', 'synthetic-login', 'synthetic-hash', '2026-09-07T00:00:00Z');
      INSERT INTO calendar_identities VALUES ('synthetic-record', 'meal', 'client.ics', 'client@example.test');
      INSERT INTO calendar_uncertain_writes VALUES ('meal', 'meals', 'client.ics', 'client@example.test', NULL, '2026-09-07T00:00:00Z');
      INSERT INTO calendar_documents VALUES ('meals', 'synthetic-document', 'synthetic-etag', '2026-09-07T00:00:00Z', 7, 1);
    `);
    const tables = [
      "calendar_meta",
      "calendar_credentials",
      "calendar_identities",
      "calendar_documents",
    ];
    const before = tables.map((table) =>
      sqlite.prepare(`SELECT * FROM ${table}`).all(),
    );
    sqlite.exec(
      readFileSync(
        new URL(
          "../repo/migrations/20261107171347_flashy_lester/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      tables.map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
    expect(
      sqlite.prepare("SELECT * FROM calendar_uncertain_writes").get(),
    ).toMatchObject({
      filename: "client.ics",
      uid: "client@example.test",
      shortcode: null,
      audit_id: null,
    });
  } finally {
    sqlite.close();
  }
});
