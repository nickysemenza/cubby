import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  run as runTable,
  runEvidence,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { researchWorklistFixture } from "./research-worklist.fixtures";
import { startOrResumeRun } from "./run-service";
const HOST = "shop.example.test";
describe("account-sync research worklist", () => {
  const ctx = withTestDb();
  async function seedAccount(
    cursor?: Partial<ReturnType<typeof vendorAccountCursor.parse>>,
    sharedParty?: { id: LedgerPartyId },
  ) {
    const party =
      sharedParty ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Worklist member",
        kind: "member",
        userId: ctx.actor.userId,
      }));
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Worklist vendor ${crypto.randomUUID()}`,
      website: `https://${HOST}/orders`,
      browserDomains: [HOST],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Worklist account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      cursor: vendorAccountCursor.parse({
        newestOrderAt: null,
        orderIdsOnNewestDate: [],
        backfillBeforeOrderAt: null,
        earliestAvailableOrderAt: null,
        ...cursor,
      }),
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    return { party, vendor, account, run };
  }

  it("retains the detail URL and short order label from an account table without treating the listing as a Purchase", async () => {
    const { run } = await seedAccount();
    const research = researchWorklistFixture(ctx.db, run.id);
    const work = await research.assigned();
    const detailUrl = `https://${HOST}/account/orders/opaque-token`;
    const retained = await research.retain(
      work.workRef,
      `<main><table><tr><td><a href="${detailUrl}">#54321</a></td><td>September 12, 2026</td><td>$12.00</td></tr></table></main>`,
      "synthetic-short-order-list",
    );
    expect(retained.observation.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: detailUrl, label: "#54321" }),
      ]),
    );
    expect(retained.observation.readableText).toContain("54321");
    const evidence = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.targetId, work.workRef));
    expect(evidence).toMatchObject([
      {
        id: retained.evidenceId,
        runId: run.id,
        targetId: work.workRef,
        kind: "web_page",
      },
    ]);
    expect(await research.next()).toMatchObject({
      status: "working",
      work: { workRef: work.workRef },
    });
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it("keeps partial history pending and replay-safe instead of completing from a listing or advancing the cursor", async () => {
    const { run, account, party } = await seedAccount({
      newestOrderAt: "2026-09-15T00:00:00.000Z",
      orderIdsOnNewestDate: ["synthetic-covered-order"],
    });
    const research = researchWorklistFixture(ctx.db, run.id);
    const work = await research.assigned();
    const html =
      '<main><a href="/orders/synthetic-new">SYNTHETIC-NEW September 18, 2026</a><a href="/orders?page=2">Next page</a></main>';
    const first = await research.retain(
      work.workRef,
      html,
      "synthetic-partial-list",
    );
    expect(
      await research.retain(work.workRef, html, "synthetic-partial-list"),
    ).toEqual(first);
    expect(await research.next()).toMatchObject({
      status: "working",
      work: { workRef: work.workRef },
    });
    const [scope] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(scope?.status).toBe("running");
    const [stored] = await getDb(ctx.db)
      .select()
      .from(vendorAccount)
      .where(eq(vendorAccount.id, account.id));
    expect(vendorAccountCursor.parse(stored?.cursor).newestOrderAt).toBe(
      "2026-09-15T00:00:00.000Z",
    );
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.targetId, work.workRef)),
    ).toHaveLength(1);
    const other = await seedAccount(undefined, party);
    const foreign = await researchWorklistFixture(
      ctx.db,
      other.run.id,
    ).assigned();
    await expect(
      research.resolve(foreign.workRef, { status: "researched_with_gaps" }),
    ).rejects.toThrow(/work|target/i);
    expect(await research.next()).toMatchObject({
      status: "working",
      work: { workRef: work.workRef },
    });
  });
  it("does not treat one page older than the cursor as exhaustion of the frozen history scope", async () => {
    const { run } = await seedAccount({
      newestOrderAt: "2026-09-15T00:00:00.000Z",
    });
    const research = researchWorklistFixture(ctx.db, run.id);
    const work = await research.assigned();
    const retained = await research.retain(
      work.workRef,
      "<main>SYNTHETIC-OLD August 1, 2026. More historical pages are unavailable.</main>",
    );
    await research.resolve(work.workRef, {
      status: "verified",
      evidenceIds: [retained.evidenceId],
      gaps: ["Only one history page was available."],
      scopeExhausted: false,
    });
    expect(await research.next()).toMatchObject({
      status: "working",
      work: { workRef: work.workRef },
    });
    await research.resolve(work.workRef, {
      status: "researched_with_gaps",
      evidenceIds: [retained.evidenceId],
      gaps: ["Only one history page was available."],
      scopeExhausted: false,
    });
    expect(await research.next()).toMatchObject({
      status: "done",
      summary: { unresolved: 1 },
    });
    const [scope] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(scope?.status).toBe("needs_review");
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
});
