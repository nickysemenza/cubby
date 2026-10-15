import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import { getDb } from "~/server/db/helpers";

import { awaitingPostingSql } from "./settlement-grace";

// Old evidence must not enumerate every intervening date in a queue read.
// Preserve complete-day boundaries, every weekday, future/null dates, and the
// household midnight across daylight-saving changes without a holiday calendar.
describe("settlement posting grace", () => {
  const ctx = withTestDb();

  it("bounds posting-age work independently of evidence age", async () => {
    const statement = sql`WITH evidence(start) AS (VALUES
      ('2000-01-01'::date), ('2026-10-14'::date), (NULL::date), ('2026-11-01'::date)
    ) SELECT start, ${awaitingPostingSql(sql`evidence.start`, new Date("2026-10-15T12:00:00Z"))} AS awaiting FROM evidence`;
    const rows = z
      .array(z.object({ awaiting: z.boolean() }))
      .parse((await getDb(ctx.db).execute(statement)).rows);
    expect(rows.map((row) => row.awaiting)).toEqual([false, true, true, true]);
    const result = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
    );
    const plans = z
      .array(
        z.object({ "QUERY PLAN": z.array(z.object({ Plan: z.unknown() })) }),
      )
      .parse(result.rows);
    const nodeSchema = z.object({
      "Node Type": z.string(),
      "Actual Rows": z.number().default(0),
      "Actual Loops": z.number().default(0),
      "Rows Removed by Filter": z.number().default(0),
      Plans: z.array(z.unknown()).optional(),
    });
    let generatedRows = 0;
    const visit = (value: unknown) => {
      const node = nodeSchema.parse(value);
      if (node["Node Type"] === "Function Scan")
        generatedRows +=
          (node["Actual Rows"] + node["Rows Removed by Filter"]) *
          node["Actual Loops"];
      node.Plans?.forEach(visit);
    };
    for (const row of plans)
      row["QUERY PLAN"].forEach(({ Plan }) => visit(Plan));
    expect(generatedRows).toBeLessThan(100);
  });

  it("matches complete business-day counting across weekdays and household midnight", async () => {
    for (let offset = 0; offset < 15; offset++) {
      const now = new Date(Date.UTC(2026, 9, 4 + offset, 12));
      const result = await getDb(ctx.db)
        .execute(sql`WITH evidence(start) AS (VALUES
        ('2026-10-05'::date), ('2026-10-06'::date), ('2026-10-07'::date),
        ('2026-10-08'::date), ('2026-10-09'::date), ('2026-10-10'::date),
        ('2026-10-11'::date), (NULL::date), ('2026-11-01'::date)
      ) SELECT start::text, ${awaitingPostingSql(sql`evidence.start`, now)} AS awaiting,
        (SELECT count(*) < 2 FROM generate_series(evidence.start + 1,
          ${householdLocalDate(now)}::date - 1, interval '1 day') day
          WHERE extract(isodow FROM day) BETWEEN 1 AND 5) AS expected
      FROM evidence`);
      const rows = z
        .array(
          z.object({
            start: z.string().nullable(),
            awaiting: z.boolean(),
            expected: z.boolean(),
          }),
        )
        .parse(result.rows);
      expect({
        day: householdLocalDate(now),
        actual: rows.map(({ start, awaiting }) => ({ start, awaiting })),
      }).toEqual({
        day: householdLocalDate(now),
        actual: rows.map(({ start, expected }) => ({
          start,
          awaiting: expected,
        })),
      });
    }
    for (const [start, now, expected] of [
      ["2026-03-06", "2026-03-11T06:59:59Z", true],
      ["2026-03-06", "2026-03-11T07:00:00Z", false],
      ["2026-10-30", "2026-11-04T07:59:59Z", true],
      ["2026-10-30", "2026-11-04T08:00:00Z", false],
    ] as const) {
      const result = await getDb(ctx.db).execute(
        sql`SELECT ${awaitingPostingSql(sql`${start}::date`, new Date(now))} AS awaiting`,
      );
      expect(result.rows).toEqual([{ awaiting: expected }]);
    }
  });
});
