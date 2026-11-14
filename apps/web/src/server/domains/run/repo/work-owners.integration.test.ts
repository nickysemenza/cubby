import { runEntityId } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { generateShortcode } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { user } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { run, runFinding } from "~/server/db/schema";
import { publishRunFinding } from "~/server/domains/run/repo/run-finding";
import { readRecordWorkQueue } from "~/server/domains/work/service/work-queue-read";
import { insertEntityFixtures } from "~/server/testing/repo.fixtures";

import { workRunReviewOwners, workRunReviewRead } from "./work-owners";

// Failure mode: each historical Run's review authority rereads that same Run
// through source-owner arrays, multiplying database work before queue paging.
describe("Run review authority query work", () => {
  const ctx = withTestDb();

  // Failure modes: joining authority can duplicate candidates, admit a deleted
  // account, or turn an unresolved private owner into shared work.
  it("preserves review authority and retired source findings across retained Run states", async () => {
    const otherUserId = testUserId("synthetic-authority-other-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Synthetic other authority member",
      email: "synthetic-other-authority@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic authority member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic authority guest",
      kind: "guest",
    });
    const deletedMember = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic deleted authority member",
      kind: "member",
      userId: otherUserId,
      deletedAt: new Date(),
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic authority vendor",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: member.id,
    });
    const deletedAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: member.id,
      deletedAt: new Date(),
    });
    const otherAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: other.id,
    });
    const first = await insertWithShortcode(ctx.db, "run", {
      purpose: "account_sync",
      trigger: "manual",
      status: "paused_auth",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic authority member",
      actorEmail: "synthetic-authority@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: member.kind,
    });
    const variants = [
      { vendorAccountId: account.id },
      { vendorAccountId: deletedAccount.id },
      { vendorAccountId: otherAccount.id },
      { actorUserId: otherUserId },
      { ledgerPartyId: other.id },
      { ledgerPartyId: deletedMember.id, actorUserId: otherUserId },
      { deletedAt: new Date() },
    ];
    const retained = await insertEntityFixtures(
      ctx.db,
      run,
      "run",
      variants.map((variant) => ({
        ...first,
        id: runEntityId.parse(crypto.randomUUID()),
        shortcode: generateShortcode("run"),
        ...variant,
      })),
    );
    const ids = [first.id, ...retained.map((row) => row.id)];
    const expected = [
      [member.id],
      [member.id],
      [null],
      [null],
      [null],
      [null],
      [null],
      [],
    ];
    for (const [index, id] of ids.entries()) {
      const result = await getDb(ctx.db).execute(
        sql`SELECT ${workRunReviewOwners(sql`${id}::uuid`)} AS owners`,
        "objects",
      );
      expect(result[0]?.owners).toEqual(expected[index]);
    }
    const missing = await getDb(ctx.db).execute(
      sql`SELECT ${workRunReviewOwners(sql`${crypto.randomUUID()}::uuid`)} AS owners`,
      "objects",
    );
    expect(missing[0]?.owners).toEqual([]);
    const read = workRunReviewRead();
    const joined = await getDb(ctx.db).execute(
      sql`SELECT "Run".id, ${read.owners} AS owners
      FROM ${read.table} WHERE "Run".id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND "Run"."deletedAt" IS NULL`,
      "objects",
    );
    expect(joined).toHaveLength(ids.length - 1);
    for (const [index, id] of ids.slice(0, -1).entries()) {
      expect(joined.find((row) => row.id === id)?.owners).toEqual(
        expected[index],
      );
    }
    const memberQueue = await readRecordWorkQueue(ctx.db, {
      id: first.shortcode,
      memberPartyId: member.id,
      memberOnly: true,
    });
    expect(
      memberQueue.items.filter((row) => row.family === "account"),
    ).toMatchObject([
      {
        id: first.shortcode,
        owners: [{ id: member.shortcode }],
      },
    ]);
    const unresolved = retained[1];
    expect(unresolved).toBeDefined();
    if (!unresolved) throw new Error("Missing synthetic deleted-account Run");
    const fenced = await readRecordWorkQueue(ctx.db, {
      id: unresolved.shortcode,
      memberPartyId: member.id,
      memberOnly: true,
    });
    expect(fenced.items.filter((row) => row.family === "account")).toEqual([]);

    const sourceRun = retained[0]!;
    const finding = await publishRunFinding(ctx.db, {
      runId: sourceRun.id,
      ledgerPartyId: member.id,
      entityKind: "run",
      entityId: sourceRun.id,
      kind: "other",
      summary: "Synthetic source evidence still needs review",
      evidenceFingerprint: "synthetic-retained-source-finding",
      proposedFix: null,
    });
    const before = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.id, finding.id));
    const retiredAt = new Date();
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", retiredAt })
      .where(sql`${run.id} IN (${first.id}::uuid, ${sourceRun.id}::uuid)`);
    const history = await readRecordWorkQueue(ctx.db, {
      id: first.shortcode,
      memberPartyId: member.id,
      memberOnly: true,
    });
    expect(history.items.filter((row) => row.family === "account")).toEqual([]);
    await getDb(ctx.db)
      .update(run)
      .set({ failureCode: "execution_limit" })
      .where(eq(run.id, first.id));
    const retiredFundingWait = await readRecordWorkQueue(ctx.db, {
      id: first.shortcode,
      memberPartyId: member.id,
      memberOnly: true,
    });
    expect(
      retiredFundingWait.items.filter((row) => row.family === "execution"),
    ).toEqual([]);
    const sourceReview = await readRecordWorkQueue(ctx.db, {
      id: sourceRun.shortcode,
      memberPartyId: member.id,
      memberOnly: true,
    });
    expect(
      sourceReview.items.filter((row) => row.family === "finding"),
    ).toMatchObject([
      { key: `finding:${finding.id}`, id: sourceRun.shortcode },
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.id, finding.id)),
    ).toEqual(before);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, first.id)))[0],
    ).toMatchObject({ status: "needs_review", retiredAt });
  });

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
    await insertEntityFixtures(
      ctx.db,
      run,
      "run",
      Array.from({ length: additionalRuns }, () => ({
        ...first,
        id: runEntityId.parse(crypto.randomUUID()),
        shortcode: generateShortcode("run"),
      })),
    );
    const statement = sql`SELECT ${workRunReviewOwners(sql`candidate.id`)} AS owners
      FROM "Run" candidate WHERE candidate."ledgerPartyId" = ${member.id}`;
    const rows = await getDb(ctx.db).execute(statement, "objects");
    expect(rows).toHaveLength(additionalRuns + 1);
    for (const row of rows) expect(row.owners).toEqual([member.id]);
    const result = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
      "objects",
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
      .parse(result);
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
