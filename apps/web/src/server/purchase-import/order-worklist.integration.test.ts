import type { BrowserBridgeResult } from "@cubby/schemas/purchase-import";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  run as runTable,
  runOrderCandidate,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { capturedHtml } from "./browser.fixtures";
import {
  fakeBroker,
  historyPage,
  HOST,
  orderUrl,
} from "./order-history.fixtures";
import {
  claimNextImportWork,
  finishRun,
  importBrowserOrderEvidence,
  issueBrowserCommand,
  startOrResumeRun,
} from "./run-service";

describe("account-sync order worklist", () => {
  // Account tables can use short display numbers and literal row navigation;
  // treating the listing as a purchase loses the detail page and its items.
  const ctx = withTestDb();

  async function seedAccount(
    cursor?: Partial<ReturnType<typeof vendorAccountCursor.parse>>,
  ) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Worklist member",
      kind: "member",
      userId: ctx.actor.userId,
    });
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

  async function listPage(
    runId: string,
    operationId: string,
    outcome: Promise<BrowserBridgeResult["outcome"]>,
  ) {
    const bridge = fakeBroker();
    const issued = await issueBrowserCommand(ctx.db, bridge.namespace, {
      runId,
      operationId,
      operation: {
        type: "capture",
        allowedHosts: [HOST],
        screenshot: "preferred",
      },
    });
    bridge.respondWith(await outcome);
    return importBrowserOrderEvidence(
      ctx.db,
      bridge.namespace,
      {
        runId,
        operationId: `${operationId}:import`,
        commandId: issued.commandId,
      },
      bridge.ports,
    );
  }

  it("claims the detail URL from a captured account table with short order numbers", async () => {
    const { run } = await seedAccount();
    const detailUrl = `https://${HOST}/account/orders/opaque-token`;
    const listed = await listPage(
      run.id,
      "walk:account",
      capturedHtml({
        sourceURL: `https://${HOST}/account`,
        title: "Account",
        html: `<html><body><h1>Your account</h1><p>View all your orders</p>
        <table><thead><tr><th>Order</th><th>Date</th><th>Total</th></tr></thead>
        <tbody><tr onclick="window.location.href = '${detailUrl}'">
        <td><span>#54321</span></td><td>September 12, 2026</td><td>$12.00</td>
        </tr></tbody></table></body></html>`,
      }),
    );
    expect(listed).toMatchObject({
      kind: "order_list",
      ordersSeen: 1,
      pending: 1,
    });
    await expect(
      claimNextImportWork(ctx.db, fakeBroker().namespace, run.id),
    ).resolves.toMatchObject({
      kind: "order",
      orderId: "54321",
      orderUrl: detailUrl,
      orderedAt: "2026-09-12",
    });
  });

  it("records a history page as a worklist, skips covered orders, and refuses to finish while one is pending", async () => {
    const { vendor, account, run } = await seedAccount();
    // One order already has a Purchase: it must be listed but not re-imported.
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      date: "2026-09-10",
      orderId: "111-2222222-3333333",
      displayLabel: "Already imported",
    });

    const listed = await listPage(
      run.id,
      "walk:1",
      historyPage(
        [
          { id: "111-2222222-3333333", date: "September 10, 2026" },
          { id: "111-4444444-5555555", date: "September 18, 2026" },
          { id: "111-6666666-7777777", date: "September 12, 2026" },
        ],
        `https://${HOST}/order-history?startIndex=10`,
      ),
    );

    expect(listed).toMatchObject({
      kind: "order_list",
      ordersSeen: 3,
      pending: 2,
      nextPageUrl: `https://${HOST}/order-history?startIndex=10`,
    });
    const [seen] = await getDb(ctx.db)
      .select({ ordersSeen: runTable.ordersSeen })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(seen?.ordersSeen).toBe(3);

    // Newest pending order first.
    const bridge = fakeBroker();
    await expect(
      claimNextImportWork(ctx.db, bridge.namespace, run.id),
    ).resolves.toMatchObject({
      kind: "order",
      orderId: "111-4444444-5555555",
      orderUrl: orderUrl("111-4444444-5555555"),
      orderedAt: "2026-09-18",
    });
    await expect(
      finishRun(ctx.db, bridge.namespace, {
        runId: run.id,
        operationId: "finish:early",
      }),
    ).rejects.toThrow("listed order(s)");

    // Once every listed order is handled the walk resumes from the next page,
    // and finishing advances the account cursor to the newest handled order.
    await getDb(ctx.db)
      .update(runOrderCandidate)
      .set({ state: "imported" })
      .where(eq(runOrderCandidate.runId, run.id));
    await expect(
      claimNextImportWork(ctx.db, bridge.namespace, run.id),
    ).resolves.toEqual({
      kind: "cursor_walk",
      startUrl: `https://${HOST}/order-history?startIndex=10`,
    });
    await finishRun(ctx.db, bridge.namespace, {
      runId: run.id,
      operationId: "finish:done",
    });
    const [updated] = await getDb(ctx.db)
      .select({ cursor: vendorAccount.cursor })
      .from(vendorAccount)
      .where(eq(vendorAccount.id, account.id));
    expect(vendorAccountCursor.parse(updated?.cursor)).toMatchObject({
      newestOrderAt: "2026-09-18T00:00:00.000Z",
      orderIdsOnNewestDate: ["111-4444444-5555555"],
    });
  });

  it("stops paging once a whole page predates the account cursor", async () => {
    const { run } = await seedAccount({
      newestOrderAt: "2026-09-15T00:00:00.000Z",
      orderIdsOnNewestDate: ["111-0000000-0000001"],
    });

    const listed = await listPage(
      run.id,
      "walk:old",
      historyPage(
        [
          { id: "111-8888888-9999999", date: "August 2, 2026" },
          { id: "111-8888888-9999998", date: "July 30, 2026" },
        ],
        `https://${HOST}/order-history?startIndex=10`,
      ),
    );

    expect(listed).toMatchObject({ kind: "order_list", nextPageUrl: null });
    await getDb(ctx.db)
      .update(runOrderCandidate)
      .set({ state: "imported" })
      .where(eq(runOrderCandidate.runId, run.id));
    await expect(
      claimNextImportWork(ctx.db, fakeBroker().namespace, run.id),
    ).resolves.toEqual({ kind: "none" });
  });
});
