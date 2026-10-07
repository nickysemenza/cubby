import { runEntityId } from "@cubby/schemas/identifiers";
import type { BrowserBridgeRequest } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  ledgerParty,
  run as runTable,
  runEvidence,
  runProgress,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  insertOperation,
  setOperationResult,
} from "~/server/repo/run-operation";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  completedCapture,
  failedCommand,
  observation,
  renderPage,
  scriptedBroker,
  testBrowserPorts,
} from "./browser.fixtures";
import { productEnrichmentTarget } from "./product-enrichment-target";
import {
  issueBrowserCommand,
  readBrowserCommandResult,
  startOrResumeRun,
  startTargetedRun,
  stopRunForReview,
} from "./run-service";

// The Mac sends what it saw; the server reads the page, keeps its DOM as
// evidence, and decides what a failure means. A run once stalled with no
// reason when its window was minimized: each failure here must end in a
// retry, a pause naming the member's fix, or a read page.
describe("the server's reading of browser steps", () => {
  const ctx = withTestDb();
  const HOST = "shop.example.test";
  const ORDERS = `https://${HOST}/orders`;

  async function member() {
    const [existing] = await getDb(ctx.db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(eq(ledgerParty.userId, ctx.actor.userId));
    return (
      existing ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Browser recovery member",
        kind: "member",
        userId: ctx.actor.userId,
      }))
    );
  }

  async function accountSync() {
    const party = await member();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Recovery vendor ${crypto.randomUUID()}`,
      website: `https://${HOST}`,
      browserDomains: [HOST],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Recovery account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    return run.id;
  }

  const capture = {
    type: "capture" as const,
    allowedHosts: [HOST],
    screenshot: "required" as const,
    recoveryURL: ORDERS,
  };

  async function progress(runId: string) {
    const rows = await getDb(ctx.db)
      .select({ detail: runProgress.detail })
      .from(runProgress)
      .where(
        and(
          eq(runProgress.runId, runEntityId.parse(runId)),
          eq(runProgress.phase, "browser"),
        ),
      );
    return rows.map((row) => row.detail);
  }

  async function runStatus(runId: string) {
    const [row] = await getDb(ctx.db)
      .select({ status: runTable.status, failureCode: runTable.failureCode })
      .from(runTable)
      .where(eq(runTable.id, runEntityId.parse(runId)));
    return row;
  }

  it("keeps a captured page's DOM as evidence once and answers with the derived page", async () => {
    const runId = await accountSync();
    const bridge = scriptedBroker(() =>
      completedCapture(ORDERS, {
        title: "Your orders",
        text: "Order 42 placed September 2, 2026",
        links: [{ url: `${ORDERS}/42`, label: "View order" }],
      }),
    );
    const ports = testBrowserPorts();
    await issueBrowserCommand(
      ctx.db,
      bridge.namespace,
      { runId, operationId: "capture:list", operation: capture },
      ports,
    );
    const read = () =>
      readBrowserCommandResult(
        ctx.db,
        bridge.namespace,
        { runId, operationId: "capture:list" },
        ports,
      );

    const first = await read();
    expect(first).toMatchObject({
      state: "completed",
      capture: {
        title: "Your orders",
        readableText: "Order 42 placed September 2, 2026\nView order",
        links: [{ id: "link-1", url: `${ORDERS}/42`, label: "View order" }],
      },
    });
    expect(await read()).toEqual(first);

    const evidence = await getDb(ctx.db)
      .select({
        mediaType: runEvidence.mediaType,
        targetId: runEvidence.targetId,
        objectKey: runEvidence.objectKey,
      })
      .from(runEvidence)
      .where(eq(runEvidence.runId, runId));
    expect(evidence).toEqual([
      { mediaType: "text/html", targetId: null, objectKey: expect.any(String) },
    ]);
    expect([...ports.objects.keys()]).toEqual([evidence[0]!.objectKey]);
  });

  // A read interrupted after the DOM was stored (the cached page never
  // written) must not store the page a second time.
  it("stores a command's DOM once when a read is repeated before the page was cached", async () => {
    const runId = await accountSync();
    const bridge = scriptedBroker(() =>
      completedCapture(ORDERS, { title: "Your orders", text: "Order 42" }),
    );
    const ports = testBrowserPorts();
    const issued = await issueBrowserCommand(
      ctx.db,
      bridge.namespace,
      { runId, operationId: "capture:twice", operation: capture },
      ports,
    );
    const read = () =>
      readBrowserCommandResult(
        ctx.db,
        bridge.namespace,
        { runId, operationId: "capture:twice" },
        ports,
      );
    await read();
    await setOperationResult(
      getDb(ctx.db),
      { runId: runEntityId.parse(runId), operationId: "capture:twice" },
      { command: bridge.issued[0]!, commandId: issued.commandId },
    );
    expect(await read()).toMatchObject({ state: "completed" });
    const evidence = await getDb(ctx.db)
      .select({ id: runEvidence.id })
      .from(runEvidence)
      .where(eq(runEvidence.runId, runEntityId.parse(runId)));
    expect(evidence).toHaveLength(1);
    expect(ports.objects.size).toBe(1);
  });

  // Protocol 3 is a hard cut: a step an older server issued can be neither
  // answered nor reissued, so its run stops for review rather than waiting.
  it("stops a run for review when it reads a step issued in the older protocol", async () => {
    const runId = await accountSync();
    await insertOperation(getDb(ctx.db), {
      runId: runEntityId.parse(runId),
      operationId: "capture:v2",
      kind: "browser_command",
      inputFingerprint: "f".repeat(64),
      result: {
        commandId: crypto.randomUUID(),
        command: { protocolVersion: 2, operation: { type: "capture" } },
      },
    });
    const bridge = scriptedBroker(() => null);
    expect(
      await readBrowserCommandResult(
        ctx.db,
        bridge.namespace,
        { runId, operationId: "capture:v2" },
        testBrowserPorts(),
      ),
    ).toMatchObject({ state: "stopped" });
    expect(await runStatus(runId)).toEqual({
      status: "needs_review",
      failureCode: "browser_protocol_changed",
    });
  });

  it("raises a minimized window and retries once, answering with the retry's page", async () => {
    const runId = await accountSync();
    const bridge = scriptedBroker((command, index) =>
      index === 0
        ? failedCommand("screenshot_unavailable", {
            retryable: true,
            screenshotGap: "window_minimized",
          })
        : command.operation.type === "window"
          ? { status: "completed", snapshot: null, observation: observation() }
          : completedCapture(
              ORDERS,
              { title: "Your orders", text: "Order 42" },
              [
                {
                  id: crypto.randomUUID(),
                  kind: "screenshot",
                  checksum: "a".repeat(64),
                  contentType: "image/jpeg",
                },
              ],
            ),
    );
    const ports = testBrowserPorts();
    await issueBrowserCommand(
      ctx.db,
      bridge.namespace,
      { runId, operationId: "capture:hidden", operation: capture },
      ports,
    );
    const read = () =>
      readBrowserCommandResult(
        ctx.db,
        bridge.namespace,
        { runId, operationId: "capture:hidden" },
        ports,
      );

    expect(await read()).toMatchObject({
      state: "dispatched",
      retrying: expect.stringContaining("window_minimized"),
    });
    expect(
      bridge.issued.map((command: BrowserBridgeRequest) => [
        command.operationId,
        command.operation.type,
      ]),
    ).toEqual([
      ["capture:hidden", "capture"],
      ["capture:hidden:raise-1", "window"],
      ["capture:hidden:retry-1", "capture"],
    ]);
    expect(await read()).toMatchObject({
      state: "completed",
      capture: { readableText: "Order 42" },
    });
    expect(await progress(runId)).toEqual([
      expect.stringMatching(
        /^Retrying capture after raising the window: screenshot_unavailable \(window_minimized\)/u,
      ),
    ]);
  });

  it("pauses naming the window once its retry fails too, and retries again after the member resumes", async () => {
    const runId = await accountSync();
    const bridge = scriptedBroker((command) =>
      command.operation.type === "window"
        ? null
        : failedCommand("screenshot_unavailable", {
            retryable: true,
            screenshotGap: "window_off_screen",
          }),
    );
    const ports = testBrowserPorts();
    await issueBrowserCommand(
      ctx.db,
      bridge.namespace,
      { runId, operationId: "capture:away", operation: capture },
      ports,
    );
    const read = () =>
      readBrowserCommandResult(
        ctx.db,
        bridge.namespace,
        { runId, operationId: "capture:away" },
        ports,
      );

    await read();
    expect(await read()).toMatchObject({
      state: "paused_offline",
      reason: expect.stringContaining("Bring the window forward"),
    });
    expect(await runStatus(runId)).toEqual({
      status: "paused_offline",
      failureCode: "window_off_screen",
    });

    // The member brings the window back and resumes.
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "running" })
      .where(eq(runTable.id, runEntityId.parse(runId)));
    expect(await read()).toMatchObject({ state: "dispatched" });
    expect(bridge.issued.at(-1)?.operationId).toBe("capture:away:retry-2");
  });

  it("pauses at once naming a permission only the member can grant", async () => {
    const runId = await accountSync();
    const bridge = scriptedBroker(() =>
      failedCommand("screenshot_unavailable", {
        screenshotGap: "screen_recording_denied",
      }),
    );
    const ports = testBrowserPorts();
    await issueBrowserCommand(
      ctx.db,
      bridge.namespace,
      { runId, operationId: "capture:denied", operation: capture },
      ports,
    );
    expect(
      await readBrowserCommandResult(
        ctx.db,
        bridge.namespace,
        { runId, operationId: "capture:denied" },
        ports,
      ),
    ).toMatchObject({
      state: "paused_offline",
      reason: expect.stringContaining("Screen & System Audio Recording"),
    });
    expect(bridge.issued).toHaveLength(1);
  });

  it("pauses for sign-in, raises the window, and captures afresh once the member resumes", async () => {
    const runId = await accountSync();
    const bridge = scriptedBroker((_command, index) =>
      index === 0
        ? completedCapture(`https://${HOST}/signin`, {
            title: "Sign in",
            signIn: true,
          })
        : completedCapture(ORDERS, { title: "Your orders", text: "Order 42" }),
    );
    const ports = testBrowserPorts();
    await issueBrowserCommand(
      ctx.db,
      bridge.namespace,
      { runId, operationId: "capture:signin", operation: capture },
      ports,
    );
    const read = () =>
      readBrowserCommandResult(
        ctx.db,
        bridge.namespace,
        { runId, operationId: "capture:signin" },
        ports,
      );
    expect(await read()).toMatchObject({ state: "paused_auth" });
    expect(await runStatus(runId)).toEqual({
      status: "paused_auth",
      failureCode: "authentication_required",
    });
    expect(bridge.authenticationRequests).toHaveLength(1);

    // Signed in and resumed: the cached sign-in form is not the answer.
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "running" })
      .where(eq(runTable.id, runEntityId.parse(runId)));
    expect(await read()).toMatchObject({ state: "dispatched" });
    expect(await read()).toMatchObject({
      state: "completed",
      capture: { readableText: "Order 42" },
    });
  });

  // An agent whose browser step kept failing could not stop its paused run:
  // the stop was refused, so it retried the same step for hours.
  it("lets the agent stop a paused run for review", async () => {
    const runId = await accountSync();
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_offline" })
      .where(eq(runTable.id, runEntityId.parse(runId)));
    await stopRunForReview(ctx.db, {
      runId,
      operationId: "stop:paused",
      kind: "other",
      summary: "The order history never loaded.",
    });
    expect(await runStatus(runId)).toMatchObject({ status: "needs_review" });
  });

  describe("a public product page", () => {
    const SEED = "seed.example.test";
    const PAGE = `https://${SEED}/products/basil?variant=101`;

    async function enrichment() {
      const party = await member();
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: `Seed vendor ${crypto.randomUUID()}`,
        website: `https://${SEED}`,
        browserDomains: [SEED],
      });
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Seed account",
        vendorId: vendor.id,
        ledgerPartyId: party.id,
        status: "active",
        browserSyncEnabled: true,
      });
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic basil packet" }),
        ctx.actor,
      );
      const started = await startTargetedRun(ctx.db, {
        ledgerPartyId: party.id,
        purpose: "product_enrichment",
        vendorId: vendor.id,
        vendorAccountId: account.id,
        trigger: "discovery",
        targets: [
          {
            kind: "product",
            productId: product.entityId,
            sourceExternalKey: PAGE,
            targetFingerprint: (await productEnrichmentTarget(
              getDb(ctx.db),
              product.entityId,
            ))!.fingerprint,
          },
        ],
      });
      if (!started.created) throw new Error("Expected enrichment admission");
      return started.run.id;
    }

    const productCapture = {
      type: "capture" as const,
      allowedHosts: [SEED],
      screenshot: "preferred" as const,
      recoveryURL: PAGE,
    };

    it("is read by the server without the Mac when the vendor serves it", async () => {
      const runId = await enrichment();
      const bridge = scriptedBroker(() => null);
      const html = renderPage({
        title: "Basil seed packet",
        text: `Basil seed packet ${"Sweet Genovese basil. ".repeat(100)}`,
        jsonLd: [{ "@type": "Product", sku: "BASIL-101" }],
      });
      const ports = testBrowserPorts(async (url) => ({
        status: "fetched",
        url,
        html,
        durationMs: 5,
      }));
      expect(
        await issueBrowserCommand(
          ctx.db,
          bridge.namespace,
          { runId, operationId: "capture:basil", operation: productCapture },
          ports,
        ),
      ).toMatchObject({ state: "completed" });
      expect(bridge.issued).toEqual([]);
      expect(
        await readBrowserCommandResult(
          ctx.db,
          bridge.namespace,
          { runId, operationId: "capture:basil" },
          ports,
        ),
      ).toMatchObject({
        state: "completed",
        capture: {
          title: "Basil seed packet",
          structuredProducts: {
            products: [{ skus: ["BASIL-101"] }],
            variantGroup: false,
          },
        },
      });
      expect(await progress(runId)).toEqual([
        `Read ${SEED} directly, without the Mac`,
      ]);
      // A replayed issue (the agent resumed before memoizing it) keeps the
      // server's read rather than sending the step to the Mac.
      expect(
        await issueBrowserCommand(
          ctx.db,
          bridge.namespace,
          { runId, operationId: "capture:basil", operation: productCapture },
          ports,
        ),
      ).toMatchObject({ state: "completed" });
      expect(bridge.issued).toEqual([]);
    });

    // A sign-in form served to the server would pause the run, and the
    // capture after the member signed in would be served it again.
    it("sends a page the vendor answers with a sign-in form to the Mac", async () => {
      const runId = await enrichment();
      const bridge = scriptedBroker(() => null);
      const ports = testBrowserPorts(async (url) => ({
        status: "fetched",
        url,
        html: renderPage({
          title: "Sign in",
          text: "Sign in to continue. ".repeat(100),
          signIn: true,
        }),
        durationMs: 5,
      }));
      expect(
        await issueBrowserCommand(
          ctx.db,
          bridge.namespace,
          { runId, operationId: "capture:gated", operation: productCapture },
          ports,
        ),
      ).toMatchObject({ state: "dispatched" });
      expect(bridge.issued).toHaveLength(1);
      expect(await progress(runId)).toEqual([
        `${SEED} asked the server to sign in; using the Mac's browser`,
      ]);
    });

    it("falls back to the Mac's browser, saying why, when the vendor refuses the server", async () => {
      const runId = await enrichment();
      const bridge = scriptedBroker(() => null);
      const ports = testBrowserPorts(async () => ({
        status: "blocked",
        reason: "HTTP 403",
        durationMs: 5,
      }));
      expect(
        await issueBrowserCommand(
          ctx.db,
          bridge.namespace,
          { runId, operationId: "capture:walled", operation: productCapture },
          ports,
        ),
      ).toMatchObject({ state: "dispatched" });
      expect(bridge.issued).toHaveLength(1);
      expect(await progress(runId)).toEqual([
        `${SEED} refused a direct read (HTTP 403); using the Mac's browser`,
      ]);
    });
  });
});
