import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run } from "~/server/db/schema";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { getVendorAccountByShortcode } from "~/server/repo/vendor-account";

/**
 * `VendorAccount.lastRunAt` / `lastSuccessAt` are read from Run — the latest
 * start and the latest end of a completed run — so an account can never
 * disagree with the run history it summarizes.
 */
describe("vendor account run activity", () => {
  const ctx = withTestDb();

  it("reads lastRunAt and lastSuccessAt from the account's runs", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Activity member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Activity vendor",
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Activity account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });

    const before = await getVendorAccountByShortcode(ctx.db, account.shortcode);
    expect(before?.lastRunAt).toBeNull();
    expect(before?.lastSuccessAt).toBeNull();

    const started = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const [row] = await getDb(ctx.db)
      .select({ startedAt: run.startedAt })
      .from(run)
      .where(eq(run.id, started.id));
    const running = await getVendorAccountByShortcode(
      ctx.db,
      account.shortcode,
    );
    expect(running?.lastRunAt).toEqual(row?.startedAt);
    expect(running?.lastSuccessAt).toBeNull();

    const endedAt = new Date("2026-06-01T12:00:00.000Z");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt })
      .where(eq(run.id, started.id));
    const done = await getVendorAccountByShortcode(ctx.db, account.shortcode);
    expect(done?.lastSuccessAt).toEqual(endedAt);
  });
});
