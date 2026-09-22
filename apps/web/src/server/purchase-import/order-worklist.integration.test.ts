import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importRun,
  importRunOrderCandidate,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  claimNextImportWork,
  finishImportRun,
  importBrowserOrderEvidence,
  issueBrowserCommand,
  startOrResumeImportRun,
} from "./run-service";

const HOST = "shop.example.test";
const orderUrl = (id: string) => `https://${HOST}/orders/details?orderID=${id}`;

/** A fake bridge whose next result is the page the test hands it. */
function fakeBroker() {
  let issued: BrowserBridgeRequest | undefined;
  let capture: BrowserBridgeResult["outcome"] | undefined;
  const broker = {
    enqueue: async (command: BrowserBridgeRequest) => {
      issued = command;
    },
    result: async (): Promise<BrowserBridgeResult | null> =>
      issued && capture
        ? {
            protocolVersion: 2,
            commandID: issued.id,
            operationID: issued.operationId,
            runID: issued.runID,
            completedAt: new Date().toISOString(),
            outcome: capture,
          }
        : null,
    cancel: async () => undefined,
    connected: async () => true,
    pendingCommands: async () => [],
    notifyRunCompleted: async () => undefined,
    requestAuthentication: async () => undefined,
  };
  return {
    namespace: { getByName: () => broker },
    respondWith(outcome: BrowserBridgeResult["outcome"]) {
      capture = outcome;
    },
  };
}

const historyPage = (
  orders: ReadonlyArray<{ id: string; date: string }>,
  next: string | null,
): BrowserBridgeResult["outcome"] => ({
  status: "completed",
  capture: {
    sourceURL: `https://${HOST}/order-history`,
    title: "Your Orders",
    capturedAt: new Date().toISOString(),
    captureVersion: 1,
    variantMarkers: [],
    readableText: orders
      .map(
        (order) =>
          `Order placed ${order.date} Order # ${order.id} Total $12.00`,
      )
      .join("\n"),
    links: [
      ...orders.map((order) => ({
        id: `link-${order.id}`,
        url: orderUrl(order.id),
        label: "View order details",
      })),
      ...(next ? [{ id: "next", url: next, label: "Next →" }] : []),
    ],
    images: [],
    paymentEvidence: [],
    evidence: [],
  },
});

describe("account-sync order worklist", () => {
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
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    return { party, vendor, account, run };
  }

  async function listPage(
    runId: string,
    operationId: string,
    outcome: BrowserBridgeResult["outcome"],
  ) {
    const bridge = fakeBroker();
    const issued = await issueBrowserCommand(ctx.db, bridge.namespace, {
      runId,
      operationId,
      operation: {
        type: "navigate",
        url: `https://${HOST}/order-history`,
        allowedHosts: [HOST],
      },
    });
    bridge.respondWith(outcome);
    return importBrowserOrderEvidence(ctx.db, bridge.namespace, {
      runId,
      operationId: `${operationId}:import`,
      commandId: issued.commandId,
    });
  }

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
      .select({ ordersSeen: importRun.ordersSeen })
      .from(importRun)
      .where(eq(importRun.id, run.id));
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
      finishImportRun(ctx.db, bridge.namespace, {
        runId: run.id,
        operationId: "finish:early",
      }),
    ).rejects.toThrow("listed order(s)");

    // Once every listed order is handled the walk resumes from the next page,
    // and finishing advances the account cursor to the newest handled order.
    await getDb(ctx.db)
      .update(importRunOrderCandidate)
      .set({ state: "imported" })
      .where(eq(importRunOrderCandidate.runId, run.id));
    await expect(
      claimNextImportWork(ctx.db, bridge.namespace, run.id),
    ).resolves.toEqual({
      kind: "cursor_walk",
      startUrl: `https://${HOST}/order-history?startIndex=10`,
    });
    await finishImportRun(ctx.db, bridge.namespace, {
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
      .update(importRunOrderCandidate)
      .set({ state: "imported" })
      .where(eq(importRunOrderCandidate.runId, run.id));
    await expect(
      claimNextImportWork(ctx.db, fakeBroker().namespace, run.id),
    ).resolves.toEqual({ kind: "none" });
  });
});
