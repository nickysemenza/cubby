import { locationFiltersSchema } from "@cubby/schemas/location";
import { plantingFiltersSchema } from "@cubby/schemas/planting";
import {
  expenseFiltersSchema,
  taskFiltersSchema,
} from "@cubby/schemas/project";
import { and, inArray, type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import { getDb, householdDaySql } from "~/server/db/helpers";
import { expense, location, planting, task } from "~/server/db/schema";
import { expenseList } from "~/server/domains/expense/repo/lookup";
import {
  createPlanting,
  plantingList,
} from "~/server/domains/garden/repo/garden";
import { locationList } from "~/server/domains/location/repo/crud";
import { effectiveTaskDueDateSql } from "~/server/domains/task/repo/helpers";
import { taskList } from "~/server/domains/task/repo/lookup";
import { resolveRelativeDateFilters } from "~/server/entity-kernel/filter-tokens";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createPlantFixture,
  makeExpenseInput,
} from "~/server/testing/repo.fixtures";

/**
 * Plan rows 30–33 (#2415): relative date predicates become range values with
 * `@today` tokens, and planting `activeOn` a `dateInterval`. Each retired
 * predicate's SQL runs beside the compiled filter over one synthetic fixture.
 * Failure modes: a token resolved once and frozen (a saved view that stops
 * moving), a range's No value ANDed with its bounds (matches nothing), Any
 * value widening bounds, and interval edges off by one day or dropping an
 * open (unfinished) span.
 */
