import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  run,
  runProgress,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadSyncPlan, startAccountSync } from "./account-sync";
import { startOrResumeRun } from "./run-service";
import { readAccountSyncAdmission } from "./sync-admission";

// Failure modes: a missing cursor is mistaken for incremental work; another purpose or a failed
// charge dispatch is resumed; plan leaks another member's account; targeted sync starts more than
// one account; a repeat creates a second run; backfill loses its explicit date range;
// a disabled account or deleted Vendor starts work and silently reactivates the account.
describe("account sync planning and start", () => {
  const ctx = withTestDb();
  const fixture = async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Sync test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Sync vendor ${crypto.randomUUID()}`,
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Sync test account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      browserSyncEnabled: true,
    });
    const events: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    return { party, vendor, account, queue, events };
  };

  // A live socket must not erase persisted sign-in/offline authorization, and a
  // later failed attempt must not replace the last successful sync timestamp.
  it("projects persisted account authorization separately from sync admission", async () => {
    const { party, account } = await fixture();
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ status: "paused_auth" })
      .where(eq(vendorAccount.id, account.id));
    const before = await loadSyncPlan(ctx.db, party.id, {});
    expect(before.accounts[0]).toMatchObject({
      accountStatus: "paused_auth",
      lastSuccessAt: null,
      action: { kind: "firstSync" },
    });
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ status: "paused_offline" })
      .where(eq(vendorAccount.id, account.id));
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts[0],
    ).toMatchObject({
      accountStatus: "paused_offline",
      lastSuccessAt: null,
    });
  });

  it("keeps the last completed account run when a later attempt fails", async () => {
    const { party, account, queue } = await fixture();
    const completed = await startAccountSync(
      ctx.db,
      party.id,
      { vendorAccountId: account.shortcode },
      queue,
    );
    const endedAt = new Date("2026-09-01T12:00:00Z");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt })
      .where(eq(run.shortcode, completed.runId));
    const failed = await startAccountSync(
      ctx.db,
      party.id,
      { vendorAccountId: account.shortcode },
      queue,
    );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", endedAt: new Date("2026-09-02T12:00:00Z") })
      .where(eq(run.shortcode, failed.runId));
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts[0],
    ).toMatchObject({
      lastSuccessAt: endedAt.toISOString(),
      accountStatus: "active",
    });
  });

  it("reads broker connectivity only for the selected member-owned account", async () => {
    const { party, account } = await fixture();
    const reads: string[] = [];
    const result = await loadSyncPlan(
      ctx.db,
      party.id,
      { vendorAccountId: account.shortcode },
      {
        connected: async (id) => {
          reads.push(id);
          return false;
        },
      },
    );
    expect(reads).toEqual([account.id]);
    expect(result.accounts[0]).toMatchObject({
      connected: false,
      accountStatus: "active",
    });
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts[0],
    ).toMatchObject({ connected: null });
  });

  it("plans first and incremental syncs, then resumes the same admitted run with its progress", async () => {
    const { party, account, queue, events } = await fixture();
    expect(
      await readAccountSyncAdmission(getDb(ctx.db), account.id),
    ).toBeNull();
    expect(
      (
        await loadSyncPlan(ctx.db, party.id, {
          vendorAccountId: account.shortcode,
        })
      ).accounts[0]?.action,
    ).toEqual({ kind: "firstSync" });
    const since = "2026-09-01T12:00:00.000Z";
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({
        cursor: {
          newestOrderAt: since,
          earliestAvailableOrderAt: null,
          orderIdsOnNewestDate: [],
          backfillBeforeOrderAt: null,
        },
      })
      .where(eq(vendorAccount.id, account.id));
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts[0]?.action,
    ).toEqual({ kind: "start", since });
    const first = await startAccountSync(
      ctx.db,
      party.id,
      { vendorAccountId: account.shortcode },
      queue,
    );
    const second = await startAccountSync(
      ctx.db,
      party.id,
      { vendorAccountId: account.shortcode },
      queue,
    );
    expect(second).toEqual({ runId: first.runId, resumed: true });
    expect(events.map((event) => event.type)).toEqual([
      "start_or_resume",
      "retry",
    ]);
    const holding = await readAccountSyncAdmission(getDb(ctx.db), account.id);
    expect(holding?.kind).toBe("resume");
    if (!holding) throw new Error("Expected admitted run");
    await getDb(ctx.db).insert(runProgress).values({
      runId: holding.run.id,
      eventId: crypto.randomUUID(),
      phase: "browser",
      detail: "Reading order history",
    });
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts[0]?.action,
    ).toMatchObject({
      kind: "resume",
      runId: first.runId,
      status: "running",
      detail: "Reading order history",
    });
  });

  it("blocks other purposes and failed charge dispatches and refuses to start them as syncs", async () => {
    const { party, account, queue, events } = await fixture();
    const admitted = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const held = { id: admitted.id, shortcode: admitted.publicId };
    await getDb(ctx.db)
      .update(run)
      .set({ purpose: "product_enrichment" })
      .where(eq(run.id, held.id));
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts[0]?.action,
    ).toMatchObject({
      kind: "blocked",
      runId: held.shortcode,
      purpose: "product_enrichment",
    });
    await expect(
      startAccountSync(
        ctx.db,
        party.id,
        { vendorAccountId: account.shortcode },
        queue,
      ),
    ).rejects.toThrow(held.shortcode);
    await getDb(ctx.db)
      .update(run)
      .set({
        purpose: "account_sync",
        status: "dispatch_failed",
        input: { kind: "charge_hunts", huntIds: [crypto.randomUUID()] },
      })
      .where(eq(run.id, held.id));
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts[0]?.action,
    ).toMatchObject({ kind: "blocked", runId: held.shortcode });
    await expect(
      startAccountSync(
        ctx.db,
        party.id,
        { vendorAccountId: account.shortcode },
        queue,
      ),
    ).rejects.toThrow(held.shortcode);
    expect(events).toEqual([]);
  });

  it.each(["paused_auth", "paused_offline"] as const)(
    "native Sync resumes the original %s Run through its current dispatch generation without recapturing work",
    async (status) => {
      const { party, account, queue, events } = await fixture();
      const admitted = await startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "manual",
      });
      const client = getDb(ctx.db);
      const beforeTargets = await client
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, admitted.id));
      expect(beforeTargets).toHaveLength(1);
      const [beforeRun] = await client
        .select()
        .from(run)
        .where(eq(run.id, admitted.id));
      await client
        .update(run)
        .set({ status, failureCode: "browser_transport_interrupted" })
        .where(eq(run.id, admitted.id));
      await client
        .update(vendorAccount)
        .set({ status })
        .where(eq(vendorAccount.id, account.id));

      expect(
        await startAccountSync(
          ctx.db,
          party.id,
          { vendorAccountId: account.shortcode },
          queue,
        ),
      ).toEqual({ runId: admitted.publicId, resumed: true });
      const [afterRun] = await client
        .select()
        .from(run)
        .where(eq(run.id, admitted.id));
      expect(afterRun).toMatchObject({
        status: "running",
        failureCode: null,
        input: beforeRun?.input,
      });
      expect(afterRun?.dispatchEventId).not.toBe(beforeRun?.dispatchEventId);
      expect(events).toEqual([
        {
          version: 1,
          runId: admitted.id,
          eventId: afterRun?.dispatchEventId,
          type: "start_or_resume",
        },
      ]);
      expect(
        await client
          .select()
          .from(runTarget)
          .where(eq(runTarget.runId, admitted.id)),
      ).toEqual(beforeTargets);
      expect(await client.select().from(run)).toHaveLength(1);
    },
  );

  it("refuses disabled accounts and deleted Vendors without creating runs or resetting status", async () => {
    const { party, vendor: shop, account, queue, events } = await fixture();
    const client = getDb(ctx.db);
    await client
      .update(vendorAccount)
      .set({ status: "disabled" })
      .where(eq(vendorAccount.id, account.id));
    expect((await loadSyncPlan(ctx.db, party.id, {})).accounts).toEqual([]);
    await expect(
      startAccountSync(
        ctx.db,
        party.id,
        { vendorAccountId: account.shortcode },
        queue,
      ),
    ).rejects.toThrow("Browser sync requires");
    expect(
      await client
        .select()
        .from(run)
        .where(eq(run.vendorAccountId, account.id)),
    ).toEqual([]);
    expect(
      await client
        .select({ status: vendorAccount.status })
        .from(vendorAccount)
        .where(eq(vendorAccount.id, account.id)),
    ).toEqual([{ status: "disabled" }]);
    await client
      .update(vendorAccount)
      .set({ status: "active" })
      .where(eq(vendorAccount.id, account.id));
    await client
      .update(vendor)
      .set({ deletedAt: new Date() })
      .where(eq(vendor.id, shop.id));
    expect((await loadSyncPlan(ctx.db, party.id, {})).accounts).toEqual([]);
    await expect(
      startAccountSync(
        ctx.db,
        party.id,
        { vendorAccountId: account.shortcode },
        queue,
      ),
    ).rejects.toThrow("Browser sync requires");
    expect(
      await client
        .select()
        .from(run)
        .where(
          and(eq(run.vendorAccountId, account.id), eq(run.status, "running")),
        ),
    ).toEqual([]);
    expect(events).toEqual([]);
  });

  it("filters disabled and foreign accounts, starts only the selected account, and preserves backfill", async () => {
    const { party, account, queue, events } = await fixture();
    const otherVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Disabled sync vendor",
    });
    const other = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Disabled account",
      vendorId: otherVendor.id,
      ledgerPartyId: party.id,
      browserSyncEnabled: false,
    });
    expect(
      (await loadSyncPlan(ctx.db, party.id, {})).accounts.map(
        (item) => item.shortcode,
      ),
    ).toEqual([account.shortcode]);
    await expect(
      startAccountSync(
        ctx.db,
        party.id,
        { vendorAccountId: other.shortcode },
        queue,
      ),
    ).rejects.toThrow("not enabled");
    const stranger = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other member",
      kind: "member",
    });
    expect((await loadSyncPlan(ctx.db, stranger.id, {})).accounts).toEqual([]);
    await expect(
      startAccountSync(
        ctx.db,
        stranger.id,
        { vendorAccountId: account.shortcode },
        queue,
      ),
    ).rejects.toThrow("not owned");
    const backfill = { from: "2025-01-01", to: "2025-12-31" };
    const started = await startAccountSync(
      ctx.db,
      party.id,
      { vendorAccountId: account.shortcode, backfill },
      queue,
    );
    const [stored] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, started.runId));
    expect(stored?.input).toMatchObject({
      kind: "research_objectives",
      objectives: [
        {
          kind: "account_history",
          vendorAccountId: account.id,
          range: backfill,
        },
      ],
    });
    expect(events).toHaveLength(1);
  });
});
