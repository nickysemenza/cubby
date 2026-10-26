import { eq, inArray } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  email,
  job,
  orderMailEvent,
  run,
} from "~/server/db/schema";
import { readEntityConnections } from "~/server/domains/connection/repo/entity-connections";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";
import { scheduleConnectionRefresh } from "~/server/domains/run/repo/connection-refresh";
import { readRunEvaluationsByCode } from "~/server/generic/run-detail/repo/run-evaluations";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { reconcileDerivedRefreshInputs } from "~/server/testing/background-queue";
import { aiEvaluationJobHandler } from "~/server/workflows/runs/job-execution";

// Failure modes: each connection evaluation pays its own claim, guard and
// settlement (a sweep of ~55k sources took days); a page publishes a source
// that changed after its evaluation was queued; a candidate is lost on the
// page path.
describe("connection evaluation pages", () => {
  const ctx = withTestDb();

  async function setup() {
    await activateAiRefresh(ctx.db, "synthetic-connection-page", {
      enabled: true,
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic page member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic page merchant",
    });
    return { party, vendor };
  }

  async function emails(
    { party, vendor }: Awaited<ReturnType<typeof setup>>,
    count: number,
    prefix: string,
  ) {
    const created = [];
    for (let index = 0; index < count; index++) {
      const mail = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-page-mailbox",
        messageId: `${prefix}-${index}`,
        vendorId: vendor.id,
        sender: "orders@example.test",
        subject: `Synthetic page receipt ${prefix} ${index}`,
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: `${prefix}${index}`.padEnd(64, "0").slice(0, 64),
        content: {
          bodyText: "Synthetic receipt",
          bodyHtml: null,
          snippet: null,
        },
      });
      const [message] = await getDb(ctx.db)
        .select()
        .from(email)
        .where(eq(email.orderMailId, mail.id));
      if (!message) throw new Error("Synthetic retained Email missing");
      created.push({ mail, message });
    }
    return created;
  }

  async function schedule(messages: readonly { shortcode: string }[]) {
    await reconcileDerivedRefreshInputs(ctx.db);
    const ids: string[] = [];
    for (const message of messages) {
      const { runId } = await scheduleConnectionRefresh(ctx.db, {
        entityKind: "email",
        entityId: message.shortcode,
      });
      if (!runId) throw new Error("Synthetic connection was not scheduled");
    }
    const rows = await getDb(ctx.db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "entity-connections"));
    ids.push(...rows.map((row) => row.id));
    return ids;
  }

  async function runPage(evaluationIds: readonly string[]) {
    const [anchor] = await getDb(ctx.db)
      .select({ id: job.id })
      .from(job)
      .where(
        inArray(
          job.key,
          evaluationIds.map((id) => `ai-evaluation:${id}`),
        ),
      )
      .limit(1);
    if (!anchor) throw new Error("Synthetic page anchor missing");
    return countTestDbQueries(() =>
      aiEvaluationJobHandler.advancePage(ctx.db, anchor.id),
    );
  }

  const states = async (ids: readonly string[]) =>
    (
      await getDb(ctx.db)
        .select({ state: aiEvaluation.state })
        .from(aiEvaluation)
        .where(inArray(aiEvaluation.id, [...ids]))
    ).map((row) => row.state);

  it("settles a page of sources with a bounded per-source statement cost", async () => {
    const base = await setup();
    const single = await schedule(
      (await emails(base, 1, "single")).map((entry) => entry.message),
    );
    const one = await runPage(single);
    expect(one.result).toBe("succeeded");
    expect(await states(single)).toEqual(["completed"]);

    const created = await emails(base, 20, "page");
    const all = await schedule(created.map((entry) => entry.message));
    const page = all.filter((id) => !single.includes(id));
    expect(page).toHaveLength(20);
    const twenty = await runPage(page);
    expect(twenty.result).toBe("succeeded");
    expect(new Set(await states(page))).toEqual(new Set(["completed"]));
    // A single-Job evaluation of a source without candidates cost about 30
    // statements; on a page each added source costs its own retrieval only
    // (2 statements for an Email when measured).
    const perSource = (twenty.queryCount - one.queryCount) / 19;
    expect(perSource).toBeLessThanOrEqual(3);
  });

  it("publishes a source's candidates and retires a deleted source without writes", async () => {
    const base = await setup();
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: base.vendor.id,
      orderId: "SYNTHETIC-PAGE-ORDER",
      date: "2026-10-01",
      statedTotal: 24,
    });
    const [withEvidence, deleted] = await emails(base, 2, "evidence");
    if (!withEvidence || !deleted) throw new Error("Synthetic Emails missing");
    await getDb(ctx.db).insert(orderMailEvent).values({
      orderMailId: withEvidence.mail.id,
      event: "placed",
      orderId: purchase.orderId,
      sourceKey: "synthetic-page-event",
    });
    const ids = await schedule([withEvidence.message, deleted.message]);
    await getDb(ctx.db)
      .update(email)
      .set({ deletedAt: new Date() })
      .where(eq(email.id, deleted.message.id));

    expect((await runPage(ids)).result).toBe("succeeded");

    const rows = await getDb(ctx.db)
      .select({ state: aiEvaluation.state, target: aiEvaluation.target })
      .from(aiEvaluation)
      .where(inArray(aiEvaluation.id, ids));
    const stateOf = (recordId: string) =>
      rows.find(
        (row) =>
          typeof row.target === "object" &&
          row.target !== null &&
          "recordId" in row.target &&
          row.target.recordId === recordId,
      )?.state;
    expect(stateOf(withEvidence.message.id)).toBe("completed");
    expect(stateOf(deleted.message.id)).toBe("obsolete");
    const proposals = await readEntityConnections(ctx.db, {
      entityKind: "purchase",
      entityId: purchase.shortcode,
    });
    expect(proposals.map((proposal) => proposal.source)).toEqual([
      { entityKind: "email", entityId: withEvidence.message.shortcode },
    ]);
    const [evaluationRun] = await getDb(ctx.db)
      .select({ code: run.shortcode })
      .from(run)
      .innerJoin(aiEvaluation, eq(aiEvaluation.runId, run.id))
      .where(inArray(aiEvaluation.id, ids))
      .limit(1);
    if (!evaluationRun?.code) throw new Error("Synthetic Run missing");
    const summary = await readRunEvaluationsByCode(
      ctx.db,
      evaluationRun.code,
      false,
    );
    expect(
      summary.recent.map((outcome) => [
        outcome.recordCode,
        outcome.state,
        outcome.candidates,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [withEvidence.message.shortcode, "completed", 1],
        [deleted.message.shortcode, "obsolete", null],
      ]),
    );
    expect(summary.byKind).toEqual([
      expect.objectContaining({ entity: "email", completed: 1, obsolete: 1 }),
    ]);
  });
});
