import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The host must fence retired storage before SDK hydration, then verify public
 * destroy() on a cold retry. An isolate interruption is not a deletion receipt. */
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import { sanitizeWorkerdLogs } from "tooling/e2e-workerd-logs";
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

import {
  researchRetention,
  run,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  startScenarioHarness,
  type ScenarioHarness,
  waitFor,
} from "./purchase-agent-workerd.fixtures";
import { startPhotoInventoryRun } from "./run-service";

const disposed = z.object({ disposed: z.boolean() });
type CoordinatorRequest = {
  agentId: string;
  receiptId?: string;
  purpose?: AgentImportRunPurpose;
  event?: PurchaseAgentEvent;
};

describe("research retirement host", () => {
  const ctx = withTestDb();
  let releaseHarness: (() => void) | undefined;
  beforeAll(async () => {
    releaseHarness = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => releaseHarness?.());
  let runtime: ScenarioHarness | undefined;
  let started: E2ERunIdentity;
  let status = "failed";
  let scenario = "synthetic-retired-coordinator-disposal";
  let observations: Array<{
    boundary: string;
    expected: number | boolean;
    actual: number | boolean;
  }> = [];
  const repoRoot = path.resolve(process.cwd(), "../..");
  beforeEach(() => {
    started = captureE2ERunIdentity(repoRoot);
    status = "failed";
    scenario = "synthetic-retired-coordinator-disposal";
    observations = [];
  });
  afterEach(async () => {
    const inventory = sanitizeWorkerdLogs(
      runtime?.harness
        .getLogs()
        .filter((entry) => entry.message.includes("storage-inventory")) ?? [],
    );
    await runtime?.close();
    runtime = undefined;
    const outputDir = `/tmp/cubby-research-retirement-host-${Date.now()}`;
    mkdirSync(outputDir, { recursive: true });
    const evidence = path.join(outputDir, "boundary-results.json");
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          status,
          boundary:
            "Coordinator execution fences and receipt-authorized public SDK disposal",
          source:
            "Synthetic fixtures only; no model requests or production data",
          observations,
          inventory,
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
        "src/server/purchase-import/research-retirement-host.integration.test.ts",
        "--project",
        "integration-workerd",
      ],
      profile: "purchase-agent",
      scenario,
      started,
      cases: [{ name: scenario, status }],
    });
  });

  it("blocks retired fetch before initialization and acknowledges disposal only after a cold empty retry", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic coordinator owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const sourceId = crypto.randomUUID();
    const scope = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "manual",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "coordinator@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      input: {
        kind: "mail_research",
        mailboxId: "synthetic-mailbox",
        sources: [{ orderMailId: sourceId, checksum: "a".repeat(64) }],
      },
    });
    const checksum = await sha256Hex("Synthetic coordinator retirement");
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: scope.id,
        entityId: scope.id,
        entityKind: "run",
        workKey: sourceId,
        state: "pending",
        targetFingerprint: checksum,
      })
      .returning();
    if (!target) throw new Error("Synthetic retirement target unavailable");
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps: [] });
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const agentId = importRunAgentIdentity(scope.id, "mail_import");
    const request = (path: string, body: CoordinatorRequest) =>
      peer.fetch(new URL(path, "https://queue.test"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // Serving an absent conversation creates real SDK SQLite state without a model turn.
    expect((await request("/coordinator-fetch", { agentId })).status).toBe(200);
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
        phase: "objects_deleted",
        plan: {
          originOperationId: "synthetic-retirement",
          objectKeys: [],
          screenshotRefs: [],
          retiredRunIds: [scope.id],
          successors: [],
        },
      });
    const retiredFetch = await request("/coordinator-fetch", { agentId });
    observations.push({
      boundary: "retired fetch",
      expected: 410,
      actual: retiredFetch.status,
    });
    expect(retiredFetch.status).toBe(410);
    const reconnect = await request("/coordinator-dispatch", {
      agentId,
      purpose: "mail_import",
      event: {
        version: 1,
        type: "browser_connected",
        runId: scope.id,
        eventId: "synthetic-retired-reconnect",
      },
    });
    const admission = z
      .object({ accepted: z.boolean() })
      .parse(await reconnect.json());
    observations.push({
      boundary: "retired dispatch",
      expected: false,
      actual: admission.accepted,
    });
    expect(admission).toEqual({ accepted: false });
    // SDK destroy may abort the first RPC. Only a later empty-storage response is proof.
    await request("/coordinator-retire", { agentId, receiptId }).catch(
      () => undefined,
    );
    await waitFor(
      async () => {
        const acknowledgement = await request("/coordinator-retire", {
          agentId,
          receiptId,
        });
        expect(acknowledgement.status).toBe(200);
        const coldDisposal = disposed.parse(await acknowledgement.json());
        observations.push({
          boundary: "cold disposal acknowledgement",
          expected: true,
          actual: coldDisposal.disposed,
        });
        return coldDisposal.disposed;
      },
      "Public SDK disposal never received a cold empty-storage acknowledgement",
      3_000,
    );
    expect((await request("/coordinator-fetch", { agentId })).status).toBe(410);
    expect(await runtime.emitted()).toEqual([]);
    status = "passed";
  }, 90_000);
  it("fences legacy fetch and reconnect before the durable conversation can execute", async () => {
    scenario = "synthetic-legacy-coordinator-execution-fence";
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic legacy coordinator owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const scope = await insertWithShortcode(ctx.db, "run", {
      purpose: "account_sync",
      status: "running",
      trigger: "manual",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "coordinator@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      input: null,
    });
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps: [] });
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const agentId = importRunAgentIdentity(scope.id, "account_sync");
    const request = (path: string, body: CoordinatorRequest) =>
      peer.fetch(new URL(path, "https://queue.test"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const response = await request("/coordinator-fetch", { agentId });
    observations.push({
      boundary: "legacy fetch",
      expected: 409,
      actual: response.status,
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("legacy");
    const resumed = await request("/coordinator-dispatch", {
      agentId,
      purpose: "account_sync",
      event: {
        version: 1,
        type: "browser_connected",
        runId: scope.id,
        eventId: "synthetic-legacy-reconnect",
      },
    });
    const result = z
      .object({ accepted: z.boolean() })
      .parse(await resumed.json());
    observations.push({
      boundary: "legacy reconnect",
      expected: false,
      actual: result.accepted,
    });
    expect(result.accepted).toBe(false);
    expect(await runtime.emitted()).toEqual([]);
    expect(
      await getDb(ctx.db).select().from(run).where(eq(run.id, scope.id)),
    ).toEqual([scope]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, scope.id)),
    ).toEqual([]);
    status = "passed";
  }, 90_000);
  it("preserves the member's photo coordinator for an explicitly shared household owner", async () => {
    scenario = "synthetic-shared-photo-coordinator";
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic photo member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const household = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic shared photo household",
      kind: "household",
    });
    const startedRun = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
      ledgerPartyId: household.id,
    });
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps: [] });
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const response = await peer.fetch("https://queue.test/coordinator-fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: importRunAgentIdentity(startedRun.id, "photo_inventory"),
      }),
    });
    observations.push({
      boundary: "shared photo fetch",
      expected: 200,
      actual: response.status,
    });
    expect(response.status).toBe(200);
    const [persisted] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, startedRun.id));
    expect(persisted).toMatchObject({
      ledgerPartyId: household.id,
      actorUserId: ctx.actor.userId,
    });
    expect(await runtime.emitted()).toEqual([]);
    status = "passed";
  }, 90_000);
});
