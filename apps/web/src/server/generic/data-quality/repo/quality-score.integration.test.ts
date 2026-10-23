import {
  type QualityTerm,
  scoreQualityTerms,
} from "@cubby/schemas/data-quality";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unwrapDb } from "~/server/db/helpers";

import { qualityStateCode, statusFromStates } from "./sql";

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
  return result;
};

/**
 * Stored scores come from the TS core. The `dataStatus` filter and
 * `entity.records` derive status in SQL from published check states, so it
 * must agree with the TS core on every combination of weight, cap, kind and
 * state.
 */
describe("quality status: TS and SQL agree", () => {
  const ctx = withTestDb();

  it("computes the same status for every term set", async () => {
    const all = cases();
    const rows = sql.join(
      all.map((terms, index) => {
        const sqlTerms = terms.map((term) => ({
          ...term,
          state: sql.raw(String(qualityStateCode[term.state])),
        }));
        return sql`SELECT ${index} AS "index", ${statusFromStates(sqlTerms)} AS "status"`;
      }),
      sql` UNION ALL `,
    );
    const result = z
      .array(
        z.object({
          index: z.coerce.number(),
          status: z.string(),
        }),
      )
      .parse((await unwrapDb(ctx.db).execute(rows)).rows);
    expect(result).toHaveLength(all.length);
    for (const row of result) {
      expect({ index: row.index, status: row.status }).toEqual({
        index: row.index,
        status: scoreQualityTerms(all[row.index]!).status,
      });
    }
  });
});
