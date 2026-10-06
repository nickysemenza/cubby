/**
 * Scheduled Gmail discovery is one `mail_discovery` Run per mailbox pass,
 * executed by a Workflow whose steps these scenarios drive directly (the
 * Gmail provider, object storage and Workflow binding are faked).
 *
 * Failure modes guarded:
 * - overlapping triggers (daily cron and app open) both walk one cursor;
 * - a quiet mailbox reuses an identity and never syncs again;
 * - a replayed batch refetches mail, or a retry re-lists a different batch
 *   set than the one the earlier attempt partly saved;
 * - a message deleted between listing and fetching, or history about a
 *   message never saved, wedges the pass;
 * - the cursor moves before every batch is in, or rewinds after a later pass;
 * - routine passes pile up forever, or a pass that found mail is pruned;
 * - a saved batch never offers its confirmations for automatic import.
 */
import { runEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import { mailboxCursor, orderMail, run, runProgress } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import type { WorkflowLauncher } from "~/server/workflow-runs/launcher";

import type { OrderMailAttachmentStorage } from "./attachment-storage";
import {
  failMailDiscovery,
  finishMailDiscovery,
  listMailDiscovery,
  pruneRoutineRuns,
  saveMailDiscoveryBatch,
  startMailDiscovery,
} from "./discovery";
import { GmailApiError, type GmailMessage, type GmailProvider } from "./types";

const storage: OrderMailAttachmentStorage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};

const message = (id: string): GmailMessage => ({
  id,
  threadId: `thread-${id}`,
  historyId: "400",
  internalDate: "1788220800000",
  payload: {
    headers: [
      { name: "From", value: "orders@forgewear.example" },
      { name: "Subject", value: `Receipt ${id}` },
    ],
  },
});

const gmail = (overrides: Partial<GmailProvider> = {}): GmailProvider => ({
  getProfile: async () => ({ historyId: "500" }),
  listMessages: async ({ query }) =>
    query.startsWith("after:")
      ? {
          messages: Array.from({ length: 11 }, (_, index) => ({
            id: `msg-${String(index).padStart(2, "0")}`,
          })),
        }
      : { messages: [] },
  getMessage: async (id) => message(id),
  listHistory: async () => ({ historyId: "500" }),
  getAttachment: async () => ({ data: "" }),
  ...overrides,
});

const recordingLauncher = () => {
  const created: { id: string; runId: string; attempt: number }[] = [];
  const launcher: WorkflowLauncher = {
    create: async (_purpose, id, params) => {
      created.push({ id, ...params });
    },
    terminate: async () => undefined,
    status: async () => ({ state: "running", error: null }),
  };
  return { launcher, created };
};

