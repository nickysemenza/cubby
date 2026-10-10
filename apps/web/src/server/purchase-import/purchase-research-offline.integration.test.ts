import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { and, eq, getTableColumns } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import {
  from,
  type ScriptStep,
  type ScriptValue,
} from "tooling/purchase-agent-script";
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

import {
  product,
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { browserCommandRecord } from "./browser-results";
import { admitProductResearch } from "./product-research-run";
import {
  authorizePurchaseAgent,
  authorizeSyntheticRunInference,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
  type ScenarioHarness,
} from "./purchase-agent-workerd.fixtures";

// A sleeping Mac must neither terminate useful cloud research nor hide a
// second task behind the first task's retained browser command. Only model
// choices, semantic assessment, and public network responses are synthetic.
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const sources = [
  {
    url: "https://maker.example.test/fan-small-blue",
    title: "Example small blue fan",
    description: "Exact small blue catalog entry",
    html: "<h1>Example small blue fan</h1><p>Manufacturer: Example Works. Selected variant: small, blue. Model: F17SB.</p>",
  },
  {
    url: "https://maker.example.test/lamp-small-white",
    title: "Example small white lamp",
    description: "Exact small white catalog entry",
    html: "<h1>Example small white lamp</h1><p>Manufacturer: Example Works. Selected variant: small, white. Model: L21SW.</p>",
  },
];
const step = (
  call: string,
  tool: string,
  args: Record<string, ScriptValue> = {},
): ScriptStep => ({ call, tool, args });
const resolve = (
  call: string,
  work: string,
  read: string,
  model: string,
): ScriptStep => {
  const proposal = researchWorkResolve.parse({
    workRef: "11111111-1111-4111-8111-111111111111",
    status: "researched_with_gaps",
    identity: {
      evidenceIds: ["11111111-1111-4111-8111-111111111111"],
      reasoning: `The retained public page identifies the assigned exact variant and model ${model}.`,
    },
    facts: [
      {
        evidenceId: "11111111-1111-4111-8111-111111111111",
        fieldPath: "model",
        value: model,
        support: {
          observation: `The selected exact variant is model ${model}.`,
          reasoning:
            "The page title, maker and selected variant match the assigned Product; other facts and image coverage are not established.",
        },
      },
    ],
    detail: `Filled only the supported model ${model}; category, identifiers and representative-image research remain gaps.`,
  });
  return step(call, "work_resolve", {
    ...proposal,
    workRef: from(work, "work.workRef"),
    identity: { ...proposal.identity, evidenceIds: [from(read, "evidenceId")] },
    facts: proposal.facts.map((fact) => ({
      ...fact,
      evidenceId: from(read, "evidenceId"),
    })),
  });
};
const steps: ScriptStep[] = [
  step("offline-first", "work_next"),
  step("offline-browser", "work_observe", {
    workRef: from("offline-first", "work.workRef"),
    action: { kind: "navigate", url: sources[0]!.url },
  }),
  { check: "offline-browser", includes: "browser_pending" },
  step("offline-public-first", "web_read", {
    workRef: from("offline-first", "work.workRef"),
    url: sources[0]!.url,
  }),
  step("offline-next-cloud", "work_next"),
  step("offline-public-second", "web_read", {
    workRef: from("offline-next-cloud", "work.workRef"),
    url: sources[1]!.url,
  }),
  { gate: "offline-public-evidence-verified" },
  resolve(
    "offline-resolve-first",
    "offline-first",
    "offline-public-first",
    "F17SB",
  ),
  resolve(
    "offline-resolve-second",
    "offline-next-cloud",
    "offline-public-second",
    "L21SW",
  ),
];

describe("research continues with the Mac offline", () => {
  const ctx = withTestDb();
  let releaseHarness: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseHarness = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => releaseHarness?.());
  const factsForRun = (id: typeof run.$inferSelect.id) =>
    getDb(ctx.db)
      .select(getTableColumns(runFactEvidence))
      .from(runFactEvidence)
      .innerJoin(runTarget, eq(runFactEvidence.targetId, runTarget.id))
      .where(eq(runTarget.runId, id));
  let runtime: ScenarioHarness | undefined;
  let started: E2ERunIdentity;
  let status = "failed";
  let runId: typeof run.$inferSelect.id | undefined;
  let boundaries: Array<{ boundary: string; result: boolean }> = [];
  beforeEach(() => {
    started = captureE2ERunIdentity(repoRoot);
    status = "failed";
    runId = undefined;
    boundaries = [];
  });
  afterEach(async () => {
    const readDiagnostic = async () => {
      try {
        if (!runtime || !runId) return null;
        return {
          state: await workerdDiagnostic(ctx.db, runId, runtime.harness),
          emitted: await runtime.emitted(),
          violations: await runtime.violations(),
          evidence: await getDb(ctx.db)
            .select()
            .from(runEvidence)
            .where(eq(runEvidence.runId, runId)),
          facts: await factsForRun(runId),
        };
      } catch (error) {
        return {
          diagnosticError:
            error instanceof Error ? error.message : String(error),
        };
      }
    };
    const diagnostic = await readDiagnostic();
    try {
      await runtime?.close();
    } finally {
      runtime = undefined;
      const outputDir = `/tmp/cubby-research-offline-${Date.now()}`;
      mkdirSync(outputDir, { recursive: true });
      const evidence = path.join(outputDir, "boundary-results.json");
      writeFileSync(
        evidence,
        JSON.stringify(
          { status, synthetic: true, boundaries, diagnostic },
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
          "src/server/purchase-import/purchase-research-offline.integration.test.ts",
          "--project",
          "integration-workerd",
        ],
        profile: "purchase-agent",
        scenario: "offline-browser-cloud-research",
        started,
        cases: [
          {
            name: "Offline browser retains command while public reads and supported writes continue",
            status,
          },
        ],
      });
    }
  });

  it("retains the queued browser command while public fallback and another cloud task make supported writes without a wake", async () => {
    const database = getDb(ctx.db);
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic offline member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Works",
      website: "https://maker.example.test",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic sleeping Mac",
      vendorId: vendor.id,
      ledgerPartyId: member.id,
      browserSyncEnabled: true,
    });
    const items = await Promise.all(
      sources.map((source) =>
        createProductFixture(
          ctx.db,
          makeProductInput({
            name: source.title,
            manufacturer: "Example Works",
            model: "",
          }),
          ctx.actor,
        ),
      ),
    );
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const [admitted] = await admitProductResearch(ctx.db, {
      ledgerPartyId: member.id,
      userId: ctx.actor.userId,
      productIds: items.map((item) => item.entityId),
      preferredBrowserAccountId: account.id,
      cause: "member_request",
    });
    if (!admitted?.created)
      throw new Error("Synthetic Product admission unavailable");
    runId = admitted.run.id;
    await authorizeSyntheticRunInference(
      ctx,
      admitted.run.id,
      "synthetic-offline-mailbox",
    );
    if (!admitted.run.dispatchEventId)
      throw new Error("Synthetic research dispatch unavailable");
    const admittedTargets = await database
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, admitted.run.id));
    const first = admittedTargets.find(
      (target) => target.entityId === items[0]!.entityId,
    );
    const second = admittedTargets.find(
      (target) => target.entityId === items[1]!.entityId,
    );
    if (!first || !second) throw new Error("Synthetic targets unavailable");
    await database
      .update(runTarget)
      .set({ createdAt: new Date("2026-09-01T00:00:00Z") })
      .where(eq(runTarget.id, first.id));
    await database
      .update(runTarget)
      .set({ createdAt: new Date("2026-09-02T00:00:00Z") })
      .where(eq(runTarget.id, second.id));
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps });
    started = captureE2ERunIdentity(repoRoot);
    const configured = await runtime.harness
      .getWorker("cubby-test-gateway")
      .fetch("https://gateway.test/configure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sources,
          extractions: [],
          assessments: ["F17SB", "L21SW"].map((model) => ({
            match: `supported model ${model}`,
            output: {
              identityVerified: true,
              acceptedFacts: [0],
              acceptedIdentifiers: [],
              acceptedIdentifierClaims: [],
              acceptedImages: [],
              acceptedOrders: [],
              acceptedEmailLinks: [],
              rejected: [],
            },
          })),
        }),
      });
    expect(configured.status).toBe(204);
    await runtime.dispatch({
      version: 1,
      type: "start_or_resume",
      purpose: "product_enrichment",
      runId: admitted.run.id,
      eventId: admitted.run.dispatchEventId,
    });
    await waitFor(
      async () =>
        (
          await database
            .select()
            .from(runEvidence)
            .where(eq(runEvidence.runId, admitted.run.id))
        ).length === 2,
      "Offline browser prevented the two task-bound public observations",
      15_000,
    );
    const evidence = await database
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, admitted.run.id));
    expect(evidence).toHaveLength(2);
    expect(evidence.every((row) => row.kind === "web_page")).toBe(true);
    expect(evidence.map((row) => row.targetId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    const [before] = await database
      .select()
      .from(run)
      .where(eq(run.id, admitted.run.id));
    expect(before?.status).toBe("running");
    expect((await factsForRun(admitted.run.id)).length).toBe(0);
    const operations = await database
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, admitted.run.id));
    const browser = operations
      .filter((row) => row.kind === "browser_command")
      .map((row) => browserCommandRecord.parse(row.result));
    expect(browser).toHaveLength(1);
    expect(browser[0]).toMatchObject({
      workRef: first.id,
      brokerAccountId: account.id,
    });
    expect(browser[0]?.page).toBeUndefined();
    const command = browser[0]!.command;
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const brokerState = async () =>
      (
        await peer.fetch("https://queue.test/broker-state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            vendorAccountId: account.id,
            runId: admitted.run.id,
            commandId: command.id,
          }),
        })
      ).json();
    const beforeBroker = await brokerState();
    expect(beforeBroker).toMatchObject({
      connected: false,
      result: null,
      pending: [{ requestId: command.id, createdAt: expect.any(Number) }],
    });
    boundaries.push({
      boundary:
        "Two public task observations before supported writes while Mac stays disconnected",
      result: true,
    });
    expect(await runtime.violations()).toEqual([]);
    await runtime.release("offline-public-evidence-verified");
    await waitFor(
      async () =>
        (
          await database.select().from(run).where(eq(run.id, admitted.run.id))
        )[0]?.status === "needs_review",
      "Public fallback did not commit supported facts and settle its remaining gaps",
      15_000,
    );
    const persisted = await database.select().from(product);
    expect(
      persisted.find((item) => item.id === items[0]!.entityId)?.model,
    ).toBe("F17SB");
    expect(
      persisted.find((item) => item.id === items[1]!.entityId)?.model,
    ).toBe("L21SW");
    const facts = await factsForRun(admitted.run.id);
    expect(facts).toHaveLength(2);
    expect(
      facts.every((fact) => evidence.some((row) => row.id === fact.evidenceId)),
    ).toBe(true);
    const [settled] = await database
      .select()
      .from(run)
      .where(eq(run.id, admitted.run.id));
    expect(settled?.endedAt).not.toBeNull();
    expect(await brokerState()).toEqual(beforeBroker);
    const [retainedCommand] = await database
      .select({ result: runOperation.result })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, admitted.run.id),
          eq(runOperation.operationId, command.operationId),
        ),
      );
    expect(
      JSON.stringify(
        browserCommandRecord.parse(retainedCommand?.result).command,
      ),
    ).toBe(JSON.stringify(command));
    expect(await runtime.violations()).toEqual([]);
    boundaries.push({
      boundary:
        "Evidence-supported model writes without browser wake, queued command preserved and gaps reported honestly",
      result: true,
    });
    status = "passed";
  });
});
