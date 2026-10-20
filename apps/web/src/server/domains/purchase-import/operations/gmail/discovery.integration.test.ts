/** Plausible failures: baseline capture follows listing; pages checkpoint before
 * source/Mail import dispatch; interrupted pages duplicate sources; retries replay a
 * changed manifest; revoked auth becomes negative; stale attempts move coverage;
 * bounded passes wait a day instead of scheduling the next durable pass;
 * targeted search falls through to whole-mailbox history or searches a Vendor
 * name; completed coverage keeps chaining passes; one mailbox starves another. */
import { runEntityId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import {
  mailboxCursor,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  run,
  runFinding,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { setMailImport } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { activateWorkflowDeployment } from "~/server/workflows/runs/activation";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";
import {
  launchWorkflowRun,
  reconcileWorkflowRuns,
} from "~/server/workflows/runs/lifecycle";

import { GmailAuthorizationError } from "../../repo/gmail/tokens";
import type { GmailProvider } from "../../repo/gmail/types";
import { startMailImport } from "../../repo/mail-import-run";
import {
  startMailDiscovery,
  listMailDiscovery,
  saveMailDiscoveryBatch,
  finishMailDiscovery,
  continueMailDiscovery,
  pruneRoutineRuns,
  failMailDiscovery,
  type DiscoveryPorts,
} from "./discovery";

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
  const seed = async ({ targeted = true } = {}) => {
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
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-google-subject",
      enabled: true,
    });
    // A verified Vendor gives the pass a targeted history query to page.
    if (targeted)
      await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic Seed Vendor",
        orderEmailSenders: ["orders@seed.example.test"],
      });
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
  it("fences Gmail coverage when activation changes during provider ingestion", async () => {
    const state = await seed();
    await activateWorkflowDeployment(ctx.db, {
      deploymentId: "synthetic-mail-a",
      workerVersion: "synthetic-mail-version-a",
      expectedEpoch: 0,
    });
    const provider = gmail({
      getMessage: async (id) => {
        await activateWorkflowDeployment(ctx.db, {
          deploymentId: "synthetic-mail-b",
          workerVersion: "synthetic-mail-version-b",
          expectedEpoch: 1,
        });
        return gmail().getMessage(id);
      },
    });
    const seam = ports(provider);
    await listMailDiscovery(ctx.db, state.params, seam);
    await expect(
      withWorkflowExecution(
        {
          ...state.params,
          version: "synthetic-mail-version-a",
          epoch: 1,
          database: ctx.db,
        },
        () => saveMailDiscoveryBatch(ctx.db, state.params, 0, seam),
      ),
    ).rejects.toMatchObject({ reason: "deployment" });
    expect((await readRun(state.params.runId)).progress).toMatchObject({
      pagesDone: 0,
    });
  });

  it("admits retained originals once through page replay and continuation", async () => {
    const state = await seed();
    const relevance = vi.fn(async () => ({
      classification: "related" as const,
    }));
    const research = vi.fn(async () => []);
    const seam = {
      ...ports(gmail()),
      triage: async () => "uncertain" as const,
      relevance,
      research,
    };
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    await finishMailDiscovery(ctx.db, state.params);
    await continueMailDiscovery(ctx.db, state.params, state);
    const successor = state.created[1];
    if (!successor) throw new Error("Synthetic continuation missing");
    expect((await readRun(successor.runId)).input).toMatchObject({
      executionPolicy: "import",
    });
    await listMailDiscovery(ctx.db, successor, seam);
    await saveMailDiscoveryBatch(ctx.db, successor, 0, seam);
    expect(relevance).toHaveBeenCalledOnce();
    expect(research).toHaveBeenCalledOnce();
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
    expect((await getDb(ctx.db).select().from(emailTable))[0]).toMatchObject({
      classification: "related",
      executionPolicy: "import",
    });
  });
  it("keeps a failed page's raw diagnostic and Sentry event on the retained discovery Run", async () => {
    const state = await seed();
    const reportError = vi.fn(() => "ffffffffffffffffffffffffffffffff");
    await failMailDiscovery(
      ctx.db,
      state.params,
      "HTTP 503: Synthetic upstream failure\nSynthetic provider response",
      { reportError },
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(await readRun(state.params.runId)).toMatchObject({
      status: "failed",
      failureCode: "mail_discovery_failed",
      dispatchError: expect.stringContaining(
        "HTTP 503: Synthetic upstream failure",
      ),
    });
    expect((await readRun(state.params.runId)).dispatchError).toContain(
      "Synthetic provider response",
    );
    expect((await readRun(state.params.runId)).dispatchError).toContain(
      "Sentry event: ffffffffffffffffffffffffffffffff",
    );
  });

  it("fails a quiet discovery Run whose instance ended and leaves a waiting one", async () => {
    const state = await seed();
    const later = new Date(Date.now() + 3_600_000);
    const status = vi
      .spyOn(state.launcher, "status")
      .mockResolvedValue({ state: "waiting", error: null });
    expect(await reconcileWorkflowRuns(ctx.db, state.launcher, later)).toBe(0);
    expect((await readRun(state.params.runId)).status).toBe("running");
    status.mockResolvedValue({
      state: "errored",
      error: "Synthetic ended instance",
    });
    expect(await reconcileWorkflowRuns(ctx.db, state.launcher, later)).toBe(1);
    expect(await readRun(state.params.runId)).toMatchObject({
      status: "failed",
      failureCode: "workflow_instance_ended",
    });
    expect((await readRun(state.params.runId)).progressHistory).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: "failed" })]),
    );
  });

  it("alternates verified Vendor history with new mail and continues only while coverage remains", async () => {
    const state = await seed({ targeted: false });
    const baseline = ports(gmail());
    await listMailDiscovery(ctx.db, state.params, baseline);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, baseline);
    await finishMailDiscovery(ctx.db, state.params);
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Priority Vendor",
      orderEmailSenders: ["orders@priority.example.test"],
    });
    const queries: string[] = [];
    const historyStarts: string[] = [];
    const provider = gmail({
      listMessages: async ({ query }) => {
        queries.push(query);
        return { messages: [{ id: "synthetic-targeted-original" }] };
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
    const research = vi.fn(async () => []);
    const seam: DiscoveryPorts = { ...ports(provider), research };
    for (const pass of [1, 2]) {
      await startMailDiscovery(ctx.db, state);
      const params = state.created[pass];
      if (!params) throw new Error(`Synthetic pass ${pass} not launched`);
      await listMailDiscovery(ctx.db, params, seam);
      await saveMailDiscoveryBatch(ctx.db, params, 0, seam);
      await finishMailDiscovery(ctx.db, params);
      // Completed coverage never chains another pass.
      await continueMailDiscovery(ctx.db, params, state);
      expect(state.created).toHaveLength(pass + 1);
    }
    expect(queries).toEqual([
      "(from:orders@priority.example.test) -in:spam -in:trash",
    ]);
    expect(historyStarts).toEqual(["110"]);
    expect(research).toHaveBeenCalledTimes(2);
    const [cursor] = await getDb(ctx.db).select().from(mailboxCursor);
    expect(cursor?.coverage).toMatchObject({
      broad: { pageToken: null, completed: false },
      history: { historyId: "130", pageToken: null },
      scoped: [
        {
          completed: true,
          pageToken: null,
          completedAt: expect.any(String),
          emailCount: expect.any(Number),
        },
      ],
    });
  });

  // A classifier's uncertainty must remain actionable after the page checkpoint;
  // otherwise an unfamiliar acquisition is lost without a Mail import owner.
  it("retains uncertain discovery mail and its attachment and admits it once across replay", async () => {
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
      research: (db, input) => startMailImport(db, input, queue),
    };
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    const [original] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [state.party.id],
      mailboxId: "synthetic-google-subject",
      messageId: "source-one",
    });
    expect(original).toMatchObject({
      ledgerPartyId: state.party.id,
      mailboxId: "synthetic-google-subject",
      messageId: "source-one",
    });
    if (!original) throw new Error("Uncertain original was not retained");
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toHaveLength(
      1,
    );
    expect(attachmentBytes.size).toBe(1);
    const [message] = await getDb(ctx.db).select().from(emailTable);
    expect(message).toMatchObject({
      classification: "uncertain",
      orderMailId: original.id,
      executionPolicy: "import",
    });
    expect(message?.runId).not.toBeNull();
    expect(events).toHaveLength(1);
    const search = async () =>
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage
        ?.scoped[0];
    // The page credits its retained Email to the search it advanced; an
    // unfinished search has no finish time yet.
    expect(await search()).toMatchObject({
      pageToken: "page-two",
      emailCount: 1,
    });
    expect(await search()).not.toHaveProperty("completedAt");
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect((await search())?.emailCount).toBe(1);
  });

  it("establishes new-mail coverage without scanning history when nothing is targeted", async () => {
    const state = await seed({ targeted: false });
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
    expect(await getDb(ctx.db).select().from(emailTable)).toHaveLength(0);
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
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-second-google-subject",
      enabled: true,
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
  it("credits a retried page with Emails whose import completed between attempts", async () => {
    const state = await seed();
    const seam = ports(
      gmail({
        listMessages: async () => ({ messages: [{ id: "source-one" }] }),
      }),
    );
    // Dispatch reaches the child, which finishes its import before the page
    // checkpoints; the attempt then fails and the page is retried.
    seam.research = vi.fn(async () => {
      await getDb(ctx.db)
        .update(emailTable)
        .set({ status: "completed" })
        .where(eq(emailTable.messageId, "source-one"));
      throw new Error("Synthetic failure after research dispatch");
    });
    await listMailDiscovery(ctx.db, state.params, seam);
    await expect(
      saveMailDiscoveryBatch(ctx.db, state.params, 0, seam),
    ).rejects.toThrow("Synthetic failure after research dispatch");
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(seam.research).toHaveBeenCalledOnce();
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage
        ?.scoped[0],
    ).toMatchObject({
      completed: true,
      emailCount: 1,
      completedAt: expect.any(String),
    });
  });

  it("persists baseline before freezing one page and checkpoints after admitting retained content", async () => {
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
      expect(cursor?.coverage?.scoped[0]?.pageToken).toBeNull();
      return [];
    });
    seam.research = research;
    await listMailDiscovery(ctx.db, state.params, seam);
    expect(listed).toBe(1);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(research).toHaveBeenCalledOnce();
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.scoped[0]
        ?.pageToken,
    ).toBe("page-two");
    expect((await readRun(state.params.runId)).progress).not.toHaveProperty(
      "page",
    );
  });
  it("resumes a retried pass from its frozen page without listing again or duplicating original content", async () => {
    const state = await seed();
    const provider = gmail({
      getMessage: async (id) => ({
        ...(await gmail().getMessage(id)),
        payload: {
          ...(await gmail().getMessage(id)).payload,
          parts: [
            {
              partId: "pdf",
              filename: "receipt.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "pdf" },
            },
          ],
        },
      }),
      getAttachment: async () => ({ data: "cGRm" }),
    });
    let unavailable = true;
    const seam = ports(provider);
    seam.storage = {
      ...seam.storage!,
      put: async () => {
        if (unavailable)
          throw new Error("Synthetic attachment upload unavailable");
      },
    };
    const listMessages = vi.spyOn(provider, "listMessages");
    await listMailDiscovery(ctx.db, state.params, seam);
    await expect(
      saveMailDiscoveryBatch(ctx.db, state.params, 0, seam),
    ).rejects.toThrow("Synthetic attachment upload unavailable");
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.scoped[0]
        ?.pageToken,
    ).toBeNull();
    unavailable = false;
    await listMailDiscovery(ctx.db, state.params, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
  });
  it("dispatches expanded history records in bounded import batches and checkpoints after acquisition", async () => {
    const state = await seed({ targeted: false });
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
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(61);
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.history
        .historyId,
    ).toBe("120");
    // Sixty-one full PostgreSQL evidence publications exceed the ordinary test
    // deadline; the assertions above guard batching and cursor correctness.
  }, 30_000);
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
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual([]);
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
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.scoped[0]
        ?.pageToken,
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
        .from(run)
        .where(eq(run.id, runEntityId.parse(state.params.runId))),
    ).toEqual([]);
  });
});
