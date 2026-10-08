import {
  executionAuthorizationInput,
  type ExecutionAuthorizationInput,
} from "@cubby/schemas/execution-authorization";
/** Plausible failures: baseline capture follows listing; pages checkpoint before
 * source/research dispatch; interrupted pages duplicate sources; retries replay a
 * changed manifest; revoked auth becomes negative; stale attempts move coverage;
 * bounded passes wait a day instead of scheduling the next durable pass;
 * scheduled connection starts unapproved historical scans; a newer approval
 * shadows another scope; scan/history descendants spend the wrong allowance;
 * revocation revives an older grant or starves another mailbox. */
import { runEntityId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { retainedResearchObservation } from "@cubby/schemas/research";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  mailboxCursor,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  expense,
  purchase,
  run,
  runTarget,
  runProgress,
  runFinding,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  issueExecutionAuthorization,
  revokeExecutionAuthorization,
} from "~/server/runs/execution-authorization";
import type { WorkflowLauncher } from "~/server/workflow-runs/launcher";
import { launchWorkflowRun } from "~/server/workflow-runs/lifecycle";

import { resolveImportResearch } from "../research-import";
import { startMailResearch } from "../research-run";
import { researchServiceFor } from "../research-service";
import {
  startMailDiscovery,
  listMailDiscovery,
  saveMailDiscoveryBatch,
  finishMailDiscovery,
  continueMailDiscovery,
  pruneRoutineRuns,
  type DiscoveryPorts,
} from "./discovery";
import { GmailAuthorizationError } from "./tokens";
import type { GmailProvider } from "./types";

const gmail = (overrides: Partial<GmailProvider> = {}): GmailProvider => ({
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({
    messages: [{ id: "source-one" }],
    nextPageToken: "page-two",
  }),
  getMessage: async (id) => ({
    id,
    internalDate: "1788220800000",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "shared@example.test" }],
      body: {
        data: Buffer.from("Your service subscription renewed").toString(
          "base64url",
        ),
      },
    },
  }),
  listHistory: async () => ({ historyId: "110" }),
  getAttachment: async () => ({}),
  ...overrides,
});
const recorder = () => {
  const created: { runId: string; attempt: number }[] = [];
  const launcher: WorkflowLauncher = {
    create: async (_purpose, _id, params) => {
      created.push(params);
    },
    terminate: async () => undefined,
    status: async () => ({ state: "running", error: null }),
  };
  return { launcher, created };
};