describe("scheduled Gmail discovery", () => {
  const ctx = withTestDb();

  const seedMember = async () => {
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
    return party;
  };

  const startOne = async () => {
    const { launcher, created } = recordingLauncher();
    await startMailDiscovery(ctx.db, { launcher });
    const params = created.at(-1);
    if (!params) throw new Error("No discovery pass started");
    return { params, created, launcher };
  };

  const readRun = async (runId: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(runId)));
    if (!row) throw new Error("Run is missing");
    return row;
  };

  const cursorOf = async (
    ledgerPartyId: Awaited<ReturnType<typeof seedMember>>["id"],
  ) =>
    (
      await getDb(ctx.db)
        .select({ historyId: mailboxCursor.historyId })
        .from(mailboxCursor)
        .where(eq(mailboxCursor.ledgerPartyId, ledgerPartyId))
    )[0]?.historyId ?? null;

  const autoImported: string[][] = [];
  const ports = (provider: GmailProvider) => ({
    providerForUser: async () => provider,
    storage,
    process: async () => 0,
    autoImport: async (
      _db: Database,
      input: { messageIds: readonly string[] },
    ) => {
      autoImported.push([...input.messageIds]);
      return [];
    },
  });

  it("starts one pass per connected mailbox and refuses an overlapping one", async () => {
    const party = await seedMember();
    const { launcher, created } = recordingLauncher();

    expect(await startMailDiscovery(ctx.db, { launcher })).toEqual({
      started: 1,
      running: 0,
    });
    expect(await startMailDiscovery(ctx.db, { launcher })).toEqual({
      started: 0,
      running: 1,
    });
    expect(created).toHaveLength(1);
    expect(await readRun(created[0]?.runId ?? "")).toMatchObject({
      purpose: "mail_discovery",
      trigger: "scheduled",
      status: "running",
      ledgerPartyId: party.id,
      progress: expect.objectContaining({
        attempt: 1,
        startHistoryId: null,
      }),
    });
  });

  it("freezes batches, saves each once, and advances the cursor last", async () => {
    const party = await seedMember();
    const { params } = await startOne();
    const getMessage = vi.fn(async (id: string) => message(id));
    const provider = gmail({ getMessage });

    expect(await listMailDiscovery(ctx.db, params, ports(provider))).toEqual({
      kind: "listed",
      batches: 2,
    });
    expect(
      await saveMailDiscoveryBatch(ctx.db, params, 0, ports(provider)),
    ).toEqual({ kind: "done" });
    // A replayed batch whose write committed fetches nothing.
    await saveMailDiscoveryBatch(ctx.db, params, 0, ports(provider));
    expect(getMessage).toHaveBeenCalledTimes(10);
    expect(await cursorOf(party.id)).toBeNull();
    await saveMailDiscoveryBatch(ctx.db, params, 1, ports(provider));
    expect(await finishMailDiscovery(ctx.db, params)).toEqual({
      kind: "done",
    });

    expect(await cursorOf(party.id)).toBe("500");
    expect(await readRun(params.runId)).toMatchObject({
      status: "completed",
      routine: false,
      progress: expect.objectContaining({
        phase: "completed",
        mode: "bootstrap",
        saved: 11,
        batchesDone: 2,
      }),
    });
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(11);
    // Every saved message is offered for automatic import with its batch.
    expect(autoImported.flat()).toEqual(
      expect.arrayContaining(
        Array.from(
          { length: 11 },
          (_, index) => `msg-${String(index).padStart(2, "0")}`,
        ),
      ),
    );
  });

  it("marks a quiet pass routine and starts the next pass fresh", async () => {
    const party = await seedMember();
    await getDb(ctx.db).insert(mailboxCursor).values({
      ledgerPartyId: party.id,
      historyId: "500",
    });
    const quiet = gmail();
    const first = await startOne();

    await listMailDiscovery(ctx.db, first.params, ports(quiet));
    await finishMailDiscovery(ctx.db, first.params);
    expect(await readRun(first.params.runId)).toMatchObject({
      status: "completed",
      routine: true,
    });

    const second = await startOne();
    expect(second.params.runId).not.toBe(first.params.runId);
  });

  it("resumes a retried pass from its frozen batches without listing again", async () => {
    await seedMember();
    const { params, launcher } = await startOne();
    const listHistory = vi.fn();
    const provider = gmail({ listHistory });
    await listMailDiscovery(ctx.db, params, ports(provider));
    await saveMailDiscoveryBatch(ctx.db, params, 0, ports(provider));
    await failMailDiscovery(ctx.db, params, "Synthetic batch failure", {
      reportError: () => "ffffffffffffffffffffffffffffffff",
    });

    const { launchWorkflowRun } =
      await import("~/server/workflow-runs/lifecycle");
    const retry = await launchWorkflowRun(
      ctx.db,
      { runId: runEntityId.parse(params.runId), purpose: "mail_discovery" },
      launcher,
    );
    const second = { runId: params.runId, attempt: retry.attempt };
    const listMessages = vi.fn();
    const relisted = gmail({ listMessages, listHistory });

    expect(await listMailDiscovery(ctx.db, second, ports(relisted))).toEqual({
      kind: "listed",
      batches: 2,
    });
    expect(listMessages).not.toHaveBeenCalled();
    expect(
      await saveMailDiscoveryBatch(ctx.db, params, 1, ports(relisted)),
    ).toEqual({ kind: "stopped" });
    await saveMailDiscoveryBatch(ctx.db, second, 1, ports(relisted));
    await finishMailDiscovery(ctx.db, second);
    expect(await readRun(params.runId)).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ saved: 11, attempt: 2 }),
    });
  });

  it("skips a deleted message and drops history about mail never saved", async () => {
    const party = await seedMember();
    await getDb(ctx.db).insert(mailboxCursor).values({
      ledgerPartyId: party.id,
      historyId: "400",
    });
    const provider = gmail({
      listHistory: async () => ({
        historyId: "450",
        history: [
          {
            id: "420",
            messagesAdded: [{ message: { id: "msg-kept" } }],
          },
          {
            id: "430",
            messagesAdded: [{ message: { id: "msg-gone" } }],
          },
          {
            id: "440",
            messagesDeleted: [{ message: { id: "msg-gone" } }],
          },
        ],
      }),
      getMessage: async (id) => {
        if (id === "msg-gone")
          throw new GmailApiError({ status: 404, message: "Not Found" });
        return message(id);
      },
    });
    const { params } = await startOne();

    await listMailDiscovery(ctx.db, params, ports(provider));
    await saveMailDiscoveryBatch(ctx.db, params, 0, ports(provider));
    await finishMailDiscovery(ctx.db, params);

    expect(await cursorOf(party.id)).toBe("450");
    expect(await readRun(params.runId)).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        saved: 1,
        deleted: 1,
        events: 1,
        droppedEvents: 2,
      }),
    });
  });

  it("completes a stale pass without rewinding a cursor a later pass moved", async () => {
    const party = await seedMember();
    const { params } = await startOne();
    await listMailDiscovery(ctx.db, params, ports(gmail()));
    await getDb(ctx.db).insert(mailboxCursor).values({
      ledgerPartyId: party.id,
      historyId: "900",
    });
    await saveMailDiscoveryBatch(ctx.db, params, 0, ports(gmail()));
    await saveMailDiscoveryBatch(ctx.db, params, 1, ports(gmail()));
    await finishMailDiscovery(ctx.db, params);

    expect(await cursorOf(party.id)).toBe("900");
    expect(
      await getDb(ctx.db)
        .select({ detail: runProgress.detail })
        .from(runProgress)
        .where(
          and(
            eq(runProgress.runId, runEntityId.parse(params.runId)),
            eq(runProgress.phase, "completed"),
          ),
        ),
    ).toEqual([{ detail: expect.stringMatching(/cursor already moved/u) }]);
  });

  it("records no history and leaves the cursor alone once a pass is cancelled", async () => {
    const party = await seedMember();
    const { params, launcher } = await startOne();
    await listMailDiscovery(ctx.db, params, ports(gmail()));
    for (const index of [0, 1])
      await saveMailDiscoveryBatch(ctx.db, params, index, ports(gmail()));
    const [row] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runEntityId.parse(params.runId)));
    const { controlWorkflowRun } =
      await import("~/server/workflow-runs/control");
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: row?.shortcode ?? "", action: "cancel" },
      "mail_discovery",
      launcher,
    );

    expect(await finishMailDiscovery(ctx.db, params)).toEqual({
      kind: "stopped",
    });
    expect(await cursorOf(party.id)).toBeNull();
    expect(await readRun(params.runId)).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
    });
  });

  it("prunes month-old routine passes and keeps everything else", async () => {
    await seedMember();
    const quiet = await startOne();
    await listMailDiscovery(ctx.db, quiet.params, ports(gmail()));
    for (const index of [0, 1])
      await saveMailDiscoveryBatch(ctx.db, quiet.params, index, ports(gmail()));
    await finishMailDiscovery(ctx.db, quiet.params);
    const old = new Date(Date.now() - 40 * 86_400_000);
    await getDb(ctx.db)
      .update(run)
      .set({ routine: true, endedAt: old })
      .where(eq(run.id, runEntityId.parse(quiet.params.runId)));
    const kept = await startOne();

    expect(await pruneRoutineRuns(ctx.db)).toBe(1);
    expect(
      (await getDb(ctx.db).select({ id: run.id }).from(run)).map(
        (row) => row.id,
      ),
    ).toEqual([kept.params.runId]);
  });
});