describe("relative date tokens and date intervals", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 200 };
  const today = householdLocalDate();
  const day = (offset: number) => shiftPlainDate(today, offset);
  const sorted = (names: Iterable<string>) => [...names].sort();

  /** The fixture names a retired predicate's SQL selects. */
  const retired = async (
    table: PgTable & { name: PgColumn },
    names: readonly string[],
    condition: SQL,
  ) =>
    sorted(
      (
        await getDb(ctx.db)
          .select({ name: table.name })
          .from(table)
          .where(and(inArray(table.name, [...names]), condition))
      ).map((row) => row.name),
    );
  const within = (
    rows: readonly { name: string }[],
    names: readonly string[],
  ) =>
    sorted(rows.map((row) => row.name).filter((name) => names.includes(name)));

  it("task dueTo @today-1d matches the retired dueRelative and moves with the day", async () => {
    const seed = (name: string, dueDate: string | null, dueEndDate?: string) =>
      insertWithShortcode(ctx.db, "task", {
        name,
        trade: "other",
        dueDate,
        dueEndDate: dueEndDate ?? null,
      });
    await seed("Due yesterday", day(-1));
    await seed("Due today", day(0));
    // The effective due date is the window's end.
    await seed("Window ending today", day(-5), day(0));
    await seed("Window ended yesterday", day(-5), day(-1));
    await seed("Undated", null);
    const names = [
      "Due yesterday",
      "Due today",
      "Window ending today",
      "Window ended yesterday",
      "Undated",
    ];
    const overdue = async (on: string) =>
      within(
        (
          await taskList(
            ctx.db,
            resolveRelativeDateFilters(
              taskFiltersSchema,
              { dueTo: "@today-1d" },
              on,
            ),
            [],
            page,
          )
        ).data,
        names,
      );

    expect(await overdue(today)).toEqual(
      await retired(task, names, sql`${effectiveTaskDueDateSql()} < ${today}`),
    );
    expect(await overdue(today)).toEqual([
      "Due yesterday",
      "Window ended yesterday",
    ]);
    // The same saved filter read tomorrow.
    expect(await overdue(day(1))).toEqual([
      "Due today",
      "Due yesterday",
      "Window ended yesterday",
      "Window ending today",
    ]);
  });

  it("a range's No value ORs with its bounds; Any value leaves the bounds alone", async () => {
    const seed = (name: string, dueDate: string | null) =>
      insertWithShortcode(ctx.db, "task", { name, trade: "other", dueDate });
    await seed("Bounded due", day(-3));
    await seed("Later due", day(10));
    await seed("No due date", null);
    const names = ["Bounded due", "Later due", "No due date"];
    const read = async (filters: Record<string, string>) =>
      within(
        (
          await taskList(
            ctx.db,
            resolveRelativeDateFilters(taskFiltersSchema, filters, today),
            [],
            page,
          )
        ).data,
        names,
      );
    expect(await read({ dueTo: "@today", duePresenceFilter: "none" })).toEqual([
      "Bounded due",
      "No due date",
    ]);
    expect(await read({ dueTo: "@today", duePresenceFilter: "has" })).toEqual([
      "Bounded due",
    ]);
    expect(await read({ duePresenceFilter: "none" })).toEqual(["No due date"]);
  });

  it("expense dateTo @today-1d matches the retired dateRelative", async () => {
    const names = ["Spent yesterday", "Spent today", "Planned tomorrow"];
    for (const [name, date] of [
      ["Spent yesterday", day(-1)],
      ["Spent today", day(0)],
      ["Planned tomorrow", day(1)],
    ] as const)
      await createRepoEntity(ctx, "expense", makeExpenseInput({ name, date }));
    const { data } = await expenseList(
      ctx.db,
      resolveRelativeDateFilters(
        expenseFiltersSchema,
        { dateTo: "@today-1d" },
        today,
      ),
      [],
      page,
    );
    expect(within(data, names)).toEqual(
      await retired(expense, names, sql`${expense.date} < ${today}`),
    );
    expect(within(data, names)).toEqual(["Spent yesterday"]);
  });

  it("location recount overdue is lastBulkInventory to @today-Nd or never, in household days", async () => {
    const counted = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const seed = (name: string, lastBulkInventory: Date | null) =>
      insertWithShortcode(ctx.db, "location", {
        name,
        type: "shelf",
        lastBulkInventory,
      });
    await seed("Never recounted", null);
    await seed("Recounted 90 days ago", counted(90));
    await seed("Recounted 5 days ago", counted(5));
    const names = [
      "Never recounted",
      "Recounted 90 days ago",
      "Recounted 5 days ago",
    ];
    const { data } = await locationList(
      ctx.db,
      resolveRelativeDateFilters(
        locationFiltersSchema,
        {
          lastBulkInventoryTo: "@today-30d",
          lastBulkInventoryPresenceFilter: "none",
        },
        today,
      ),
      [],
      page,
    );
    // Equal away from the boundary day; on it, whole household days now
    // decide where elapsed time did (named in the PR).
    expect(within(data, names)).toEqual(
      await retired(
        location,
        names,
        sql`(${location.lastBulkInventory} IS NULL OR ${location.lastBulkInventory} < now() - make_interval(days => 30))`,
      ),
    );
    expect(within(data, names)).toEqual([
      "Never recounted",
      "Recounted 90 days ago",
    ]);
  });

  it("planting activeOn is containment and activeFrom/activeTo overlap of the active span", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      { name: "Interval crop" },
      TEST_ACTOR,
    );
    const seed = async (
      name: string,
      dates: { sowedOn?: string; transplantedOn?: string; finishedOn?: string },
    ) => {
      const row = await createPlanting(
        ctx.db,
        {
          plantId: crop.id,
          status: dates.finishedOn ? "finished" : "growing",
          notes: name,
          ...dates,
        },
        TEST_ACTOR,
      );
      return [row.id, name] as const;
    };
    const fixture = new Map([
      await seed("May run", {
        sowedOn: "2026-05-01",
        finishedOn: "2026-05-31",
      }),
      await seed("Open from June", { sowedOn: "2026-06-01" }),
      await seed("Transplanted mid-May", {
        transplantedOn: "2026-05-15",
        finishedOn: "2026-06-10",
      }),
    ]);
    const names = [...fixture.values()];
    const read = async (filters: Record<string, string>) =>
      sorted(
        (
          await plantingList(
            ctx.db,
            resolveRelativeDateFilters(plantingFiltersSchema, filters, today),
            page,
          )
        ).data.flatMap((row) => {
          const name = fixture.get(row.id);
          return name === undefined ? [] : [name];
        }),
      );
    const retiredActiveOn = async (on: string) =>
      sorted(
        (
          await getDb(ctx.db)
            .select({ notes: planting.notes })
            .from(planting)
            .where(
              and(
                inArray(planting.notes, names),
                sql`COALESCE(${planting.sowedOn}, ${planting.transplantedOn}, ${householdDaySql(planting.createdAt)}) <= ${on}::date
                  AND (${planting.finishedOn} IS NULL OR ${planting.finishedOn} >= ${on}::date)`,
              ),
            )
        ).flatMap((row) => (row.notes === null ? [] : [row.notes])),
      );

    for (const on of ["2026-04-30", "2026-05-01", "2026-05-31", "2026-06-01"])
      expect(await read({ activeOn: on })).toEqual(await retiredActiveOn(on));
    // Both ends are inclusive; an unfinished span stays open.
    expect(await read({ activeOn: "2026-05-01" })).toEqual(["May run"]);
    expect(await read({ activeOn: "2026-05-31" })).toEqual([
      "May run",
      "Transplanted mid-May",
    ]);
    expect(await read({ activeOn: "2026-06-11" })).toEqual(["Open from June"]);
    // Overlap: a span that runs into the window from either side counts.
    expect(
      await read({ activeFrom: "2026-05-31", activeTo: "2026-06-01" }),
    ).toEqual(["May run", "Open from June", "Transplanted mid-May"]);
    expect(await read({ activeFrom: "2026-06-11" })).toEqual([
      "Open from June",
    ]);
    expect(await read({ activeTo: "2026-04-30" })).toEqual([]);
  });
});
