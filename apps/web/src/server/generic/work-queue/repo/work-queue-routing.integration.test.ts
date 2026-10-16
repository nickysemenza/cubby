import { runEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { workRunReviewOwners } from "./work-queue-routing";

// Failure mode: each historical Run's review authority rereads that same Run
// through source-owner arrays, multiplying database work before queue paging.
describe("Run review authority query work", () => {
  const ctx = withTestDb();

  it("reads each retained Run at most once while resolving review authority", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic review member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const first = await insertWithShortcode(ctx.db, "run", {
      purpose: "account_sync",
      trigger: "manual",
      status: "paused_auth",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic review member",
      actorEmail: "synthetic-review@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: member.kind,
    });
    const additionalRuns = 128;
    await getDb(ctx.db)
      .insert(run)
      .values(
        Array.from({ length: additionalRuns }, () => ({
          ...first,
          id: runEntityId.parse(crypto.randomUUID()),
          shortcode: generateShortcode("run"),
        })),
      );
    const statement = sql`SELECT ${workRunReviewOwners(sql`candidate.id`)} AS owners
      FROM "Run" candidate WHERE candidate."ledgerPartyId" = ${member.id}`;
    const rows = await getDb(ctx.db).execute(statement);
    expect(rows.rows).toHaveLength(additionalRuns + 1);
    for (const row of rows.rows) expect(row.owners).toEqual([member.id]);
    const result = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
    );
    const nodeSchema = z.object({
      "Relation Name": z.string().optional(),
      "Actual Loops": z.number().default(0),
      Plans: z.array(z.unknown()).optional(),
    });
    const plans = z
      .array(
        z.object({
          "QUERY PLAN": z.array(z.object({ Plan: z.unknown() })),
        }),
      )
      .parse(result.rows);
    let runReads = 0;
    const visit = (value: unknown) => {
      const node = nodeSchema.parse(value);
      if (node["Relation Name"] === "Run") runReads += node["Actual Loops"];
      node.Plans?.forEach(visit);
    };
    plans.forEach((row) =>
      row["QUERY PLAN"].forEach(({ Plan }) => visit(Plan)),
    );
    // One outer scan plus at most one indexed review lookup per candidate.
    expect(runReads).toBeLessThanOrEqual(additionalRuns + 3);
  });
});
