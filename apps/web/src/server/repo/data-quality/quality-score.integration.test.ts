import {
  type QualityTerm,
  scoreQualityTerms,
} from "@cubby/schemas/data-quality";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrapDb } from "~/server/repo/database-helpers";

import { qualityStateCode, scoreFromStates, statusFromStates } from "./sql";

const weights = [0, 1, 3, 7] as const;
const caps = [null, 0, 40, 98] as const;
const states = [
  "not_applicable",
  "satisfied",
  "gap",
  "excepted",
] as const satisfies readonly QualityTerm["state"][];

/** A deterministic spread of term sets: empty, single and mixed records. */
const cases = (): QualityTerm[][] => {
  let seed = 7;
  const next = (length: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % length;
  };
  const result: QualityTerm[][] = [[]];
  for (let index = 0; index < 160; index++) {
    result.push(
      Array.from({ length: 1 + next(4) }, () => ({
        weight: weights[next(weights.length)]!,
        scoreCap: caps[next(caps.length)]!,
        defect: next(3) === 0,
        state: states[next(states.length)]!,
      })),
    );
  }
  // 999/1000 must cap at 99 in SQL as well, not round to 100.
  result.push([
    { weight: 999, scoreCap: null, defect: false, state: "satisfied" },
    { weight: 1, scoreCap: null, defect: false, state: "gap" },
  ]);
  return result;
};

/**
 * The list sort, the `dataStatus` filter and `entity.records` read the SQL
 * score and status; hydration and the explanation read the TS core. They must
 * agree on every combination of weight, cap, kind and state.
 */
describe("quality score: TS and SQL agree", () => {
  const ctx = withTestDb();

  it("computes the same score and status for every term set", async () => {
    const all = cases();
    const rows = sql.join(
      all.map((terms, index) => {
        const sqlTerms = terms.map((term) => ({
          ...term,
          state: sql.raw(String(qualityStateCode[term.state])),
        }));
        return sql`SELECT ${index} AS "index", ${scoreFromStates(sqlTerms)}::float8 AS "score", ${statusFromStates(sqlTerms)} AS "status"`;
      }),
      sql` UNION ALL `,
    );
    const result = z
      .array(
        z.object({
          index: z.coerce.number(),
          score: z.number().nullable(),
          status: z.string(),
        }),
      )
      .parse((await unwrapDb(ctx.db).execute(rows)).rows);
    expect(result).toHaveLength(all.length);
    for (const row of result) {
      const expected = scoreQualityTerms(all[row.index]!);
      expect({
        index: row.index,
        score: row.score,
        status: row.status,
      }).toEqual({
        index: row.index,
        score: expected.score,
        status: expected.status,
      });
    }
  });
});