describe("scheduled Gmail discovery", () => {
  const ctx = withTestDb();
  const seed = async (
    authorization: "backfill" | "continuous" | false = "backfill",
  ) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic discovery member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-google-subject",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const launch = recorder();
    if (authorization)
      await issueExecutionAuthorization(
        ctx.db,
        ctx.actor,
        executionAuthorizationInput.parse({
          kind: "execution_authorization",
          version: 1,
          owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
          scope: {
            kind: authorization,
            mailboxId: "synthetic-google-subject",
            discovery:
              authorization === "continuous" ? "new_mail" : "all_history",
          },
          meteredBudget: {
            period:
              authorization === "continuous"
                ? "utc_calendar_month"
                : "lifetime",
            limitMicroUSD: 1_000_000,
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
    await startMailDiscovery(ctx.db, launch);
    const params = launch.created[0];
    if (!params) throw new Error("Synthetic discovery not launched");
    return { party, ...launch, params };
  };
  const readRun = async (id: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(id)));
    if (!row) throw new Error("Synthetic run missing");
    return row;
  };
  const ports = (provider: GmailProvider): DiscoveryPorts => ({
    providerForUser: async () => provider,
    triage: async () => "related",
    relevance: async () => ({ classification: "related" }),
    storage: {
      put: async () => undefined,
      get: async () => new Uint8Array(),
      delete: async () => undefined,
    },
    research: async () => [],
  });
  const approve = (
    partyId: ExecutionAuthorizationInput["owner"]["ledgerPartyId"],
    scope: ExecutionAuthorizationInput["scope"],
  ) =>
    issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse({
        kind: "execution_authorization",
        version: 1,
        owner: { userId: ctx.actor.userId, ledgerPartyId: partyId },
        scope,
        meteredBudget: {
          period:
            scope.kind === "continuous" ? "utc_calendar_month" : "lifetime",
          limitMicroUSD: 1_000_000,
        },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  const baselineForAllowances = async () => {
    const state = await seed(false);
    const seam = ports(gmail());
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    await finishMailDiscovery(ctx.db, state.params);
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic priority vendor",
    });
    return state;
  };

  it("keeps targeted, incremental and broad discovery pages and research children on independent allowances", async () => {
    const state = await baselineForAllowances();
    const mailboxId = "synthetic-google-subject";
    const pilot = await approve(state.party.id, {
      kind: "pilot",
      mailboxId,
      discovery: "targeted",
      candidateLimit: 2,
      productLimit: 2,
    });
    const backfill = await approve(state.party.id, {
      kind: "backfill",
      mailboxId,
      discovery: "all_history",
    });
    const continuous = await approve(state.party.id, {
      kind: "continuous",
      mailboxId,
      discovery: "new_mail",
    });
    const queries: string[] = [];
    const historyStarts: string[] = [];
    const provider = gmail({
      listMessages: async ({ query }) => {
        queries.push(query);
        return {
          messages: [
            {
              id: query.includes("Synthetic priority vendor")
                ? "synthetic-targeted-original"
                : "synthetic-broad-original",
            },
          ],
        };
      },
      listHistory: async ({ startHistoryId }) => {
        historyStarts.push(startHistoryId);
        return {
          historyId: "130",
          history: [
            {
              id: "120",
              messagesAdded: [
                { message: { id: "synthetic-incremental-original" } },
              ],
            },
          ],
        };
      },
    });
    const events: PurchaseAgentEvent[] = [];
    const seam: DiscoveryPorts = {
      ...ports(provider),
      research: (db, input) =>
        startMailResearch(db, input, {
          send: async (event) => {
            events.push(event);
          },
        }),
    };
    await startMailDiscovery(ctx.db, state);
    const phases = [
      { allowance: pilot, historyId: "110", broadCompleted: false },
      { allowance: continuous, historyId: "130", broadCompleted: false },
      { allowance: backfill, historyId: "130", broadCompleted: true },
    ];
    for (const [index, expected] of phases.entries()) {
      const params = state.created[index + 1];
      if (!params) throw new Error("Synthetic allowance pass not launched");
      expect((await readRun(params.runId)).input).toMatchObject({
        executionAuthorization: expected.allowance,
      });
      await listMailDiscovery(ctx.db, params, seam);
      await saveMailDiscoveryBatch(ctx.db, params, 0, seam);
      const [cursor] = await getDb(ctx.db).select().from(mailboxCursor);
      expect(cursor?.coverage).toMatchObject({
        baselineHistoryId: "100",
        broad: { pageToken: null, completed: expected.broadCompleted },
        history: { historyId: expected.historyId, pageToken: null },
        scoped: [{ completed: true, pageToken: null }],
      });
      const children = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.parentRunId, runEntityId.parse(params.runId)));
      expect(children).toMatchObject([
        { input: { executionAuthorization: expected.allowance } },
      ]);
      await finishMailDiscovery(ctx.db, params);
      if (index < phases.length - 1) {
        await continueMailDiscovery(ctx.db, params, state);
        await continueMailDiscovery(ctx.db, params, state);
      }
    }
    expect(state.created).toHaveLength(4);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("Synthetic priority vendor");
    expect(queries[0]).toContain("-in:spam -in:trash");
    expect(queries[1]).toBe("-in:spam -in:trash");
    expect(historyStarts).toEqual(["110"]);
    expect(events).toHaveLength(3);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(3);
  });

  it("does not revive a revoked newest pilot or let it block continuous allowances in either mailbox", async () => {
    const state = await baselineForAllowances();
    const mailboxId = "synthetic-google-subject";
    await approve(state.party.id, {
      kind: "pilot",
      mailboxId,
      discovery: "targeted",
      candidateLimit: 2,
      productLimit: 2,
    });
    const continuous = await approve(state.party.id, {
      kind: "continuous",
      mailboxId,
      discovery: "new_mail",
    });
    const revoked = await approve(state.party.id, {
      kind: "pilot",
      mailboxId,
      discovery: "targeted",
      candidateLimit: 2,
      productLimit: 2,
    });
    await revokeExecutionAuthorization(ctx.db, ctx.actor, revoked);
    const otherMailbox = "synthetic-second-google-subject";
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: otherMailbox,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const otherContinuous = await approve(state.party.id, {
      kind: "continuous",
      mailboxId: otherMailbox,
      discovery: "new_mail",
    });
    expect(await startMailDiscovery(ctx.db, state)).toEqual({
      started: 2,
      running: 0,
    });
    const provider = gmail();
    const scan = vi.spyOn(provider, "listMessages");
    const history = vi.spyOn(provider, "listHistory");
    const seam = ports(provider);
    for (const params of state.created.slice(1)) {
      const row = await readRun(params.runId);
      const input = mailboxDiscoveryInput.parse(row.input);
      expect(input).toMatchObject({
        executionAuthorization:
          input.mailboxId === mailboxId ? continuous : otherContinuous,
      });
      await listMailDiscovery(ctx.db, params, seam);
      await saveMailDiscoveryBatch(ctx.db, params, 0, seam);
    }
    expect(scan).not.toHaveBeenCalled();
    expect(history).toHaveBeenCalledTimes(2);
    const cursors = await getDb(ctx.db).select().from(mailboxCursor);
    expect(cursors).toHaveLength(2);
    expect(cursors.every((row) => !row.coverage?.broad.completed)).toBe(true);
  });

  // A classifier's uncertainty must remain actionable after the page checkpoint;
  // otherwise an unfamiliar acquisition is lost without capable investigation.
  it("retains still-uncertain discovery mail for capable research and supported incomplete Purchase resolution", async () => {
    const state = await seed();
    const provider = gmail({
      getMessage: async (id) => ({
        id,
        internalDate: "1788220800000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "shared@platform.example.test" },
            { name: "Subject", value: "Synthetic unfamiliar notice" },
          ],
          body: {
            data: Buffer.from(
              "Synthetic uncertain merchant reports order SYNTHETIC-UNCERTAIN-ORDER. Itemization and purchase date are absent.",
            ).toString("base64url"),
          },
          parts: [
            {
              partId: "original",
              filename: "notice.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "synthetic-attachment", size: 3 },
            },
          ],
        },
      }),
      getAttachment: async () => ({
        data: Buffer.from("pdf").toString("base64url"),
      }),
    });
    const events: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const attachmentBytes = new Map<string, Uint8Array>();
    const seam: DiscoveryPorts = {
      ...ports(provider),
      storage: {
        put: async (key, bytes) => {
          attachmentBytes.set(key, bytes);
        },
        get: async (key) => {
          const bytes = attachmentBytes.get(key);
          if (!bytes) throw new Error("Synthetic attachment bytes missing");
          return bytes;
        },
        delete: async (key) => {
          attachmentBytes.delete(key);
        },
      },
      triage: async () => "uncertain",
      relevance: async () => ({ classification: "uncertain" }),
      research: (db, input) => startMailResearch(db, input, queue),
    };
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    const [original] = await getDb(ctx.db).select().from(orderMail);
    expect(original).toMatchObject({
      ledgerPartyId: state.party.id,
      mailboxId: "synthetic-google-subject",
      messageId: "source-one",
    });
    if (!original) throw new Error("Uncertain original was not retained");
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toHaveLength(
      1,
    );
    const [message] = await getDb(ctx.db).select().from(mailboxMessage);
    expect(message).toMatchObject({
      classification: "uncertain",
      status: "researching",
      orderMailId: original.id,
    });
    if (!message?.runId)
      throw new Error("Uncertain original has no research owner");
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, message.runId));
    if (!target) throw new Error("Uncertain original has no research task");
    expect(events).toHaveLength(1);
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.broad
        .pageToken,
    ).toBe("page-two");
    const retained = new Map<string, Uint8Array>();
    const services = researchServiceFor(
      ctx.db,
      fromPartial<Env>({ R2_KEY_PREFIX: "synthetic/uncertain-discovery" }),
      message.runId,
      {
        queue,
        observations: {
          storage: {
            put: async (key, bytes) => {
              retained.set(key, bytes);
            },
            get: async (key) => {
              const bytes = retained.get(key);
              if (!bytes)
                throw new Error("Synthetic observed original bytes missing");
              return new TextDecoder().decode(bytes);
            },
          },
        },
      },
    );
    expect(await services.researchNext({}, crypto.randomUUID())).toMatchObject({
      status: "working",
      work: {
        workRef: target.id,
        kind: "mail",
        sources: [{ messageRef: original.id }],
      },
    });
    const observed = retainedResearchObservation.parse(
      await services.researchMailRead(
        { workRef: target.id, messageRef: original.id },
        crypto.randomUUID(),
      ),
    );
    const proposal = researchWorkResolve.parse({
      workRef: target.id,
      status: "researched_with_gaps",
      identity: {
        evidenceIds: [observed.evidenceId],
        reasoning:
          "The retained original identifies this merchant and order; unknown itemization and date remain absent.",
      },
      orders: [
        {
          vendor: { name: "Synthetic uncertain merchant" },
          evidenceIds: [observed.evidenceId],
          reasoning:
            "The unfamiliar original explicitly identifies this actual order.",
          candidate: {
            orderId: "SYNTHETIC-UNCERTAIN-ORDER",
            orderedAt: null,
            merchant: "Synthetic uncertain merchant",
            currency: "USD",
            printedGrandTotal: null,
            lines: [],
            payments: [],
            allShipmentsDelivered: false,
          },
          productResolutions: [],
          defaultTrade: "other",
        },
      ],
      detail:
        "The original supports an incomplete Purchase; itemization, date and money remain unknown.",
    });
    const callId = crypto.randomUUID();
    const attachedSources: string[] = [];
    const result = await resolveImportResearch(
      ctx.db,
      { runId: message.runId, workRef: target.id, callId, proposal },
      {
        attachSource: async (db, input) => {
          const [attachment] = await getDb(db)
            .select()
            .from(orderMailAttachment)
            .where(eq(orderMailAttachment.orderMailId, input.orderMailId));
          if (!attachment?.pendingObjectKey)
            throw new Error("Synthetic retained attachment missing");
          expect(attachmentBytes.get(attachment.pendingObjectKey)).toEqual(
            Buffer.from("pdf"),
          );
          attachedSources.push(input.orderMailId);
        },
        readEvidence: async (row) => {
          const bytes = retained.get(row.objectKey);
          if (!bytes)
            throw new Error("Synthetic observed original bytes missing");
          return new TextDecoder().decode(bytes);
        },
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [0],
          acceptedEmailLinks: [],
          rejected: [],
        }),
      },
    );
    expect(result.purchaseIds).toHaveLength(1);
    expect(attachedSources).toEqual([original.id]);
    const {
      purchaseIds: _purchaseIds,
      productIds: _productIds,
      eventIds: _eventIds,
      ...publicResolution
    } = result;
    expect(await services.researchResolve(proposal, callId)).toMatchObject({
      status: "done",
      summary: { researchedWithGaps: 1 },
      resolution: publicResolution,
    });
    expect(await getDb(ctx.db).select().from(purchase)).toMatchObject([
      { orderId: "SYNTHETIC-UNCERTAIN-ORDER", date: null, statedTotal: null },
    ]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(await getDb(ctx.db).select().from(runTarget)).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("establishes new-mail coverage without scanning historical mail before backfill authorization", async () => {
    const state = await seed(false);
    const provider = gmail();
    const listMessages = vi.spyOn(provider, "listMessages");
    const listHistory = vi.spyOn(provider, "listHistory");
    const seam = ports(provider);
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(listMessages).not.toHaveBeenCalled();
    expect(listHistory).toHaveBeenCalledTimes(1);
    const [cursor] = await getDb(ctx.db).select().from(mailboxCursor);
    expect(cursor?.coverage?.broad).toEqual({
      pageToken: null,
      completed: false,
    });
    expect(cursor?.coverage?.history.historyId).toBe("110");
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(0);
    expect(await getDb(ctx.db).select().from(mailboxMessage)).toHaveLength(0);
  });

  it("starts one pass per connected mailbox and refuses an overlapping one", async () => {
    const state = await seed();
    expect(await startMailDiscovery(ctx.db, state)).toEqual({
      started: 0,
      running: 1,
    });
    expect((await readRun(state.params.runId)).input).toMatchObject({
      mailboxId: "synthetic-google-subject",
    });
  });
  it("does not starve a second connected mailbox belonging to the same member", async () => {
    const state = await seed();
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-second-google-subject",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    expect(await startMailDiscovery(ctx.db, state)).toEqual({
      started: 1,
      running: 1,
    });
    expect(state.created).toHaveLength(2);
    expect((await readRun(state.created[1]!.runId)).input).toMatchObject({
      mailboxId: "synthetic-second-google-subject",
    });
  });
  it("persists baseline before freezing only one page and checkpoints only after research dispatch", async () => {
    const state = await seed();
    let listed = 0;
    const provider = gmail({
      listMessages: async () => {
        listed += 1;
        const [cursor] = await getDb(ctx.db).select().from(mailboxCursor);
        expect(cursor?.coverage?.baselineHistoryId).toBe("100");
        return { messages: [{ id: "source-one" }], nextPageToken: "page-two" };
      },
    });
    const seam = ports(provider);
    const research = vi.fn(async () => {
      const [cursor] = await getDb(ctx.db).select().from(mailboxCursor);
      expect(cursor?.coverage?.broad.pageToken).toBeNull();
      return [];
    });
    seam.research = research;
    await listMailDiscovery(ctx.db, state.params, seam);
    expect(listed).toBe(1);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(research).toHaveBeenCalledTimes(1);
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.broad
        .pageToken,
    ).toBe("page-two");
    expect((await readRun(state.params.runId)).progress).not.toHaveProperty(
      "page",
    );
  });
  it("resumes a retried pass from its frozen page without listing again or duplicating original content", async () => {
    const state = await seed();
    const provider = gmail();
    let unavailable = true;
    const seam = ports(provider);
    seam.research = async () => {
      if (unavailable)
        return [{ runId: state.params.runId, status: "dispatch_failed" }];
      return [];
    };
    const listMessages = vi.spyOn(provider, "listMessages");
    await listMailDiscovery(ctx.db, state.params, seam);
    await expect(
      saveMailDiscoveryBatch(ctx.db, state.params, 0, seam),
    ).rejects.toThrow("Mail research dispatch failed");
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.broad
        .pageToken,
    ).toBeNull();
    unavailable = false;
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
  });
  it("dispatches expanded history records in bounded source sets and checkpoints after all sets", async () => {
    const state = await seed("continuous");
    const messages = Array.from({ length: 61 }, (_, index) => ({
      message: { id: `synthetic-history-${index}` },
    }));
    const provider = gmail({
      listMessages: async () => ({}),
      listHistory: async () => ({
        historyId: "120",
        history: [{ id: "119", messagesAdded: messages }],
      }),
    });
    const seam = ports(provider);
    const sizes: number[] = [];
    seam.research = async (_db, input) => {
      sizes.push(input.messageIds.length);
      if (input.messageIds.length > 50)
        throw new Error("Synthetic source set exceeds launcher bound");
      expect(
        (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.history
          .historyId,
      ).toBe("100");
      return [];
    };
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(sizes).toEqual([50, 11]);
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.history
        .historyId,
    ).toBe("120");
  });
  it("pauses revoked authentication without moving the page or negatively classifying it, then reconnects", async () => {
    const state = await seed();
    const provider = gmail({
      getMessage: async () => {
        throw new GmailAuthorizationError("Synthetic revoked authorization");
      },
    });
    await listMailDiscovery(ctx.db, state.params, ports(provider));
    expect(
      await saveMailDiscoveryBatch(ctx.db, state.params, 0, ports(provider)),
    ).toEqual({ kind: "stopped" });
    expect((await readRun(state.params.runId)).status).toBe("paused_auth");
    expect(await getDb(ctx.db).select().from(mailboxMessage)).toEqual([]);
    const next = await launchWorkflowRun(
      ctx.db,
      {
        runId: runEntityId.parse(state.params.runId),
        purpose: "mail_discovery",
      },
      state.launcher,
    );
    const params = { ...state.params, attempt: next.attempt };
    await listMailDiscovery(ctx.db, params, ports(gmail()));
    await saveMailDiscoveryBatch(ctx.db, params, 0, ports(gmail()));
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.broad
        .pageToken,
    ).toBe("page-two");
  });
  it("records no history and leaves the cursor alone once a pass is cancelled", async () => {
    const state = await seed();
    await listMailDiscovery(ctx.db, state.params, ports(gmail()));
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "run_cancelled" })
      .where(eq(run.id, runEntityId.parse(state.params.runId)));
    expect(
      await saveMailDiscoveryBatch(ctx.db, state.params, 0, ports(gmail())),
    ).toEqual({ kind: "stopped" });
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.broad
        .pageToken,
    ).toBeNull();
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
  });
  it.each([true, false])(
    "only continues unfinished approved scans and recovers each durable continuation once (scan pending: %s)",
    async (scanPending) => {
      const state = await seed();
      const provider = gmail({
        listMessages: async () =>
          scanPending
            ? { messages: [{ id: "source-one" }], nextPageToken: "page-two" }
            : { messages: [{ id: "source-one" }] },
      });
      await listMailDiscovery(ctx.db, state.params, ports(provider));
      await saveMailDiscoveryBatch(ctx.db, state.params, 0, ports(provider));
      await finishMailDiscovery(ctx.db, state.params);
      await continueMailDiscovery(ctx.db, state.params, state);
      await continueMailDiscovery(ctx.db, state.params, state);
      expect(state.created).toHaveLength(scanPending ? 2 : 1);
      expect(
        await Promise.all(
          state.created
            .slice(1)
            .map(async (params) => (await readRun(params.runId)).input),
        ),
      ).toEqual(scanPending ? [(await readRun(state.params.runId)).input] : []);
    },
  );
  it("prunes month-old routine passes and keeps a pass that holds a finding", async () => {
    const state = await seed();
    const quiet = gmail({ listMessages: async () => ({}) });
    await listMailDiscovery(ctx.db, state.params, ports(quiet));
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, ports(quiet));
    await finishMailDiscovery(ctx.db, state.params, new Date("2026-01-01"));
    await getDb(ctx.db)
      .insert(runFinding)
      .values({
        runId: runEntityId.parse(state.params.runId),
        ledgerPartyId: state.party.id,
        entityKind: "run",
        entityId: runEntityId.parse(state.params.runId),
        kind: "unknown_mail_sender",
        summary: "Synthetic historical finding",
        evidenceFingerprint: "synthetic",
      });
    expect(await pruneRoutineRuns(ctx.db, new Date("2026-03-01"))).toBe(0);
    await getDb(ctx.db)
      .delete(runFinding)
      .where(eq(runFinding.runId, runEntityId.parse(state.params.runId)));
    expect(await pruneRoutineRuns(ctx.db, new Date("2026-03-01"))).toBe(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runProgress)
        .where(eq(runProgress.runId, runEntityId.parse(state.params.runId))),
    ).toEqual([]);
  });
});
