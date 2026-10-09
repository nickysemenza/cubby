import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import { withTestDb } from "tooling/test-setup";
import {
  HOLD_WORKERD_HARNESS_TIMEOUT_MS,
  holdWorkerdHarness,
} from "tooling/workerd-harness";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { researchRetention, run, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { capturedHtml } from "./browser.fixtures";
import {
  startScenarioHarness,
  waitFor,
  type ScenarioHarness,
} from "./purchase-agent-workerd.fixtures";
import type { PurchaseImportDurableObjectRpc } from "./rpc";

type BrokerTestRequest = Partial<
  Parameters<PurchaseImportDurableObjectRpc["forgetRun"]>[0]
> & {
  vendorAccountId: string;
  command?: BrowserBridgeRequest;
  commandId?: string;
  ledgerPartyId?: string;
  userId?: string;
  deviceID?: string;
  autoForgetAck?: boolean;
  outcomes?: Record<string, BrowserBridgeResult["outcome"]>;
  initialForgetAck?: { runID: string; retirementID: string; deviceID: string };
};

// Server deletion cannot erase an offline Mac. A second socket claiming the
// first device's ID, receipt substitution, late replay, or unrelated Run must
// not complete its cleanup. Reconnect delivers erasure to the original device.
describe("research browser retirement", () => {
  const ctx = withTestDb();
  let releaseHarness: (() => void) | undefined;
  beforeAll(async () => {
    releaseHarness = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => releaseHarness?.());
  let runtime: ScenarioHarness | undefined;
  let started: E2ERunIdentity;
  let status = "failed";
  let results: Array<{ boundary: string; result: boolean }> = [];
  const repoRoot = path.resolve(process.cwd(), "../..");
  beforeEach(() => {
    started = captureE2ERunIdentity(repoRoot);
    status = "failed";
    results = [];
  });
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    const outputDir = `/tmp/cubby-research-browser-retirement-${Date.now()}`;
    mkdirSync(outputDir, { recursive: true });
    const evidence = path.join(outputDir, "boundary-results.json");
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          status,
          source:
            "Synthetic broker fixtures; no model requests or production data",
          results,
        },
        null,
        2,
      ),
    );
    writeE2ERunBundle({
      repoRoot,
      outputDir,
      evidence: [evidence],
      kind: "browser",
      status,
      command: [
        "pnpm",
        "--dir",
        "apps/web",
        "test:postgres",
        "src/server/purchase-import/research-browser-retirement.integration.test.ts",
        "--project",
        "integration-workerd",
      ],
      profile: "purchase-agent",
      scenario: "synthetic-browser-cache-erasure",
      started,
      cases: [{ name: "Recipient-bound browser cache erasure", status }],
    });
  });

  it("requires recipient-bound native erasure acknowledgement before certifying broker cleanup", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic broker owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const scope = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "manual",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "broker@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
    });
    const checksum = await sha256Hex("Synthetic browser cache erasure");
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: scope.id,
        entityId: scope.id,
        entityKind: "run",
        state: "pending",
        targetFingerprint: checksum,
      })
      .returning();
    if (!target) throw new Error("Synthetic target unavailable");
    const accountId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const deviceID = "11111111-1111-4111-8111-111111111111";
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps: [] });
    started = captureE2ERunIdentity(repoRoot);
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const request = (route: string, body: BrokerTestRequest) =>
      peer.fetch(new URL(route, "https://queue.test"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const connection = {
      vendorAccountId: accountId,
      ledgerPartyId: member.id,
      userId: ctx.actor.userId,
    };
    expect(
      (
        await request("/broker-enqueue", {
          vendorAccountId: accountId,
          command: {
            protocolVersion: 4,
            id: commandId,
            operationId: "synthetic-cache-command",
            runID: scope.id,
            deadline: new Date(Date.now() + 60_000).toISOString(),
            operation: {
              type: "navigate",
              url: "https://example.test/item",
              allowedHosts: ["example.test"],
            },
          },
        })
      ).status,
    ).toBe(202);
    const cachedPage = await capturedHtml({
      sourceURL: "https://example.test/item",
      title: "Synthetic cached variant",
      html: "<p>Synthetic unrelated source text</p><select><option selected>Green</option></select>",
    });
    expect(
      (
        await request("/browser-connect", {
          ...connection,
          deviceID,
          outcomes: { "https://example.test/item": cachedPage },
        })
      ).status,
    ).toBe(202);
    const state = () =>
      request("/broker-state", {
        vendorAccountId: accountId,
        runId: scope.id,
        commandId,
      });
    await waitFor(
      async () =>
        z
          .object({ result: z.unknown().nullable() })
          .parse(await (await state()).json()).result !== null,
      "Synthetic browser cached result",
      10_000,
    );
    const receiptId = crypto.randomUUID();
    await getDb(ctx.db)
      .update(run)
      .set({
        retiredAt: new Date(),
        retirementReason: "unrelated_source",
        status: "needs_review",
      })
      .where(eq(run.id, scope.id));
    await getDb(ctx.db)
      .insert(researchRetention)
      .values({
        id: receiptId,
        runId: scope.id,
        workRef: target.id,
        ledgerPartyId: member.id,
        orderMailId: crypto.randomUUID(),
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-message",
        checksum,
        phase: "fenced",
        plan: {
          originOperationId: "synthetic-retirement",
          objectKeys: [],
          screenshotRefs: [],
          retiredRunIds: [scope.id],
          successors: [],
        },
      });
    const forget = async () =>
      z.object({ forgotten: z.boolean() }).parse(
        await (
          await request("/broker-forget", {
            vendorAccountId: accountId,
            runId: scope.id,
            receiptId,
          })
        ).json(),
      ).forgotten;
    expect(await forget()).toBe(false);
    results.push({ boundary: "No native acknowledgement", result: true });
    expect(
      z
        .object({ result: z.unknown().nullable() })
        .parse(await (await state()).json()).result,
    ).toBeNull();
    expect(
      (
        await request("/browser-connect", {
          ...connection,
          deviceID: "22222222-2222-4222-8222-222222222222",
          initialForgetAck: {
            runID: scope.id,
            retirementID: receiptId,
            deviceID,
          },
        })
      ).status,
    ).toBe(202);
    expect(await forget()).toBe(false);
    results.push({
      boundary: "Foreign socket cannot acknowledge original device",
      result: true,
    });
    expect(
      (
        await request("/browser-connect", {
          ...connection,
          deviceID,
          autoForgetAck: true,
        })
      ).status,
    ).toBe(202);
    await waitFor(forget, "Original recipient erasure acknowledgement", 10_000);
    expect(await forget()).toBe(true);
    results.push({
      boundary: "Original device reconnect acknowledgement",
      result: true,
    });
    status = "passed";
  }, 90_000);
});
