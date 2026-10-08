import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  run,
  runEvidence,
  runOperation,
  runTarget,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { browserCommandRecord } from "./browser-results";
import {
  capturedHtml,
  failedCommand,
  scriptedBroker,
  testBrowserPorts,
} from "./browser.fixtures";
import {
  acknowledgeResearchBrowserObservation,
  readPendingBrowserWork,
  researchBrowserFor,
} from "./research-browser-service";
import { researchServiceFor } from "./research-service";
import { reconcileSettledRun } from "./run-service";

// Failures: borrowed transport changes source ownership; reconnect/replay repeats
// a mutation; a stale or foreign target's control becomes actionable; a forged
// result binds evidence; failed durable submission loses an observation or
// premature acknowledgement lets Next complete; interrupted actions are re-clicked;
// a delivered observation's action races the host's durable-submit acknowledgement.
describe("research browser host", () => {
  const ctx = withTestDb();
  async function fixture(connected = true) {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic browser member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic browser shop",
      website: "https://shop.example.test",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic browser account",
      vendorId: seller.id,
      ledgerPartyId: member.id,
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "running",
    });
    const targets = await Promise.all(
      ["First", "Second"].map(async (name) => {
        const item = await insertWithShortcode(ctx.db, "product", {
          name: `Synthetic ${name} shirt`,
          manufacturer: "Synthetic maker",
        });
        const [target] = await getDb(ctx.db)
          .insert(runTarget)
          .values({
            runId,
            entityId: item.id,
            entityKind: "product",
            workKey: item.id,
            state: "pending",
            targetFingerprint: name,
          })
          .returning();
        if (!target) throw new Error("Synthetic target unavailable");
        return target;
      }),
    );
    const [first, second] = targets;
    if (!first || !second) throw new Error("Synthetic targets unavailable");
    await getDb(ctx.db)
      .update(run)
      .set({
        input: productResearchRunInput.parse({
          kind: "product_research",
          instructionRevision: 1,
          products: await Promise.all(
            targets.map(async (target) => ({
              productId: target.entityId,
              contextFingerprint: await sha256Hex(target.targetFingerprint),
            })),
          ),
        }),
      })
      .where(eq(run.id, runId));
    const outcomes = new Map<string, BrowserBridgeResult["outcome"]>();
    const bridge = scriptedBroker(
      (command) => outcomes.get(command.id) ?? null,
    );
    const stub = bridge.namespace.getByName();
    stub.connected = async () => connected;
    const env = {
      PURCHASE_IMPORT: bridge.namespace,
      R2_KEY_PREFIX: "synthetic",
    };
    const ports = testBrowserPorts();
    const service = researchBrowserFor(ctx.db, env, runId, ports);
    const signal = (command: BrowserBridgeRequest) => ({
      type: "purchase-import.browser_result",
      attributes: { eventId: `browser-result:${command.id}` },
      body: JSON.stringify({
        version: 1,
        type: "browser_result",
        commandId: command.id,
        eventId: `browser-result:${command.id}`,
      }),
    });
    const latest = () => {
      const command = bridge.issued.at(-1);
      if (!command) throw new Error("Synthetic command unavailable");
      return command;
    };
    const completed = async (
      workRef = second.id,
      sourceURL = "https://shop.example.test/shirt?variant=green",
    ) => {
      await service.observe(
        {
          workRef,
          action: { kind: "navigate", url: "https://shop.example.test/shirt" },
        },
        crypto.randomUUID(),
      );
      const command = latest();
      const outcome = await capturedHtml({
        sourceURL,
        title: "Synthetic green shirt",
        html: "<p>Selected green shirt</p>",
      });
      if (outcome.status !== "completed" || !outcome.snapshot)
        throw new Error("Synthetic snapshot unavailable");
      outcome.snapshot.actions = [
        { ref: "color", kind: "select", label: "Color", disabled: false },
        {
          ref: "green",
          kind: "option",
          parentRef: "color",
          label: "Green",
          selected: true,
          disabled: false,
        },
      ];
      outcomes.set(command.id, outcome);
      const event = signal(command);
      const observed = await service.resume(event);
      return { command, outcome, event, observed, snapshot: outcome.snapshot };
    };
    return {
      account,
      runId,
      first,
      second,
      service,
      outcomes,
      bridge,
      env,
      ports,
      latest,
      signal,
      completed,
    };
  }

  it("persists an offline command before enqueue and freezes its work and transport on replay", async () => {
    const f = await fixture(false);
    const callId = crypto.randomUUID();
    const input = {
      workRef: f.second.id,
      action: {
        kind: "navigate" as const,
        url: "https://shop.example.test/shirt",
      },
    };
    const broker = f.env.PURCHASE_IMPORT.getByName();
    const enqueue = broker.enqueue;
    broker.enqueue = async (command) => {
      const [stored] = await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, f.runId));
      expect(stored?.result).toMatchObject({
        commandId: command.id,
        workRef: f.second.id,
        brokerAccountId: f.account.id,
      });
      await enqueue(command);
    };
    await expect(f.service.observe(input, callId)).resolves.toMatchObject({
      status: "browser_pending",
      workRef: f.second.id,
      reason: "offline",
    });
    const [scope] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.runId));
    expect(scope?.vendorAccountId).toBeNull();
    expect(scope?.status).toBe("running");
    const [record] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, f.runId));
    expect(record?.result).toMatchObject({
      workRef: f.second.id,
      brokerAccountId: f.account.id,
      commandId: f.latest().id,
    });
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([
      f.second.id,
    ]);
    await f.service.observe(input, callId);
    expect(f.bridge.issued).toHaveLength(1);
    await expect(
      f.service.observe({ ...input, workRef: f.first.id }, callId),
    ).rejects.toThrow(/replay|different|rebound/u);
    expect(f.bridge.issued).toHaveLength(1);
  });

  it("keeps offline browser work queued while selecting another cloud task and retaining a public fallback under the original work", async () => {
    const f = await fixture(false);
    await getDb(ctx.db)
      .update(runTarget)
      .set({ createdAt: new Date("2026-09-01T00:00:00Z") })
      .where(eq(runTarget.id, f.first.id));
    await getDb(ctx.db)
      .update(runTarget)
      .set({ createdAt: new Date("2026-09-02T00:00:00Z") })
      .where(eq(runTarget.id, f.second.id));
    const services = researchServiceFor(
      ctx.db,
      fromPartial<Env>(f.env),
      f.runId,
      {
        observations: {
          ...f.ports,
          fetchPage: async () => ({
            status: "fetched",
            url: "https://maker.example.test/shirt",
            durationMs: 1,
            html: "<h1>Synthetic First shirt</h1><p>Manufacturer: Synthetic maker. Model: SHIRT-GREEN.</p>",
          }),
        },
      },
    );
    const callId = crypto.randomUUID();
    const input = {
      workRef: f.first.id,
      action: {
        kind: "navigate" as const,
        url: "https://shop.example.test/shirt",
      },
    };
    expect(await services.researchObserve(input, callId)).toMatchObject({
      status: "browser_pending",
      workRef: f.first.id,
      reason: "offline",
    });
    expect(await services.researchNext({}, crypto.randomUUID())).toMatchObject({
      status: "working",
      work: { workRef: f.second.id, kind: "product" },
    });
    const fallback = await services.researchWebRead(
      { workRef: f.first.id, url: "https://maker.example.test/shirt" },
      crypto.randomUUID(),
    );
    expect(fallback).toMatchObject({
      observation: { readableText: expect.stringContaining("SHIRT-GREEN") },
    });
    const [retained] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, f.runId));
    expect(retained).toMatchObject({
      targetId: f.first.id,
      kind: "web_page",
    });
    await services.researchObserve(input, callId);
    expect(f.bridge.issued).toHaveLength(1);
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([f.first.id]);
    const [scope] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.runId));
    expect(scope?.status).toBe("running");
  });

  it.each([
    { availability: "offline", connected: false, expected: "paused_offline" },
    { availability: "connected", connected: true, expected: "running" },
    {
      availability: "cached observation",
      connected: false,
      expected: "running",
    },
  ])(
    "waits without completing pending tasks and reports $availability availability honestly",
    async ({ availability, connected, expected }) => {
      const f = await fixture(connected);
      const services = researchServiceFor(
        ctx.db,
        fromPartial<Env>(f.env),
        f.runId,
        { observations: f.ports },
      );
      if (availability === "cached observation") await f.completed(f.first.id);
      else
        await f.service.observe(
          {
            workRef: f.first.id,
            action: {
              kind: "navigate",
              url: "https://shop.example.test/shirt",
            },
          },
          crypto.randomUUID(),
        );
      await f.service.observe(
        {
          workRef: f.second.id,
          action: { kind: "navigate", url: "https://shop.example.test/shirt" },
        },
        crypto.randomUUID(),
      );
      const next = await services.researchNext({}, crypto.randomUUID());
      const pendingWorkRefs = expect.arrayContaining([f.first.id, f.second.id]);
      const expectedNext =
        availability === "cached observation"
          ? {
              status: "working",
              work: {
                workRef: f.first.id,
                retainedObservation: {
                  observation: {
                    actions: [{ ref: "color" }, { selected: true }],
                  },
                },
              },
            }
          : {
              status: "waiting",
              reason: "browser",
              workRefs: pendingWorkRefs,
            };
      expect(next).toMatchObject(expectedNext);
      const [scope] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, f.runId));
      expect(scope?.status).toBe(expected);
      expect(scope?.endedAt).toBeNull();
      const targets = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, f.runId));
      expect(targets.every((target) => target.state === "pending")).toBe(true);
      expect(f.bridge.issued).toHaveLength(2);
    },
  );

  it.each(["settled work", "stopped Run", "retired Run"])(
    "returns a stop instead of replaying a cached observation after %s",
    async (fence) => {
      const f = await fixture();
      const base = await f.completed(f.first.id);
      if (fence === "settled work")
        await getDb(ctx.db)
          .update(runTarget)
          .set({ state: "unresolved", outcome: "researched_with_gaps" })
          .where(eq(runTarget.id, f.first.id));
      else
        await getDb(ctx.db)
          .update(run)
          .set(
            fence === "retired Run"
              ? { retiredAt: new Date(), retirementReason: "unrelated_source" }
              : { status: "needs_review" },
          )
          .where(eq(run.id, f.runId));
      expect(await f.service.resume(base.event)).toMatchObject({
        status: "stopped",
      });
      expect(
        await f.service.observe(
          {
            workRef: f.first.id,
            action: {
              kind: "navigate",
              url: "https://shop.example.test/shirt",
            },
          },
          base.command.operationId,
        ),
      ).toMatchObject({ status: "stopped" });
      expect(f.bridge.issued).toHaveLength(1);
      expect(f.ports.objects.size).toBe(1);
    },
  );

  it("keeps a closed task's queued command immutable without re-enqueue on reconnect", async () => {
    const f = await fixture(false);
    const broker = f.env.PURCHASE_IMPORT.getByName();
    const enqueue = broker.enqueue;
    let deliveries = 0;
    broker.enqueue = async (command) => {
      deliveries += 1;
      await enqueue(command);
    };
    await f.service.observe(
      {
        workRef: f.first.id,
        action: { kind: "navigate", url: "https://shop.example.test/shirt" },
      },
      crypto.randomUUID(),
    );
    const command = f.latest();
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "unresolved", outcome: "researched_with_gaps" })
      .where(eq(runTarget.id, f.first.id));
    broker.connected = async () => true;
    const eventId = crypto.randomUUID();
    await f.service.resume({
      type: "purchase-import.browser_connected",
      attributes: { eventId },
      body: JSON.stringify({ eventId }),
    });
    expect(deliveries).toBe(1);
    expect(f.bridge.issued).toEqual([command]);
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([]);
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, f.runId));
    expect(stored?.result).toMatchObject({
      commandId: command.id,
      command,
      workRef: f.first.id,
    });
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.first.id));
    expect(target).toMatchObject({
      state: "unresolved",
      outcome: "researched_with_gaps",
    });
  });

  it("retains selected source evidence through failed submit and acknowledges only its durable receipt", async () => {
    const f = await fixture();
    const result = await f.completed();
    expect(result.observed).toMatchObject({
      workRef: f.second.id,
      observation: {
        servedURL: "https://shop.example.test/shirt?variant=green",
        actions: [{ ref: "color" }, { selected: true }],
      },
    });
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([
      f.second.id,
    ]);
    expect(await f.service.resume(result.event)).toEqual(result.observed);
    expect(f.ports.objects.size).toBe(1);
    const [evidence] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, f.runId));
    expect(evidence?.targetId).toBe(f.second.id);
    expect(evidence?.sourceMetadata).toMatchObject({
      brokerAccountId: f.account.id,
    });
    const [cached] = await getDb(ctx.db)
      .select({ result: runOperation.result })
      .from(runOperation)
      .where(eq(runOperation.operationId, result.command.operationId));
    await acknowledgeResearchBrowserObservation(ctx.db, f.runId, result.event);
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([]);
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed" })
      .where(eq(runTarget.id, f.second.id));
    await acknowledgeResearchBrowserObservation(ctx.db, f.runId, result.event);
    expect(await f.service.resume(result.event)).toMatchObject({
      status: "stopped",
      reason: "work_settled",
    });
    const [stored] = await getDb(ctx.db)
      .select({ result: runOperation.result })
      .from(runOperation)
      .where(eq(runOperation.operationId, result.command.operationId));
    expect(stored?.result).toMatchObject({
      observationDelivered: true,
    });
    expect(browserCommandRecord.parse(stored?.result).page).toEqual(
      browserCommandRecord.parse(cached?.result).page,
    );
  });

  it("offers a bound cached observation to Next before SDK acknowledgement and keeps settlement fenced until acknowledgement", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(run)
      .set({
        agentSessionId: importRunAgentIdentity(f.runId, "product_enrichment"),
      })
      .where(eq(run.id, f.runId));
    const base = await f.completed(f.first.id);
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "unresolved" })
      .where(eq(runTarget.id, f.second.id));
    const [record] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.operationId, base.command.operationId));
    const retained = browserCommandRecord.parse(record?.result).page?.research;
    if (!retained)
      throw new Error("Synthetic retained observation unavailable");
    const services = researchServiceFor(
      ctx.db,
      fromPartial<Env>(f.env),
      f.runId,
      { observations: f.ports },
    );
    expect(await services.researchNext({}, crypto.randomUUID())).toMatchObject({
      status: "working",
      work: { workRef: f.first.id, retainedObservation: retained },
    });
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([f.first.id]);
    const receivedEventIds = new Set([base.event.attributes.eventId]);
    expect(
      await reconcileSettledRun(ctx.db, f.env.PURCHASE_IMPORT, {
        runId: f.runId,
        operationId: crypto.randomUUID(),
        receivedEventIds,
      }),
    ).toEqual({ reconciled: false, status: "running" });
    await services.researchAcknowledge(base.event);
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([]);
    // If the model now ends without resolving this task, ordinary review
    // applies; the delivery fence must not retain a phantom browser wait.
    expect(
      await reconcileSettledRun(ctx.db, f.env.PURCHASE_IMPORT, {
        runId: f.runId,
        operationId: crypto.randomUUID(),
        receivedEventIds,
      }),
    ).toEqual({ reconciled: true, status: "needs_review" });
    expect(f.bridge.issued).toHaveLength(1);
    expect(f.ports.objects.size).toBe(1);
  });

  it.each(["unanswered command", "unreceived result"])(
    "keeps borrowed-browser %s in flight when the Run has no vendor account",
    async (phase) => {
      const f = await fixture();
      await getDb(ctx.db)
        .update(run)
        .set({
          agentSessionId: importRunAgentIdentity(f.runId, "product_enrichment"),
        })
        .where(eq(run.id, f.runId));
      await f.service.observe(
        {
          workRef: f.first.id,
          action: { kind: "navigate", url: "https://shop.example.test/shirt" },
        },
        crypto.randomUUID(),
      );
      const command = f.latest();
      if (phase === "unreceived result")
        f.outcomes.set(
          command.id,
          await capturedHtml({
            sourceURL: "https://shop.example.test/shirt",
            title: "Synthetic shirt",
            html: "<p>Synthetic green shirt</p>",
          }),
        );
      const accounts: string[] = [];
      const namespace = {
        getByName: (id: string) => {
          accounts.push(id);
          return {
            ...f.env.PURCHASE_IMPORT.getByName(),
            pendingCommands: async () =>
              phase === "unanswered command"
                ? [{ requestId: command.id, createdAt: Date.now() }]
                : [],
          };
        },
      };
      const [scope] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, f.runId));
      expect(scope?.vendorAccountId).toBeNull();
      expect(
        await reconcileSettledRun(ctx.db, namespace, {
          runId: f.runId,
          operationId: crypto.randomUUID(),
          receivedEventIds: new Set(),
        }),
      ).toEqual({ reconciled: false, status: "running" });
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts.every((id) => id === f.account.id)).toBe(true);
      expect(f.bridge.issued).toHaveLength(1);
    },
  );

  it("admits an exact observed control before delivery acknowledgement without admitting another in-flight action", async () => {
    const f = await fixture();
    const completed = await f.completed();
    const action = {
      kind: "select" as const,
      observationId: completed.snapshot.observationId,
      ref: "color",
      optionRef: "green",
    };
    const input = { workRef: f.second.id, action };
    const callId = crypto.randomUUID();
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([
      f.second.id,
    ]);
    for (const unobserved of [
      { kind: "read" as const },
      { kind: "navigate" as const, url: "https://shop.example.test/shirt" },
      { ...action, observationId: crypto.randomUUID() },
    ])
      await expect(
        f.service.observe(
          { workRef: f.second.id, action: unobserved },
          crypto.randomUUID(),
        ),
      ).rejects.toThrow(/in flight|observation/u);
    expect(f.bridge.issued).toHaveLength(1);
    await expect(f.service.observe(input, callId)).resolves.toMatchObject({
      status: "waiting",
      workRef: f.second.id,
    });
    expect(f.bridge.issued).toHaveLength(2);
    await f.service.observe(input, callId);
    expect(f.bridge.issued).toHaveLength(2);
    await expect(f.service.observe(input, crypto.randomUUID())).rejects.toThrow(
      /in flight/u,
    );
    const [original] = await getDb(ctx.db)
      .select({ result: runOperation.result })
      .from(runOperation)
      .where(eq(runOperation.operationId, completed.command.operationId));
    expect(original?.result).not.toHaveProperty("observationDelivered", true);
    await acknowledgeResearchBrowserObservation(
      ctx.db,
      f.runId,
      completed.event,
    );
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([
      f.second.id,
    ]);
    expect(await f.service.resume(completed.event)).toEqual(completed.observed);
    expect(f.ports.objects.size).toBe(1);
  });

  it("refuses implicit first reads and stale or other-work controls before enqueue", async () => {
    const f = await fixture();
    await expect(
      f.service.observe(
        { workRef: f.second.id, action: { kind: "read" } },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/navigate|source/u);
    const completed = await f.completed();
    await acknowledgeResearchBrowserObservation(
      ctx.db,
      f.runId,
      completed.event,
    );
    const observationId = completed.snapshot.observationId;
    await expect(
      f.service.observe(
        {
          workRef: f.first.id,
          action: {
            kind: "select",
            observationId,
            ref: "color",
            optionRef: "green",
          },
        },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/observation|source/u);
    await expect(
      f.service.observe(
        {
          workRef: f.second.id,
          action: {
            kind: "select",
            observationId: crypto.randomUUID(),
            ref: "color",
            optionRef: "green",
          },
        },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/observation/u);
    expect(f.bridge.issued).toHaveLength(1);
  });

  it("refuses a broker result for another command without creating evidence", async () => {
    const f = await fixture();
    await f.service.observe(
      {
        workRef: f.second.id,
        action: { kind: "navigate", url: "https://shop.example.test/shirt" },
      },
      crypto.randomUUID(),
    );
    const command = f.latest();
    const broker = f.env.PURCHASE_IMPORT.getByName();
    broker.result = async () => ({
      protocolVersion: 4,
      commandID: crypto.randomUUID(),
      operationID: command.operationId,
      runID: f.runId,
      completedAt: new Date().toISOString(),
      outcome: await capturedHtml({
        sourceURL: "https://shop.example.test/shirt",
        title: "Synthetic",
        html: "<p>Forged</p>",
      }),
    });
    await expect(f.service.resume(f.signal(command))).rejects.toThrow(
      /command|belong/u,
    );
    expect(f.ports.objects.size).toBe(0);
  });

  it("reconciles an interrupted variant action by reading instead of re-clicking", async () => {
    const f = await fixture();
    const base = await f.completed();
    await acknowledgeResearchBrowserObservation(ctx.db, f.runId, base.event);
    await f.service.observe(
      {
        workRef: f.second.id,
        action: {
          kind: "select",
          observationId: base.snapshot.observationId,
          ref: "color",
          optionRef: "green",
        },
      },
      crypto.randomUUID(),
    );
    const selection = f.latest();
    f.outcomes.set(selection.id, failedCommand("action_outcome_unknown"));
    expect(await f.service.resume(f.signal(selection))).toMatchObject({
      status: "waiting",
      workRef: f.second.id,
      reason: "browser",
    });
    expect(f.latest().operation.type).toBe("read");
    expect(
      f.bridge.issued.filter((command) => command.operation.type === "select"),
    ).toHaveLength(1);
    await f.service.resume(f.signal(selection));
    expect(f.bridge.issued).toHaveLength(3);
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([
      f.second.id,
    ]);
  });

  it("retains a selected fragment as the same-work source when issuing a fresh read", async () => {
    const f = await fixture();
    const sourceURL = "https://shop.example.test/shirt#color=green";
    const base = await f.completed(f.second.id, sourceURL);
    expect(base.observed).toMatchObject({
      workRef: f.second.id,
      observation: {
        servedURL: sourceURL,
        actions: [{ label: "Color" }, { label: "Green", selected: true }],
      },
    });
    await acknowledgeResearchBrowserObservation(ctx.db, f.runId, base.event);
    await expect(
      f.service.observe(
        { workRef: f.second.id, action: { kind: "read" } },
        crypto.randomUUID(),
      ),
    ).resolves.toMatchObject({ status: "waiting", workRef: f.second.id });
    expect(f.latest().operation).toMatchObject({
      type: "read",
      recoveryURL: sourceURL,
      allowedHosts: ["shop.example.test"],
    });
  });
  it("replays an outdated-client stop without waiting or issuing more browser work", async () => {
    const f = await fixture();
    const callId = crypto.randomUUID();
    const input = {
      workRef: f.second.id,
      action: {
        kind: "navigate" as const,
        url: "https://shop.example.test/shirt",
      },
    };
    await f.service.observe(input, callId);
    const command = f.latest();
    f.outcomes.set(command.id, failedCommand("client_update_required"));
    const stopped = await f.service.resume(f.signal(command));
    expect(stopped).toMatchObject({
      status: "stopped",
      reason: "client_update_required",
    });
    expect(await f.service.resume(f.signal(command))).toEqual(stopped);
    expect(await f.service.observe(input, callId)).toEqual(stopped);
    expect(f.bridge.issued).toHaveLength(1);
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([]);
  });

  it.each([true, false])(
    "keeps an early native completion and durable receipt when enqueue returns late (initial connection: %s)",
    async (connected) => {
      const f = await fixture(connected);
      const broker = f.env.PURCHASE_IMPORT.getByName();
      const enqueue = broker.enqueue;
      broker.enqueue = async (command) => {
        await enqueue(command);
        f.outcomes.set(
          command.id,
          await capturedHtml({
            sourceURL: "https://shop.example.test/shirt",
            title: "Synthetic shirt",
            html: "<p>Green shirt</p>",
          }),
        );
        await f.service.resume(f.signal(command));
        await acknowledgeResearchBrowserObservation(
          ctx.db,
          f.runId,
          f.signal(command),
        );
      };
      await f.service.observe(
        {
          workRef: f.second.id,
          action: { kind: "navigate", url: "https://shop.example.test/shirt" },
        },
        crypto.randomUUID(),
      );
      expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([]);
      const [stored] = await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, f.runId));
      expect(stored?.result).toMatchObject({
        observationDelivered: true,
        page: { research: { observation: { readableText: "Green shirt" } } },
      });
      const [scope] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, f.runId));
      expect(scope?.status).toBe("running");
    },
  );

  it("does not revive a terminal native failure when enqueue returns late", async () => {
    const f = await fixture();
    const broker = f.env.PURCHASE_IMPORT.getByName();
    const enqueue = broker.enqueue;
    broker.enqueue = async (command) => {
      await enqueue(command);
      f.outcomes.set(command.id, failedCommand("client_update_required"));
      await f.service.resume(f.signal(command));
    };
    await expect(
      f.service.observe(
        {
          workRef: f.second.id,
          action: { kind: "navigate", url: "https://shop.example.test/shirt" },
        },
        crypto.randomUUID(),
      ),
    ).resolves.toMatchObject({
      status: "stopped",
      reason: "client_update_required",
    });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, f.runId));
    expect(stored?.state).toBe("failed");
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([]);
  });

  it("binds newly available owned transport on the actual connection signal without unpausing authentication", async () => {
    const f = await fixture();
    const services = researchServiceFor(
      ctx.db,
      fromPartial<Env>(f.env),
      f.runId,
      { observations: f.ports },
    );
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ status: "disabled" })
      .where(eq(vendorAccount.id, f.account.id));
    await f.service.observe(
      {
        workRef: f.second.id,
        action: { kind: "navigate", url: "https://shop.example.test/shirt" },
      },
      crypto.randomUUID(),
    );
    expect(f.bridge.issued).toHaveLength(0);
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ status: f.account.status })
      .where(eq(vendorAccount.id, f.account.id));
    const eventId = crypto.randomUUID();
    const connected = {
      type: "purchase-import.browser_connected",
      attributes: { eventId },
      body: JSON.stringify({ eventId }),
    };
    await services.researchResume(connected);
    expect(f.bridge.issued).toHaveLength(1);
    await services.researchResume(connected);
    expect(f.bridge.issued).toHaveLength(1);
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, f.runId));
    expect(stored?.result).toMatchObject({
      brokerAccountId: f.account.id,
      workRef: f.second.id,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused_auth" })
      .where(eq(run.id, f.runId));
    await services.researchResume(connected);
    const [scope] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.runId));
    expect(scope?.status).toBe("paused_auth");
    expect(f.bridge.issued).toHaveLength(1);
  });

  it("recovers an observed sign-in page only after authorized resume and never resends navigation", async () => {
    const f = await fixture();
    const services = researchServiceFor(
      ctx.db,
      fromPartial<Env>(f.env),
      f.runId,
      { observations: f.ports },
    );
    await f.service.observe(
      {
        workRef: f.second.id,
        action: { kind: "navigate", url: "https://shop.example.test/shirt" },
      },
      crypto.randomUUID(),
    );
    const original = f.latest();
    f.outcomes.set(
      original.id,
      await capturedHtml({
        sourceURL: "https://shop.example.test/sign-in",
        title: "Synthetic sign-in",
        html: '<form><input type="password">Sign in</form>',
      }),
    );
    expect(await f.service.resume(f.signal(original))).toMatchObject({
      status: "waiting",
      workRef: f.second.id,
    });
    expect(f.bridge.authenticationRequests).toEqual([f.runId]);
    const [paused] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.runId));
    expect(paused?.status).toBe("paused_auth");
    const eventId = crypto.randomUUID();
    const authorized = {
      type: "purchase-import.start_or_resume",
      attributes: { eventId },
      body: JSON.stringify({ version: 1, type: "start_or_resume", eventId }),
    };
    await services.researchResume(authorized);
    expect(f.bridge.issued).toHaveLength(1);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "running" })
      .where(eq(run.id, f.runId));
    await services.researchResume(authorized);
    expect(f.latest().operation).toMatchObject({
      type: "read",
      recoveryURL: "https://shop.example.test/shirt",
    });
    expect(f.bridge.issued).toHaveLength(2);
    await services.researchResume(authorized);
    expect(f.bridge.issued).toHaveLength(2);
    const reconciled = f.latest();
    f.outcomes.set(
      reconciled.id,
      await capturedHtml({
        sourceURL: "https://shop.example.test/shirt?variant=green",
        title: "Synthetic green",
        html: "<p>Selected green shirt</p>",
      }),
    );
    expect(await f.service.resume(f.signal(reconciled))).toMatchObject({
      workRef: f.second.id,
      observation: { authenticationRequired: false },
    });
    await acknowledgeResearchBrowserObservation(
      ctx.db,
      f.runId,
      f.signal(reconciled),
    );
    expect(await readPendingBrowserWork(ctx.db, f.runId)).toEqual([]);
  });
});
