/** Plausible failures: baseline capture follows listing; pages checkpoint before
 * source/Mail import dispatch; interrupted pages duplicate sources; retries replay a
 * changed manifest; revoked auth becomes negative; stale attempts move coverage;
 * bounded passes wait a day instead of scheduling the next durable pass;
 * targeted search falls through to whole-mailbox history or searches a Vendor
 * name; completed coverage keeps chaining passes; one mailbox starves another. */
import { runEntityId, vendorShortcode } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
  summarizeDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  mailboxCursor,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  run,
  runControlEvent,
  aiUsage,
  vendor,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { createGmailApiClient } from "~/server/domains/purchase-import/repo/gmail/client";
import {
  initializeMailboxCoverage,
  listGmailPage,
} from "~/server/domains/purchase-import/repo/gmail/sync";
import { listGmailSyncTargets } from "~/server/domains/purchase-import/repo/gmail/targets";
import { setMailImport } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { findPgError } from "~/server/errors/db-errors";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { withJobFixtureExecution } from "~/server/testing/background-queue";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import {
  launchWorkflowRun,
  reconcileWorkflowRuns,
  yieldClaimedMailDiscovery,
} from "~/server/workflows/runs/lifecycle";

import { GmailAuthorizationError } from "../../repo/gmail/tokens";
import type { GmailProvider } from "../../repo/gmail/types";
import { startMailImport } from "../../repo/mail-import-run";
import {
  startMailDiscovery,
  listMailDiscovery as listMailDiscoveryImplementation,
  saveMailDiscoveryBatch as saveMailDiscoveryBatchImplementation,
  finishMailDiscovery as finishMailDiscoveryImplementation,
  continueMailDiscovery as continueMailDiscoveryImplementation,
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
const listMailDiscovery = (
  ...args: Parameters<typeof listMailDiscoveryImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1].runId}`,
      kind: "run.execute",
      input: { runId: args[1].runId, purpose: "mail_discovery" },
      runId: runEntityId.parse(args[1].runId),
    },
    () => listMailDiscoveryImplementation(...args),
  );
const saveMailDiscoveryBatch = (
  ...args: Parameters<typeof saveMailDiscoveryBatchImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1].runId}`,
      kind: "run.execute",
      input: { runId: args[1].runId, purpose: "mail_discovery" },
      runId: runEntityId.parse(args[1].runId),
    },
    () => saveMailDiscoveryBatchImplementation(...args),
  );
const finishMailDiscovery = (
  ...args: Parameters<typeof finishMailDiscoveryImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1].runId}`,
      kind: "run.execute",
      input: { runId: args[1].runId, purpose: "mail_discovery" },
      runId: runEntityId.parse(args[1].runId),
    },
    () => finishMailDiscoveryImplementation(...args),
  );
const continueMailDiscovery = (
  ...args: Parameters<typeof continueMailDiscoveryImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1].runId}`,
      kind: "run.execute",
      input: { runId: args[1].runId, purpose: "mail_discovery" },
      runId: runEntityId.parse(args[1].runId),
    },
    () => continueMailDiscoveryImplementation(...args),
  );
describe("scheduled Gmail discovery", () => {
  const ctx = withTestDb();
  const created = async () => {
    const discovery = new Set(
      (
        await getDb(ctx.db)
          .select({ id: run.id })
          .from(run)
          .where(eq(run.purpose, "mail_discovery"))
      ).map((row) => row.id),
    );
    return (
      await readJobs(
        ctx.db,
        { kind: "run.execute" },
        { order: ["createdAt", "id"] },
      )
    ).flatMap((row) =>
      row.runId && discovery.has(row.runId)
        ? [{ runId: row.runId, attempt: row.generation }]
        : [],
    );
  };
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
    await startMailDiscovery(ctx.db);
    const params = (await created())[0];
    if (!params) throw new Error("Synthetic discovery not launched");
    return { party, params };
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
  it("previews one union of Gmail matches without importing or changing the mailbox queue", async () => {
    await seed();
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Preview Vendor",
      website: "https://preview.example.test",
      orderEmailSenders: ["orders@preview.example.test"],
    });
    const { previewControlledMailMatches } =
      await import("./controlled-import");
    const providers =
      await import("~/server/domains/purchase-import/repo/gmail/provider");
    const listMessages = vi
      .fn<GmailProvider["listMessages"]>()
      .mockResolvedValueOnce({ messages: [{ id: "one" }, { id: "two" }] })
      .mockResolvedValueOnce({
        messages: [{ id: "one" }],
        nextPageToken: "more",
        resultSizeEstimate: 105,
      })
      .mockResolvedValueOnce({
        messages: [{ id: "one" }, { id: "two" }],
        nextPageToken: "more",
        resultSizeEstimate: 1,
      })
      .mockResolvedValueOnce({ nextPageToken: "more" })
      .mockResolvedValueOnce({});
    const provider = vi
      .spyOn(providers, "gmailProviderForUser")
      .mockResolvedValue(gmail({ listMessages }));
    const input = {
      mailboxId: "synthetic-google-subject",
      vendorId: vendorShortcode.parse(seller.shortcode),
      from: "2026-03-08",
      to: "2026-03-08",
    };
    const preview = await previewControlledMailMatches(
      ctx.db,
      ctx.actor,
      input,
    );
    expect(preview).toMatchObject({ matchedMessages: 2, approximate: false });
    expect(listMessages).toHaveBeenCalledWith({
      query: `((("example.test") OR (from:orders@preview.example.test)) after:${Date.parse("2026-03-08T08:00:00Z") / 1000 - 1} before:${Date.parse("2026-03-09T07:00:00Z") / 1000}) -in:spam -in:trash`,
      maxResults: 100,
    });
    expect(
      await previewControlledMailMatches(ctx.db, ctx.actor, input),
    ).toMatchObject({ matchedMessages: 105, approximate: true });
    expect(
      await previewControlledMailMatches(ctx.db, ctx.actor, input),
    ).toMatchObject({ matchedMessages: 2, approximate: true });
    expect(
      await previewControlledMailMatches(ctx.db, ctx.actor, input),
    ).toMatchObject({ matchedMessages: null, approximate: true });
    expect(
      await previewControlledMailMatches(ctx.db, ctx.actor, input),
    ).toMatchObject({ matchedMessages: 0, approximate: false });
    await expect(
      previewControlledMailMatches(ctx.db, ctx.actor, {
        ...input,
        mailboxId: "another-member-mailbox",
      }),
    ).rejects.toThrow("not connected to this member");
    expect(provider).toHaveBeenCalledTimes(5);
    expect(await created()).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual([]);
    provider.mockRestore();
  });
  it("finishes active discovery before the selected Vendor, keeps other cursors, and never lists mailbox history for the control", async () => {
    const state = await seed();
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Selected Vendor",
      orderEmailSenders: ["orders@selected.example.test"],
    });
    const { startControlledMailImport } = await import("./controlled-import");
    const control = await startControlledMailImport(ctx.db, ctx.actor, {
      mailboxId: "synthetic-google-subject",
      vendorId: vendorShortcode.parse(seller.shortcode),
    });
    expect(control.state).toBe("queued");
    expect((await readRun(state.params.runId)).status).toBe("running");
    expect(await created()).toHaveLength(1);
    // The active Run retains and commits its current work before the control starts.
    const original = ports(
      gmail({ listHistory: async () => ({ historyId: "110" }) }),
    );
    await listMailDiscovery(ctx.db, state.params, original);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, original);
    await finishMailDiscovery(ctx.db, state.params);
    await continueMailDiscovery(ctx.db, state.params);
    const selected = (await created())[1];
    if (!selected) throw new Error("Controlled discovery was not launched");
    const listMessages = vi
      .fn<GmailProvider["listMessages"]>()
      .mockResolvedValueOnce({
        messages: [],
        nextPageToken: "selected-page-two",
      })
      .mockResolvedValueOnce({ messages: [] });
    const listHistory = vi.fn<GmailProvider["listHistory"]>();
    const seam = ports(gmail({ listMessages, listHistory }));
    expect(await listMailDiscovery(ctx.db, selected, seam)).toEqual({
      kind: "listed",
      more: true,
    });
    await saveMailDiscoveryBatch(ctx.db, selected, 0, seam);
    expect(await listMailDiscovery(ctx.db, selected, seam)).toEqual({
      kind: "listed",
      more: false,
    });
    await saveMailDiscoveryBatch(ctx.db, selected, 1, seam);
    await finishMailDiscovery(ctx.db, selected);
    await continueMailDiscovery(ctx.db, selected);
    expect(listHistory).not.toHaveBeenCalled();
    expect(listMessages.mock.calls.map(([request]) => request)).toEqual([
      {
        query: "(from:orders@selected.example.test) -in:spam -in:trash",
        maxResults: 25,
      },
      {
        query: "(from:orders@selected.example.test) -in:spam -in:trash",
        maxResults: 25,
        pageToken: "selected-page-two",
      },
    ]);
    const { loadGmailCursor } = await import("../../repo/gmail/persistence");
    const cursor = await loadGmailCursor(ctx.db, {
      ledgerPartyId: state.party.id,
      mailboxId: "synthetic-google-subject",
    });
    expect(cursor.coverage?.history.historyId).toBe("100");
    expect(cursor.coverage?.scoped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: "from:orders@seed.example.test",
          completed: false,
        }),
        expect.objectContaining({
          query: "from:orders@selected.example.test",
          completed: true,
          messageCount: 0,
        }),
      ]),
    );
    expect(await created()).toHaveLength(2);
    const { mailImportEnabled } =
      await import("../../repo/mail-import-settings");
    expect(await mailImportEnabled(ctx.db, "synthetic-google-subject")).toBe(
      false,
    );
  });
  it("finds new selected mail after canonical search completion without rewinding mailbox coverage", async () => {
    const state = await seed();
    const initial = ports(
      gmail({ listMessages: async () => ({ messages: [] }) }),
    );
    await listMailDiscovery(ctx.db, state.params, initial);
    await saveMailDiscoveryBatch(ctx.db, state.params, 0, initial);
    await finishMailDiscovery(ctx.db, state.params);
    const [before] = await getDb(ctx.db).select().from(mailboxCursor);
    const canonical = before?.coverage?.scoped[0];
    if (!before?.coverage || !canonical)
      throw new Error("Synthetic canonical search has no coverage");
    expect(canonical.completed).toBe(true);
    const [initialRun] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, state.params.runId));
    expect(canonical.runId).toBe(initialRun?.shortcode);
    const unrelated = {
      key: "merchant:synthetic-unrelated",
      query: '"SYNTHETIC UNRELATED"',
      pageToken: "unrelated-query-page",
      completed: false,
      messageCount: 3,
    };
    // Retain historical positions from other lanes while this member requests
    // a new scan of just one already-completed Vendor search.
    const baseline = {
      ...before.coverage,
      broad: { pageToken: "unrelated-broad-page", completed: false },
      history: {
        historyId: "100",
        pageToken: "unrelated-history-page",
        targetHistoryId: "140",
      },
      scoped: [...before.coverage.scoped, unrelated],
    };
    await getDb(ctx.db)
      .update(mailboxCursor)
      .set({ coverage: baseline })
      .where(eq(mailboxCursor.id, before.id));
    const [seller] = await getDb(ctx.db)
      .select()
      .from(vendor)
      .where(eq(vendor.name, "Synthetic Seed Vendor"));
    if (!seller) throw new Error("Synthetic canonical Vendor missing");
    const { startControlledMailImport } = await import("./controlled-import");
    const request = await startControlledMailImport(ctx.db, ctx.actor, {
      mailboxId: "synthetic-google-subject",
      vendorId: vendorShortcode.parse(seller.shortcode),
    });
    const selected = (await created())[1];
    if (!selected) throw new Error("Synthetic fresh controlled scan missing");
    const listMessages = vi
      .fn<GmailProvider["listMessages"]>()
      .mockResolvedValue({
        messages: [{ id: "synthetic-new-selected-original" }],
      });
    const listHistory = vi.fn<GmailProvider["listHistory"]>();
    const provider = gmail({
      listMessages,
      listHistory,
      getMessage: async (id) => ({
        id,
        internalDate: "1788220800000",
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: "orders@seed.example.test" }],
          body: {
            data: Buffer.from(
              "Your order receipt: synthetic item $24",
            ).toString("base64url"),
          },
        },
      }),
    });
    const seam = { ...ports(provider), research: startMailImport };
    expect(await listMailDiscovery(ctx.db, selected, seam)).toEqual({
      kind: "listed",
      more: false,
    });
    const frozen = mailboxDiscoveryProgress.parse(
      (await readRun(selected.runId)).progress,
    ).page;
    if (!frozen?.scopedKey)
      throw new Error("Synthetic controlled page missing");
    // A frozen page keeps only its own query: advance the cursor's full
    // coverage so the other selected queries must survive the rebase.
    const [cursor] = await getDb(ctx.db)
      .select()
      .from(mailboxCursor)
      .where(eq(mailboxCursor.id, before.id));
    if (!cursor?.coverage) throw new Error("Synthetic mailbox cursor missing");
    const selectedAdvanced = {
      ...cursor.coverage,
      scoped: cursor.coverage.scoped.map((query) =>
        query.key === frozen.scopedKey
          ? { ...query, pageToken: "newer-selected-page" }
          : query,
      ),
    };
    await getDb(ctx.db)
      .update(mailboxCursor)
      .set({ coverage: selectedAdvanced })
      .where(eq(mailboxCursor.id, before.id));
    await expect(
      saveMailDiscoveryBatch(ctx.db, selected, 0, seam),
    ).rejects.toThrow("Mailbox page coverage changed before checkpoint");
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage,
    ).toEqual(selectedAdvanced);
    // Another pass can prune this failed control's unfinished query and move
    // unrelated coverage before its frozen page is retried.
    const advanced = {
      ...baseline,
      history: { historyId: "160", pageToken: null, targetHistoryId: null },
      scoped: baseline.scoped.map((query) =>
        query.key === unrelated.key
          ? { ...query, pageToken: "newer-unrelated-page", messageCount: 7 }
          : query,
      ),
    };
    await getDb(ctx.db)
      .update(mailboxCursor)
      .set({ coverage: advanced })
      .where(eq(mailboxCursor.id, before.id));
    await saveMailDiscoveryBatch(ctx.db, selected, 0, seam);
    await saveMailDiscoveryBatch(ctx.db, selected, 0, seam);
    await finishMailDiscovery(ctx.db, selected);
    await continueMailDiscovery(ctx.db, selected);
    expect(listMessages).toHaveBeenCalledExactlyOnceWith({
      query: "(from:orders@seed.example.test) -in:spam -in:trash",
      maxResults: 25,
    });
    expect(listHistory).not.toHaveBeenCalled();
    const [after] = await getDb(ctx.db).select().from(mailboxCursor);
    expect(after?.coverage?.broad).toEqual(baseline.broad);
    expect(after?.coverage?.history).toEqual(advanced.history);
    expect(
      after?.coverage?.scoped.find((query) => query.key === canonical.key),
    ).toEqual(canonical);
    expect(
      after?.coverage?.scoped.find((query) => query.key === unrelated.key),
    ).toEqual(advanced.scoped.find((query) => query.key === unrelated.key));
    const refreshed = after?.coverage?.scoped.find((query) =>
      query.key.startsWith(`${canonical.key}:controlled:`),
    );
    expect(refreshed).toMatchObject({
      query: canonical.query,
      completed: true,
      messageCount: 1,
      emailCount: 1,
    });
    const [child] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, selected.runId));
    expect(child).toMatchObject({
      purpose: "mail_import",
      vendorId: seller.id,
      status: "running",
    });
    const { readMailCoverage } =
      await import("~/server/domains/purchase-import/repo/gmail/mail-coverage");
    const currentCoverage = await readMailCoverage(ctx.db, ctx.actor.userId);
    expect(
      currentCoverage.rows.find((row) => row.vendorId === seller.shortcode),
    ).toMatchObject({
      state: "matches_found",
      scanned: 1,
      retained: 1,
      controlledRun: {
        status: "completed",
        imports: { running: 1, completed: 0 },
      },
      queue: { state: "running" },
    });
    // Normal discovery can prune request-only cursor entries; the completed
    // all-history Run still proves coverage, but never invents a zero total.
    await getDb(ctx.db)
      .update(mailboxCursor)
      .set({ coverage: baseline })
      .where(eq(mailboxCursor.id, before.id));
    const prunedCoverage = await readMailCoverage(ctx.db, ctx.actor.userId);
    const prunedRow = prunedCoverage.rows.find(
      (row) => row.vendorId === seller.shortcode,
    );
    expect(prunedRow?.state).toBe("complete");
    expect(prunedRow?.searches[0]?.runId).toBe(prunedRow?.controlledRun?.id);
    const { vendorScaffold } =
      await import("~/server/domains/vendor/repo/vendor");
    const vendors = await vendorScaffold.read(ctx.db, {
      filters: {},
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 50 },
    });
    expect(
      vendors.data.find((row) => row.id === seller.shortcode)?.mailSearch,
    ).toBe("done");
    const [message] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.messageId, "synthetic-new-selected-original"));
    expect(message).toMatchObject({
      classification: "related",
      runId: child?.id,
      status: "researching",
    });
    expect((await readRun(selected.runId)).shortcode).toBe(request.run);
    expect(await readJobs(ctx.db, { kind: "purchase.dispatch" })).toHaveLength(
      1,
    );
  });
  it.each(["advanced", "pruned"])(
    "admits retained originals once through page replay and continuation with a %s search",
    async (search) => {
      const state = await seed();
      const relevance = vi.fn(async () => ({
        classification: "related" as const,
      }));
      // Existing source ownership is admission even when that child has failed.
      const research = vi.fn(async () => [
        {
          runId: runEntityId.parse(state.params.runId),
          status: "dispatch_failed" as const,
        },
      ]);
      const seam = {
        ...ports(gmail()),
        triage: async () => "uncertain" as const,
        relevance,
        research,
      };
      await listMailDiscovery(ctx.db, state.params, seam);
      await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
      await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam);
      expect(research).toHaveBeenCalledOnce();
      await finishMailDiscovery(ctx.db, state.params);
      const [mailbox] = await getDb(ctx.db).select().from(mailboxCursor);
      if (!mailbox?.coverage)
        throw new Error("Synthetic mailbox coverage missing");
      // Select a targeted continuation before admission; history owners never
      // switch into another search because the shared lane changed later.
      await getDb(ctx.db)
        .update(mailboxCursor)
        .set({ coverage: { ...mailbox.coverage, nextLane: "scan" } })
        .where(eq(mailboxCursor.id, mailbox.id));
      await continueMailDiscovery(ctx.db, state.params);
      const successor = (await created())[1];
      if (!successor) throw new Error("Synthetic continuation missing");
      expect((await readRun(successor.runId)).input).toMatchObject({
        executionPolicy: "import",
      });
      // Freeze another targeted page; a separate pass can move its opaque cursor
      // while this retained page waits for funding or admission.
      await listMailDiscovery(ctx.db, successor, seam);
      const frozenRun = await readRun(successor.runId);
      const frozen = mailboxDiscoveryProgress.parse(frozenRun.progress).page;
      if (!frozen?.scopedKey)
        throw new Error("Synthetic targeted page missing");
      const [finishedExecution] = await readJobs(ctx.db, {
        key: `run:${successor.runId}`,
      });
      if (!finishedExecution)
        throw new Error("Synthetic retained execution missing");
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "failed",
          failureCode: "job_failed",
          endedAt: new Date(),
        })
        .where(eq(run.id, runEntityId.parse(successor.runId)));
      // A terminal transport receipt does not settle the Run's frozen page.
      await updateJobs(
        ctx.db,
        { id: finishedExecution.id },
        { state: "completed", leaseToken: null, leaseExpiresAt: null },
      );
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: frozenRun.shortcode, action: "retry" },
        "mail_discovery",
      );
      const [retriedExecution] = await readJobs(ctx.db, {
        key: `run:${successor.runId}`,
      });
      expect(retriedExecution).toMatchObject({
        id: finishedExecution.id,
        state: "queued",
        generation: finishedExecution.generation + 1,
        input: finishedExecution.input,
      });
      if (!retriedExecution)
        throw new Error("Synthetic retried execution missing");
      expect(await readRun(successor.runId)).toMatchObject({
        status: "running",
        input: frozenRun.input,
        progress: { page: frozen, attempt: retriedExecution.generation },
      });
      const retry = { ...successor, attempt: retriedExecution.generation };
      const [cursor] = await getDb(ctx.db)
        .select()
        .from(mailboxCursor)
        .where(eq(mailboxCursor.id, mailbox.id));
      if (!cursor?.coverage)
        throw new Error("Synthetic mailbox cursor missing");
      const intervening = {
        ...cursor.coverage,
        history: { historyId: "160", pageToken: null, targetHistoryId: null },
        nextLane: "history" as const,
        scoped: cursor.coverage.scoped
          .filter(
            (query) => search !== "pruned" || query.key !== frozen.scopedKey,
          )
          .map((query) =>
            query.key === frozen.scopedKey
              ? {
                  ...query,
                  pageToken: "intervening-partial-page",
                  emailCount: 40,
                }
              : query,
          ),
      };
      await getDb(ctx.db)
        .update(mailboxCursor)
        .set({ coverage: intervening })
        .where(eq(mailboxCursor.id, mailbox.id));
      await saveMailDiscoveryBatch(ctx.db, retry, 0, seam);
      await saveMailDiscoveryBatch(ctx.db, retry, 0, seam);
      expect(
        (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage,
      ).toEqual(intervening);
      await finishMailDiscovery(ctx.db, retry);
      const completed = await readRun(successor.runId);
      expect(completed).toMatchObject({
        status: "completed",
        progress: { pagesDone: 1 },
      });
      expect(completed.input).toEqual(frozenRun.input);
      expect(completed.progressHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "page_saved" }),
        ]),
      );
      await continueMailDiscovery(ctx.db, retry);
      expect(await created()).toHaveLength(search === "pruned" ? 2 : 3);
      expect(
        (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage,
      ).toEqual(intervening);
      expect(relevance).toHaveBeenCalledOnce();
      // Each distinct targeted page checks durable child admission; page replay
      // and reused classification create no extra source or prediction.
      expect(research).toHaveBeenCalledTimes(2);
      expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
      expect((await getDb(ctx.db).select().from(emailTable))[0]).toMatchObject({
        classification: "related",
        executionPolicy: "import",
      });
    },
  );
  it("retains discovery through funding releases, provider waits and mailbox contention", async () => {
    const { AiBudgetExhaustedError } = await import("~/server/ai/budget");
    const { GatewayProviderStopError } =
      await import("~/server/ai/gateway-egress-client");
    const { wrapAiGatewayError } = await import("~/server/ai/gateway-error");
    const { pauseForFunding } =
      await import("~/server/domains/run/repo/execution-context");
    const { controlWorkflowRun } =
      await import("~/server/workflows/runs/control");
    const { advanceJob } = await import("~/server/generic/jobs/service/jobs");
    const { runJobHandler } =
      await import("~/server/workflows/runs/job-execution");
    const discovery = await import("./discovery");
    const state = await seed();
    const key = `run:${state.params.runId}`;
    const execution = (await readJobs(ctx.db, { key }))[0];
    if (!execution) throw new Error("Synthetic Job missing");
    const advance = () =>
      advanceJob(ctx.db, execution.id, { "run.execute": runJobHandler });
    const windowEnd = new Date(Date.now() + 3_600_000).toISOString();
    const until = new Date(Date.parse(windowEnd) + 60_000);
    const budget = new AiBudgetExhaustedError(
      {
        windowStart: new Date().toISOString(),
        windowEnd,
        credit: { spentUsd: 1 },
        openaiCredit: { spentUsd: 1 },
        plan: { limitUsd: 1, spentUsd: 1 },
        paid: { limitUsd: 1, spentUsd: 1 },
      },
      "HTTP 400: Synthetic missing default BYOK credential",
    );
    let stop: Error | undefined = budget;
    let releaseAtPublication = false;
    const relevance = vi.fn(async () => {
      if (stop) {
        if (stop === budget)
          await pauseForFunding(
            ctx.db,
            runEntityId.parse(state.params.runId),
            budget,
          );
        throw wrapAiGatewayError(stop, {
          model: "gpt-6.1-sol",
          provider: "synthetic",
          route: "structured-chat",
          feature: "mailbox-relevance",
          operation: "classify",
        });
      }
      return { classification: "related" as const };
    });
    const seam: DiscoveryPorts = {
      ...ports(gmail()),
      triage: async () => "uncertain",
      relevance,
    };
    const realAdvance = discovery.advanceMailDiscoveryPage;
    const page = vi
      .spyOn(discovery, "advanceMailDiscoveryPage")
      .mockImplementation((db, params, cursor) =>
        realAdvance(db, params, cursor, seam),
      );
    const realPrepare = runJobHandler.prepare;
    const prepare = vi
      .spyOn(runJobHandler, "prepare")
      .mockImplementation(async (...args) => {
        const prepared = await realPrepare(...args);
        if (releaseAtPublication) {
          releaseAtPublication = false;
          await (
            await import("~/server/domains/run/service/ai-work")
          ).resumeFundingPausedRuns(ctx.db, { anyWindow: true });
        }
        return prepared;
      });
    try {
      expect(await advance()).toBe("succeeded");
      const retained = await readRun(state.params.runId);
      const checkpoint = (await readJobs(ctx.db, { key }))[0]?.cursor;
      expect(await advance()).toBe("succeeded");
      const paused = await readRun(state.params.runId);
      expect(paused).toMatchObject({
        status: "paused_auth",
        failureCode: "execution_limit",
        input: retained.input,
        progress: retained.progress,
        dispatchError: expect.stringContaining(
          "Synthetic missing default BYOK credential",
        ),
      });
      expect((await readJobs(ctx.db, { key }))[0]).toMatchObject({
        state: "queued",
        attempts: 0,
        cursor: checkpoint,
        availableAt: until,
        waitReason: "ai_funding_window",
      });
      expect(
        (await readJobs(ctx.db, { kind: "run.funding-resume" }))[0]
          ?.availableAt,
      ).toEqual(until);
      expect(await startMailDiscovery(ctx.db)).toEqual({
        started: 0,
        running: 1,
      });
      expect(await startMailDiscovery(ctx.db)).toEqual({
        started: 0,
        running: 1,
      });
      expect(await created()).toHaveLength(1);
      // A generic early retry must not restore the Run or call the provider.
      await updateJobs(ctx.db, { key }, { availableAt: new Date() });
      // Retry-now can also advance the funding owner's queue admission; its
      // frozen input still owns the actual funding deadline.
      await updateJobs(
        ctx.db,
        { kind: "run.funding-resume" },
        { availableAt: new Date() },
      );
      const calls = relevance.mock.calls.length;
      expect(await advance()).toBe("succeeded");
      expect(relevance).toHaveBeenCalledTimes(calls);
      expect((await readRun(state.params.runId)).status).toBe("paused_auth");
      expect((await readJobs(ctx.db, { key }))[0]?.availableAt).toEqual(until);
      // Retained funding pages can share a mailbox; releasing them must serialize admission.
      const waitingRun = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "completed",
        input: mailboxDiscoveryInput.parse(retained.input),
        execution: false,
      });
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "paused_auth",
          failureCode: "execution_limit",
          dispatchError: paused.dispatchError,
          endedAt: null,
          progress: retained.progress,
        })
        .where(eq(run.id, waitingRun));
      await enqueueJob(ctx.db, {
        key: `run:${waitingRun}`,
        kind: "run.execute",
        runId: waitingRun,
        input: { runId: waitingRun, purpose: "mail_discovery" },
        availableAt: until,
      });
      // Natural expiry must also serialize first-generation, zero-attempt work.
      await updateJobs(
        ctx.db,
        { kind: "run.funding-resume" },
        {
          input: { until: new Date(Date.now() - 1_000).toISOString() },
        },
      );
      await launchWorkflowRun(ctx.db, {
        runId: waitingRun,
        purpose: "mail_discovery",
      });
      for (let attempt = 0; attempt < 4; attempt++) {
        await updateJobs(ctx.db, { key }, { availableAt: new Date() });
        expect(await advance()).toBe("deferred");
        expect((await readJobs(ctx.db, { key }))[0]).toMatchObject({
          state: "queued",
          attempts: 0,
          generation: 1,
          input: execution.input,
          cursor: checkpoint,
          waitReason: "provider_capacity",
        });
      }
      expect(relevance).toHaveBeenCalledTimes(calls);
      expect(await readRun(state.params.runId)).toMatchObject({
        status: "paused",
        failureCode: "mail_discovery_queued",
        input: retained.input,
        progress: {
          page: mailboxDiscoveryProgress.parse(retained.progress).page,
        },
      });
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        {
          runPublicId: (await readRun(waitingRun)).shortcode,
          action: "cancel",
        },
        "mail_discovery",
      );
      const cancelled = await readRun(waitingRun);
      await updateJobs(
        ctx.db,
        { kind: "run.funding-resume" },
        { input: { until: until.toISOString() } },
      );
      await updateJobs(ctx.db, { key }, { availableAt: new Date() });
      expect(await advance()).toBe("succeeded");
      expect(relevance).toHaveBeenCalledTimes(calls + 1);
      expect(await readRun(state.params.runId)).toMatchObject({
        status: "paused_auth",
        failureCode: "execution_limit",
      });
      // Raising the budget releases discovery without granting per-Run overage.
      const { resumeFundingPausedRuns } =
        await import("~/server/domains/run/service/ai-work");
      await resumeFundingPausedRuns(ctx.db, { anyWindow: true });
      expect(await readRun(waitingRun)).toEqual(cancelled);
      const released = await readRun(state.params.runId);
      expect(released).toMatchObject({
        status: "paused_auth",
        failureCode: "execution_limit",
        progress: {
          ...retained.progress,
          admissionClass: "recovery",
          fundingReleasedAt: expect.any(String),
        },
      });
      const { readRun: readPublicRun } =
        await import("~/server/domains/run/repo/run");
      expect(await readPublicRun(ctx.db, released.shortcode)).toMatchObject({
        displayStatus: "paused",
      });
      expect(
        summarizeDiscoveryProgress(
          mailboxDiscoveryProgress.parse(released.progress),
        ),
      ).not.toHaveProperty("fundingReleasedAt");
      await updateJobs(ctx.db, { key }, { availableAt: new Date() });
      expect(await advance()).toBe("succeeded");
      expect(relevance).toHaveBeenCalledTimes(calls + 2);
      expect((await readRun(state.params.runId)).status).toBe("paused_auth");
      expect((await readRun(state.params.runId)).progress).not.toHaveProperty(
        "fundingReleasedAt",
      );
      // Release after prepare, before publication: a pre-throw check misses this race.
      await resumeFundingPausedRuns(ctx.db, { anyWindow: true });
      releaseAtPublication = true;
      expect(await advance()).toBe("deferred");
      expect(
        (await readJobs(ctx.db, { key }))[0]?.availableAt.getTime(),
      ).toBeLessThanOrEqual(Date.now());
      expect((await readRun(state.params.runId)).progress).toHaveProperty(
        "fundingReleasedAt",
      );
      expect(await advance()).toBe("succeeded");
      expect((await readRun(state.params.runId)).progress).not.toHaveProperty(
        "fundingReleasedAt",
      );
      // Explicit paid authority restores the Run even while the funding owner waits.
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        {
          runPublicId: paused.shortcode,
          action: "run_now_paid",
          paidOverBudgetUsd: 1,
        },
        "mail_discovery",
      );
      await updateJobs(ctx.db, { key }, { availableAt: new Date() });
      const provider = new GatewayProviderStopError(
        "configuration",
        403,
        "Synthetic provider configuration unavailable",
      );
      stop = provider;
      expect(await advance()).toBe("deferred");
      expect((await readJobs(ctx.db, { key }))[0]).toMatchObject({
        attempts: 0,
        cursor: checkpoint,
        availableAt: provider.until,
        waitReason: "provider_capacity",
      });
      expect(await readRun(state.params.runId)).toMatchObject({
        status: "running",
        dispatchError: expect.stringContaining(
          "Synthetic provider configuration unavailable",
        ),
      });
      // Ordinary faults still spend the existing Job attempt budget.
      stop = new Error("Synthetic ordinary fault");
      await updateJobs(ctx.db, { key }, { availableAt: new Date() });
      expect(await advance()).toBe("failed");
      expect((await readJobs(ctx.db, { key }))[0]?.attempts).toBe(1);
      stop = undefined;
      await updateJobs(ctx.db, { key }, { availableAt: new Date() });
      expect(await advance()).toBe("succeeded");
      expect(await readRun(state.params.runId)).toMatchObject({
        status: "completed",
        dispatchError: null,
      });
      expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
      expect((await readRun(state.params.runId)).input).toEqual(retained.input);
      expect(await getDb(ctx.db).select().from(emailTable)).toHaveLength(1);
    } finally {
      page.mockRestore();
      prepare.mockRestore();
    }
  });

  it.each(["paused", "cancelled"] satisfies ("paused" | "cancelled")[])(
    "preserves failed discovery for its recovery Job and respects a %s stop",
    async (stoppedState) => {
      const state = await seed();
      await listMailDiscovery(ctx.db, state.params, ports(gmail()));
      await updateJobs(
        ctx.db,
        { key: `run:${state.params.runId}` },
        {
          state: "retry_wait",
          availableAt: new Date(Date.now() + 3_600_000),
        },
      );
      expect((await reconcileWorkflowRuns(ctx.db)).reconciled).toBe(0);
      expect((await readRun(state.params.runId)).status).toBe("running");
      await updateJobs(
        ctx.db,
        { key: `run:${state.params.runId}` },
        { state: "failed", error: "HTTP 503: Synthetic ended execution" },
      );
      expect((await reconcileWorkflowRuns(ctx.db)).reconciled).toBe(1);
      expect(await readRun(state.params.runId)).toMatchObject({
        status: "failed",
        endedAt: expect.any(Date),
        failureCode: "job_failed",
        dispatchError: "HTTP 503: Synthetic ended execution",
      });
      const retained = await readRun(state.params.runId);
      const availableAt = new Date(Date.now() + 60_000);
      await updateJobs(
        ctx.db,
        { key: `run:${state.params.runId}` },
        {
          state: "retry_wait",
          attempts: 3,
          availableAt,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      );
      // App-open discovery must leave the free slot for the retained Job, even
      // while its retry backoff has not elapsed.
      expect(await startMailDiscovery(ctx.db)).toEqual({
        started: 0,
        running: 1,
      });
      expect(await created()).toHaveLength(1);
      const predecessor = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "completed",
        input: mailboxDiscoveryInput.parse(retained.input),
      });
      await continueMailDiscovery(ctx.db, { runId: predecessor, attempt: 1 });
      expect(await created()).toHaveLength(2);
      expect(await readRun(state.params.runId)).toMatchObject({
        status: "failed",
        input: retained.input,
        progress: retained.progress,
      });
      expect(
        (await readJobs(ctx.db, { key: `run:${state.params.runId}` }))[0],
      ).toMatchObject({
        state: "retry_wait",
        attempts: 3,
        availableAt,
      });
      // A member stop cannot hold fresh admission hostage or be resumed by it.
      await updateJobs(
        ctx.db,
        { key: `run:${state.params.runId}` },
        { state: stoppedState },
      );
      await continueMailDiscovery(ctx.db, { runId: predecessor, attempt: 1 });
      expect(await created()).toHaveLength(3);
      expect((await readRun(state.params.runId)).status).toBe("failed");
      expect(
        (await readJobs(ctx.db, { key: `run:${state.params.runId}` }))[0]
          ?.state,
      ).toBe(stoppedState);
    },
  );

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
      await startMailDiscovery(ctx.db);
      const params = (await created())[pass];
      if (!params) throw new Error(`Synthetic pass ${pass} not launched`);
      await listMailDiscovery(ctx.db, params, seam);
      await saveMailDiscoveryBatch(ctx.db, params, 0, seam);
      await finishMailDiscovery(ctx.db, params);
      // Completed coverage never chains another pass.
      await continueMailDiscovery(ctx.db, params);
      expect(await created()).toHaveLength(pass + 1);
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
      research: (db, input) => startMailImport(db, input),
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
    expect(await readJobs(ctx.db, { kind: "purchase.dispatch" })).toHaveLength(
      1,
    );
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
    expect(await readJobs(ctx.db, { kind: "purchase.dispatch" })).toHaveLength(
      1,
    );
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

  it("bounds independent searches and fairly admits retained recovery without spending failure attempts", async () => {
    const state = await seed();
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 0,
      running: 1,
    });
    expect((await readRun(state.params.runId)).input).toMatchObject({
      mailboxId: "synthetic-google-subject",
    });
    await finishMailDiscovery(ctx.db, state.params);
    for (let index = 0; index < 5; index++)
      await insertWithShortcode(ctx.db, "vendor", {
        name: `Synthetic concurrent seller ${index}`,
        orderEmailSenders: [`orders@concurrent-${index}.example.test`],
      });
    const [target] = await listGmailSyncTargets(ctx.db);
    if (!target) throw new Error("Synthetic mailbox missing");
    const baseline = await initializeMailboxCoverage(
      gmail(),
      target.scopedQueries,
    );
    baseline.nextLane = "scan";
    await getDb(ctx.db)
      .update(mailboxCursor)
      .set({ coverage: baseline, historyId: "100" });
    let snapshotReady = () => {};
    let releaseSnapshot = () => {};
    const ready = new Promise<void>((resolve) => {
      snapshotReady = resolve;
    });
    const releaseOldSnapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshotAdmission = Promise.allSettled([
      withTransactionDatabase(
        ctx.db,
        async (tx) => {
          await getDb(tx).select({ id: mailboxCursor.id }).from(mailboxCursor);
          snapshotReady();
          await releaseOldSnapshot;
          const selected = target.scopedQueries.at(-1);
          if (!selected) throw new Error("Synthetic concurrent query missing");
          return ensureRun(tx, ctx.actor, {
            purpose: "mail_discovery",
            trigger: "scheduled",
            status: "running",
            input: {
              mailboxId: target.mailboxId,
              scopedQueries: target.scopedQueries,
              executionPolicy: "classification_only",
            },
            progress: mailboxDiscoveryProgress.parse({
              attempt: 0,
              phase: "listing",
              discoveryScope: { kind: "query", key: selected.key },
            }),
          });
        },
        { isolationLevel: "serializable" },
      ),
    ]);
    await ready;
    const racing = await Promise.all([
      startMailDiscovery(ctx.db),
      startMailDiscovery(ctx.db),
    ]).finally(async () => {
      releaseSnapshot();
      await snapshotAdmission;
    });
    const [stale] = await snapshotAdmission;
    expect(stale?.status).toBe("rejected");
    if (stale?.status !== "rejected") return;
    expect(findPgError(stale.reason)?.code).toBe("40001");
    expect(racing.reduce((total, result) => total + result.started, 0)).toBe(4);
    const active = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.status, "running"));
    expect(active).toHaveLength(4);
    const scopes = active.map(
      (row) => mailboxDiscoveryProgress.parse(row.progress).discoveryScope,
    );
    expect(scopes.every((scope) => scope?.kind === "query")).toBe(true);
    expect(
      new Set(
        scopes.map((scope) => (scope?.kind === "query" ? scope.key : null)),
      ).size,
    ).toBe(4);
    for (const row of active)
      expect(row.input).toMatchObject({ scopedQueries: target.scopedQueries });
    const [legacy] = await Promise.allSettled([
      ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "running",
        input: mailboxDiscoveryInput.parse(active[0]?.input),
        progress: mailboxDiscoveryProgress.parse({
          attempt: 0,
          phase: "listing",
        }),
      }),
    ]);
    expect(legacy?.status).toBe("rejected");
    if (legacy?.status !== "rejected") return;
    expect(findPgError(legacy.reason)?.constraint).toBe(
      "Run_one_active_mail_discovery",
    );

    let listings = 0;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seam = ports(
      gmail({
        listMessages: async () => {
          listings++;
          await barrier;
          return {};
        },
      }),
    );
    const listed = Promise.allSettled(
      active.map((row) =>
        listMailDiscovery(
          ctx.db,
          {
            runId: row.id,
            attempt: mailboxDiscoveryProgress.parse(row.progress).attempt,
          },
          seam,
        ),
      ),
    );
    try {
      await vi.waitFor(() => expect(listings).toBe(4));
    } finally {
      release();
      await listed;
    }
    expect((await listed).map((result) => result.status)).toEqual(
      Array(4).fill("fulfilled"),
    );

    const occupied = new Set(
      scopes.flatMap((scope) => (scope?.kind === "query" ? [scope.key] : [])),
    );
    const recoveryQuery = baseline.scoped.find(
      (query) => !occupied.has(query.key),
    );
    if (!recoveryQuery) throw new Error("Synthetic retained query missing");
    const page = await listGmailPage(
      gmail({ listMessages: async () => ({}) }),
      target.mailboxId,
      baseline,
      "targeted",
      [recoveryQuery.key],
    );
    const retainedInput = mailboxDiscoveryInput.parse(active[0]?.input);
    const recoveryId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "scheduled",
      status: "completed",
      execution: false,
      input: retainedInput,
      progress: mailboxDiscoveryProgress.parse({
        attempt: 1,
        phase: "failed",
        page,
      }),
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "job_failed" })
      .where(eq(run.id, recoveryId));
    const job = await enqueueJob(ctx.db, {
      key: `run:${recoveryId}`,
      kind: "run.execute",
      runId: recoveryId,
      input: { runId: recoveryId, purpose: "mail_discovery" },
    });
    await updateJobs(ctx.db, { key: job.key }, { state: "completed" });
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      {
        runPublicId: (await readRun(recoveryId)).shortcode,
        action: "retry",
      },
      "mail_discovery",
    );
    const queued = await readRun(recoveryId);
    const { runScaffold } = await import("~/server/domains/run/repo/run");
    expect(
      (
        await runScaffold.read(ctx.db, {
          filters: { ids: [queued.shortcode], needsAttention: true },
          sorts: [],
          pagination: { pageIndex: 0, pageSize: 10 },
        })
      ).data,
    ).toEqual([]);
    const { readRecordWorkQueue } =
      await import("~/server/domains/work/service/work-queue-read");
    const waitingWork = await readRecordWorkQueue(ctx.db, {
      id: queued.shortcode,
      memberPartyId: null,
      memberOnly: false,
    });
    expect(waitingWork.items.some((row) => row.family === "account")).toBe(
      false,
    );
    expect(waitingWork.items).toContainEqual(
      expect.objectContaining({ family: "execution", executor: "automatic" }),
    );
    // A terminal canonical Job must expose the stranded Run instead of hiding it.
    await updateJobs(ctx.db, { key: job.key }, { state: "failed" });
    expect(
      (
        await runScaffold.read(ctx.db, {
          filters: { ids: [queued.shortcode], needsAttention: true },
          sorts: [],
          pagination: { pageIndex: 0, pageSize: 10 },
        })
      ).data.some((row) => row.id === queued.shortcode),
    ).toBe(true);
    expect(
      (
        await readRecordWorkQueue(ctx.db, {
          id: queued.shortcode,
          memberPartyId: null,
          memberOnly: false,
        })
      ).items.some((row) => row.family === "account"),
    ).toBe(true);
    expect(await readRun(recoveryId)).toEqual(queued);
    await updateJobs(ctx.db, { key: job.key }, { state: "queued" });
    expect(
      summarizeDiscoveryProgress(
        mailboxDiscoveryProgress.parse(queued.progress),
      ),
    ).not.toHaveProperty("discoveryScope");
    expect(
      summarizeDiscoveryProgress(
        mailboxDiscoveryProgress.parse(queued.progress),
      ),
    ).not.toHaveProperty("admissionRequestedAt");
    expect(queued).toMatchObject({
      status: "paused",
      failureCode: "mail_discovery_queued",
      input: retainedInput,
      progress: {
        page,
        discoveryScope: { kind: "query", key: recoveryQuery.key },
      },
    });
    const { advanceJob } = await import("~/server/generic/jobs/service/jobs");
    const { runJobHandler } =
      await import("~/server/workflows/runs/job-execution");
    for (let attempt = 0; attempt < 4; attempt++) {
      await updateJobs(ctx.db, { key: job.key }, { availableAt: new Date() });
      expect(
        await advanceJob(ctx.db, job.id, { "run.execute": runJobHandler }),
      ).toBe("deferred");
      expect((await readJobs(ctx.db, { key: job.key }))[0]).toMatchObject({
        state: "queued",
        attempts: 0,
        generation: 2,
        waitReason: "provider_capacity",
      });
    }
    expect((await readRun(recoveryId)).progress).toEqual(queued.progress);
    const normalVacancy = active[3];
    if (!normalVacancy) throw new Error("Synthetic fourth search missing");
    const priorActive = await Promise.all(
      active.map((owner) => readRun(owner.id)),
    );
    // Three admitted recoveries cannot reserve the remaining normal lane.
    for (const owner of priorActive.slice(0, 3))
      await getDb(ctx.db)
        .update(run)
        .set({
          progress: {
            ...mailboxDiscoveryProgress.parse(owner.progress),
            admissionClass: "recovery",
          },
        })
        .where(eq(run.id, owner.id));
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, normalVacancy.id));
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 1,
      running: 0,
    });
    const [normalFourth] = (
      await getDb(ctx.db).select().from(run).where(eq(run.status, "running"))
    ).filter((owner) => !active.some((prior) => prior.id === owner.id));
    if (!normalFourth) throw new Error("Synthetic fourth normal lane missing");
    expect(
      mailboxDiscoveryProgress.parse(normalFourth.progress).admissionClass,
    ).toBe("automatic");
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: normalFourth.shortcode, action: "cancel" },
      "mail_discovery",
    );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "running" })
      .where(eq(run.id, normalVacancy.id));
    for (const owner of priorActive.slice(0, 3))
      await getDb(ctx.db)
        .update(run)
        .set({ progress: owner.progress })
        .where(eq(run.id, owner.id));
    const historyPage = await listGmailPage(
      gmail(),
      target.mailboxId,
      baseline,
      "new_mail",
    );
    const exclusiveId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "scheduled",
      status: "completed",
      execution: false,
      input: retainedInput,
      progress: mailboxDiscoveryProgress.parse({
        attempt: 1,
        phase: "failed",
        page: historyPage,
      }),
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "job_failed" })
      .where(eq(run.id, exclusiveId));
    const exclusiveJob = await enqueueJob(ctx.db, {
      key: `run:${exclusiveId}`,
      kind: "run.execute",
      runId: exclusiveId,
      input: { runId: exclusiveId, purpose: "mail_discovery" },
    });
    await updateJobs(ctx.db, { key: exclusiveJob.key }, { state: "completed" });
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      {
        runPublicId: (await readRun(exclusiveId)).shortcode,
        action: "retry",
      },
      "mail_discovery",
    );
    expect(await readRun(exclusiveId)).toMatchObject({
      status: "paused",
      progress: { discoveryScope: { kind: "mailbox" } },
    });
    const first = active[0];
    if (!first) throw new Error("Synthetic active search missing");
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: first.shortcode, action: "cancel" },
      "mail_discovery",
    );
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 0,
      running: 1,
    });
    await updateJobs(ctx.db, { key: job.key }, { availableAt: new Date() });
    expect(
      await advanceJob(ctx.db, job.id, { "run.execute": runJobHandler }),
    ).toBe("succeeded");
    expect(await readRun(recoveryId)).toMatchObject({
      status: "running",
      failureCode: null,
      input: retainedInput,
      progress: {
        page,
        attempt: 2,
        discoveryScope: { kind: "query", key: recoveryQuery.key },
      },
    });
    const finishing = [
      ...active.slice(1).map((row) => ({
        runId: row.id,
        attempt: mailboxDiscoveryProgress.parse(row.progress).attempt,
      })),
      { runId: recoveryId, attempt: 2 },
    ];
    await Promise.all(
      finishing.map((params) =>
        saveMailDiscoveryBatch(ctx.db, params, 0, ports(gmail())),
      ),
    );
    const [cursor] = await getDb(ctx.db).select().from(mailboxCursor);
    expect(
      cursor?.coverage?.scoped.filter((query) => query.completed),
    ).toHaveLength(4);
    expect(
      cursor?.coverage?.scoped.filter((query) => !query.completed),
    ).toHaveLength(target.scopedQueries.length - 4);
    expect(
      cursor?.coverage?.scoped.every((query) => (query.emailCount ?? 0) === 0),
    ).toBe(true);
    expect(cursor?.coverage?.history).toEqual(baseline.history);
    for (const params of finishing) {
      expect(await readRun(params.runId)).toMatchObject({
        progress: { pagesDone: 1 },
      });
      await finishMailDiscovery(ctx.db, params);
    }
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 1,
      running: 0,
    });
    const normalWaiters = (
      await getDb(ctx.db).select().from(run).where(eq(run.status, "paused"))
    ).filter(
      (row) =>
        mailboxDiscoveryProgress.parse(row.progress).admissionClass ===
        "automatic",
    );
    expect(normalWaiters).toHaveLength(1);
    await updateJobs(
      ctx.db,
      { key: exclusiveJob.key },
      { availableAt: new Date() },
    );
    expect(
      await advanceJob(ctx.db, exclusiveJob.id, {
        "run.execute": runJobHandler,
      }),
    ).toBe("succeeded");
    expect(await readRun(exclusiveId)).toMatchObject({
      status: "running",
      input: retainedInput,
      progress: {
        page: historyPage,
        attempt: 2,
        discoveryScope: { kind: "mailbox" },
      },
    });
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 0,
      running: 1,
    });
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      {
        runPublicId: (await readRun(exclusiveId)).shortcode,
        action: "cancel",
      },
      "mail_discovery",
    );
    expect((await readRun(first.id)).failureCode).toBe("user_cancelled");
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    const cfEnv = await import("~/server/cf-env");
    const tokens = await import("../../repo/gmail/tokens");
    const providers = await import("../../repo/gmail/provider");
    const until = new Date(Math.ceil((Date.now() + 120_000) / 1_000) * 1_000);
    const fetchGmail = vi.fn(async () => {
      return new Response("Synthetic shared Gmail throttle", {
        status: 429,
        headers: { "retry-after": until.toUTCString() },
      });
    });
    const rawProvider = createGmailApiClient({
      accessToken: "synthetic-token",
      fetcher: fetchGmail,
    });
    const credentials = vi
      .spyOn(cfEnv, "getGmailOAuthCredentials")
      .mockReturnValue({
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      });
    const factory = vi
      .spyOn(tokens, "createGmailProviderFactory")
      .mockReturnValue(async () => rawProvider);
    try {
      const clientA = await providers.gmailProviderForUser(
        ctx.db,
        ctx.actor.userId,
        target.mailboxId,
      );
      const clientB = await providers.gmailProviderForUser(
        ctx.db,
        ctx.actor.userId,
        target.mailboxId,
      );
      await expect(clientA.getProfile()).rejects.toMatchObject({
        status: 429,
        message: expect.stringContaining("Synthetic shared Gmail throttle"),
      });
      const normal = normalWaiters[0];
      if (!normal) throw new Error("Synthetic queued history missing");
      const [normalJob] = await readJobs(ctx.db, { key: `run:${normal.id}` });
      if (!normalJob) throw new Error("Synthetic history Job missing");
      expect(
        await advanceJob(ctx.db, normalJob.id, {
          "run.execute": runJobHandler,
        }),
      ).toBe("deferred");
      expect((await readJobs(ctx.db, { key: normalJob.key }))[0]).toMatchObject(
        {
          state: "queued",
          attempts: 0,
          generation: 1,
          waitReason: "rate_limit",
          availableAt: until,
        },
      );
      expect(await readRun(normal.id)).toMatchObject({
        status: "running",
        progress: { admissionClass: "automatic" },
      });
      await expect(clientB.getProfile()).rejects.toMatchObject({
        status: 429,
        retryAt: until.getTime(),
      });
      expect(fetchGmail).toHaveBeenCalledOnce();
      expect(
        (await getDb(ctx.db).select().from(mailboxCursor))[0],
      ).toMatchObject({
        coverage: cursor?.coverage,
        providerRetryAt: until,
      });
      expect(await getDb(ctx.db).select().from(runControlEvent)).toEqual([]);
      expect(await getDb(ctx.db).select().from(aiUsage)).toEqual([]);
      const paidStart = {
        target,
        paidGrant: { actor: ctx.actor, paidOverBudgetUsd: 1 },
      };
      expect(await startMailDiscovery(ctx.db, paidStart)).toEqual({
        started: 0,
        running: 1,
      });
      expect(await getDb(ctx.db).select().from(runControlEvent)).toMatchObject([
        { runId: normal.id, paidOverBudgetUsd: 1 },
      ]);
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: normal.shortcode, action: "cancel" },
        "mail_discovery",
      );
      if (!cursor?.coverage)
        throw new Error("Synthetic query coverage missing");
      await getDb(ctx.db)
        .update(mailboxCursor)
        .set({ coverage: { ...cursor.coverage, nextLane: "scan" } });
      // A confirmed allowance must not be copied onto every free search lane.
      expect(await startMailDiscovery(ctx.db, paidStart)).toEqual({
        started: 1,
        running: 0,
      });
      const grants = await getDb(ctx.db).select().from(runControlEvent);
      expect(grants).toHaveLength(2);
      expect(new Set(grants.map((grant) => grant.runId)).size).toBe(2);
      expect(
        await getDb(ctx.db).select().from(run).where(eq(run.status, "running")),
      ).toHaveLength(1);
      expect(await getDb(ctx.db).select().from(aiUsage)).toEqual([]);
      // Independent history must not hold a partial query across every Job
      // quantum, or switch into that parked query when the cursor changes lane.
      const grantsBeforeYield = await getDb(ctx.db)
        .select()
        .from(runControlEvent);
      for (const owner of await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.status, "running")))
        await controlWorkflowRun(
          ctx.db,
          ctx.actor,
          {
            runPublicId: owner.shortcode,
            action: "cancel",
          },
          "mail_discovery",
        );
      const partialQuery = target.scopedQueries.at(-1);
      if (!partialQuery) throw new Error("Synthetic partial query missing");
      const partial = await listGmailPage(
        gmail({
          listMessages: async () => ({
            messages: Array.from({ length: 6 }, (_, index) => ({
              id: `synthetic-yield-${index}`,
            })),
          }),
        }),
        target.mailboxId,
        baseline,
        "targeted",
        [partialQuery.key],
      );
      partial.messageOffset = 1;
      const queryOwner = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "running",
        execution: false,
        input: retainedInput,
        progress: mailboxDiscoveryProgress.parse({
          attempt: 1,
          phase: "fetching",
          page: partial,
          discoveryScope: { kind: "query", key: partialQuery.key },
          admissionClass: "automatic",
        }),
      });
      const queryJob = await enqueueJob(ctx.db, {
        key: `run:${queryOwner}`,
        kind: "run.execute",
        runId: queryOwner,
        input: { runId: queryOwner, purpose: "mail_discovery" },
      });
      const queueOwner = async (
        scope: { kind: "mailbox" } | { kind: "query"; key: string },
        requestedAt: string,
      ) => {
        const id = await ensureRun(ctx.db, ctx.actor, {
          purpose: "mail_discovery",
          trigger: "scheduled",
          status: "completed",
          execution: false,
          input: retainedInput,
          progress: mailboxDiscoveryProgress.parse({
            attempt: 1,
            phase: "paused",
            discoveryScope: scope,
            admissionClass: scope.kind === "mailbox" ? "automatic" : "recovery",
            admissionRequestedAt: requestedAt,
          }),
        });
        await getDb(ctx.db)
          .update(run)
          .set({ status: "paused", failureCode: "mail_discovery_queued" })
          .where(eq(run.id, id));
        const saved = await enqueueJob(ctx.db, {
          key: `run:${id}`,
          kind: "run.execute",
          runId: id,
          input: { runId: id, purpose: "mail_discovery" },
        });
        return { id, job: saved };
      };
      const historyOwner = await queueOwner(
        { kind: "mailbox" },
        new Date(Date.now() - 2_000).toISOString(),
      );
      const beforeYield = await readRun(queryOwner);
      expect(
        await advanceJob(ctx.db, queryJob.id, { "run.execute": runJobHandler }),
      ).toBe("deferred");
      const parked = await readRun(queryOwner);
      expect(parked).toMatchObject({
        status: "paused",
        input: beforeYield.input,
        progress: {
          page: partial,
          attempt: 1,
          discoveryScope: { kind: "query", key: partialQuery.key },
        },
      });
      expect((await readJobs(ctx.db, { key: queryJob.key }))[0]).toMatchObject({
        state: "queued",
        attempts: 0,
        generation: 1,
        cursor: null,
      });
      const duplicate = await queueOwner(
        { kind: "query", key: partialQuery.key },
        new Date(Date.now() + 1_000).toISOString(),
      );
      const scan = vi.fn(async () => {
        throw new Error("History owner touched parked query");
      });
      const history = vi.fn(async () => ({ historyId: "160" }));
      factory.mockReturnValue(async () =>
        gmail({ listMessages: scan, listHistory: history }),
      );
      // The history waiter was created before a preceding history pass selected scan.
      const [latestCursor] = await getDb(ctx.db).select().from(mailboxCursor);
      if (!latestCursor?.coverage)
        throw new Error("Synthetic current coverage missing");
      await getDb(ctx.db)
        .update(mailboxCursor)
        .set({
          // The preceding throttle scenario is settled before fresh admission.
          providerRetryAt: null,
          coverage: { ...latestCursor.coverage, nextLane: "scan" },
        });
      expect(
        await advanceJob(ctx.db, historyOwner.job.id, {
          "run.execute": runJobHandler,
        }),
      ).toBe("succeeded");
      expect(history).toHaveBeenCalledOnce();
      expect(scan).not.toHaveBeenCalled();
      // Even an empty frozen history page keeps its event proof until checkpoint.
      const historyBefore = await readRun(historyOwner.id);
      const yieldUnderClaim = (id: typeof queryOwner) =>
        withJobFixtureExecution(
          ctx.db,
          {
            key: `run:${id}`,
            kind: "run.execute",
            runId: id,
            input: { runId: id, purpose: "mail_discovery" },
          },
          () => yieldClaimedMailDiscovery(ctx.db, { runId: id, attempt: 1 }),
          { releaseClaim: true },
        );
      await yieldUnderClaim(historyOwner.id);
      expect(await readRun(historyOwner.id)).toEqual(historyBefore);
      await saveMailDiscoveryBatch(
        ctx.db,
        { runId: historyOwner.id, attempt: 1 },
        0,
        ports(gmail()),
      );
      // A completed history page can relinquish ownership before listing again.
      await expect(yieldUnderClaim(historyOwner.id)).rejects.toMatchObject({
        reason: "provider_capacity",
      });
      await finishMailDiscovery(ctx.db, { runId: historyOwner.id, attempt: 1 });
      // The synthetic page is settled; close this fixture without launching continuations.
      await getDb(ctx.db)
        .update(run)
        .set({ status: "completed" })
        .where(eq(run.id, historyOwner.id));
      await updateJobs(
        ctx.db,
        { key: historyOwner.job.key },
        { state: "completed" },
      );
      expect(
        await advanceJob(ctx.db, duplicate.job.id, {
          "run.execute": runJobHandler,
        }),
      ).toBe("deferred");
      expect(await readRun(queryOwner)).toEqual(parked);
      // Fresh continuations leave a vacancy for an older yielded query, even
      // when a younger recovery for its same resource cannot yet enter.
      for (let index = 0; index < 3; index++)
        await insertWithShortcode(ctx.db, "vendor", {
          name: `Synthetic fresh fair seller ${index}`,
          orderEmailSenders: [`orders@fresh-fair-${index}.example.test`],
        });
      expect((await startMailDiscovery(ctx.db)).started).toBe(3);
      const freshOwners = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.status, "running"));
      expect(freshOwners).toHaveLength(3);
      const freshOwner = freshOwners[0];
      if (!freshOwner) throw new Error("Synthetic fresh owner missing");
      const [freshJob] = await readJobs(ctx.db, {
        key: `run:${freshOwner.id}`,
      });
      if (!freshJob) throw new Error("Synthetic fresh Job missing");
      // The native stale snapshot above also models a rolled-back Email read:
      // capacity backpressure keeps its cursor and ordinary failure allowance.
      factory.mockReturnValueOnce(async () => {
        throw stale.reason;
      });
      expect(
        await advanceJob(ctx.db, freshJob.id, { "run.execute": runJobHandler }),
      ).toBe("deferred");
      expect(await readRun(freshOwner.id)).toEqual(freshOwner);
      expect((await readJobs(ctx.db, { key: freshJob.key }))[0]).toMatchObject({
        state: "queued",
        cursor: null,
        generation: 1,
        attempts: 0,
        waitReason: "provider_capacity",
      });
      await updateJobs(
        ctx.db,
        { key: queryJob.key },
        { availableAt: new Date() },
      );
      expect(
        await advanceJob(ctx.db, queryJob.id, { "run.execute": runJobHandler }),
      ).toBe("succeeded");
      expect(await readRun(queryOwner)).toMatchObject({
        status: "running",
        progress: { page: partial },
      });
      expect((await readJobs(ctx.db, { key: queryJob.key }))[0]).toMatchObject({
        cursor: { phase: "save", index: 0, more: false },
        attempts: 0,
        generation: 1,
      });
      // Existing same-query demand must not advance this frozen position.
      const resumed = await readRun(queryOwner);
      await yieldUnderClaim(queryOwner);
      expect(await readRun(queryOwner)).toEqual(resumed);
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        {
          runPublicId: (await readRun(duplicate.id)).shortcode,
          action: "cancel",
        },
        "mail_discovery",
      );
      await queueOwner({ kind: "mailbox" }, new Date().toISOString());
      expect(
        await advanceJob(ctx.db, queryJob.id, { "run.execute": runJobHandler }),
      ).toBe("deferred");
      expect(await readRun(queryOwner)).toMatchObject({
        status: "paused",
        progress: { page: partial },
      });
      expect((await readJobs(ctx.db, { key: queryJob.key }))[0]).toMatchObject({
        cursor: { phase: "save", index: 0, more: false },
        attempts: 0,
        generation: 1,
      });
      // Corrupt only the synthetic claim after acquisition: neither stale
      // generation nor lease may commit the otherwise eligible Run yield.
      for (const stale of ["generation", "lease"]) {
        await getDb(ctx.db)
          .update(run)
          .set({ status: "running" })
          .where(eq(run.id, queryOwner));
        await updateJobs(
          ctx.db,
          { key: queryJob.key },
          {
            state: "queued",
            generation: 1,
            availableAt: new Date(),
          },
        );
        const fencedOwner = await readRun(queryOwner);
        await expect(
          withJobFixtureExecution(
            ctx.db,
            {
              key: queryJob.key,
              kind: "run.execute",
              runId: queryOwner,
              input: { runId: queryOwner, purpose: "mail_discovery" },
            },
            async () => {
              await updateJobs(
                ctx.db,
                { key: queryJob.key },
                stale === "generation"
                  ? { generation: 2 }
                  : { leaseToken: crypto.randomUUID() },
              );
              await yieldClaimedMailDiscovery(ctx.db, {
                runId: queryOwner,
                attempt: 1,
              });
            },
            { releaseClaim: true },
          ),
        ).rejects.toThrow(/obsolete/);
        expect(await readRun(queryOwner)).toEqual(fencedOwner);
      }
      await updateJobs(
        ctx.db,
        { key: queryJob.key },
        { state: "queued", generation: 1, availableAt: new Date() },
      );
      const successorOwner = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "completed",
        execution: false,
        input: retainedInput,
      });
      await getDb(ctx.db)
        .update(run)
        .set({ predecessorRunId: queryOwner })
        .where(eq(run.id, successorOwner));
      const supersededOwner = await readRun(queryOwner);
      await yieldUnderClaim(queryOwner);
      expect(await readRun(queryOwner)).toEqual(supersededOwner);
      // Remove the synthetic successor so cancellation exercises its own guard.
      await getDb(ctx.db)
        .update(run)
        .set({ deletedAt: new Date() })
        .where(eq(run.id, successorOwner));
      await withJobFixtureExecution(
        ctx.db,
        {
          key: queryJob.key,
          kind: "run.execute",
          runId: queryOwner,
          input: { runId: queryOwner, purpose: "mail_discovery" },
        },
        async () => {
          // A member control arrives outside the executing Job's async context.
          await getDb(ctx.db)
            .update(run)
            .set({ status: "failed", failureCode: "user_cancelled" })
            .where(eq(run.id, queryOwner));
          await updateJobs(
            ctx.db,
            { key: queryJob.key },
            { state: "cancelled" },
          );
          const stoppedOwner = await readRun(queryOwner);
          await yieldClaimedMailDiscovery(ctx.db, {
            runId: queryOwner,
            attempt: 1,
          });
          expect(await readRun(queryOwner)).toEqual(stoppedOwner);
        },
        { releaseClaim: true },
      );
      expect(await getDb(ctx.db).select().from(runControlEvent)).toEqual(
        grantsBeforeYield,
      );
      expect(await getDb(ctx.db).select().from(aiUsage)).toEqual([]);
    } finally {
      credentials.mockRestore();
      factory.mockRestore();
    }
  });
  it("does not starve a second connected mailbox belonging to the same member", async () => {
    await seed();
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
    expect(await startMailDiscovery(ctx.db)).toEqual({
      started: 1,
      running: 1,
    });
    expect(await created()).toHaveLength(2);
    expect((await readRun((await created())[1]!.runId)).input).toMatchObject({
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
    const messages = Array.from({ length: 11 }, (_, index) => ({
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
    let expectedHistoryId = "100";
    seam.research = async (_db, input) => {
      sizes.push(input.messageIds.length);
      if (input.messageIds.length > 50)
        throw new Error("Synthetic source set exceeds import batch bound");
      expect(
        (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.history
          .historyId,
      ).toBe(expectedHistoryId);
      return [];
    };
    await listMailDiscovery(ctx.db, state.params, seam);
    expect(await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam)).toEqual(
      { kind: "more" },
    );
    expect((await readRun(state.params.runId)).progress).toMatchObject({
      pagesDone: 0,
      page: { messageOffset: 5 },
    });
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage?.history
        .historyId,
    ).toBe("100");
    expect(await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam)).toEqual(
      { kind: "more" },
    );
    const [cursor] = await getDb(ctx.db).select().from(mailboxCursor);
    if (!cursor?.coverage) throw new Error("Synthetic history cursor missing");
    const advanced = {
      ...cursor.coverage,
      history: { historyId: "160", pageToken: null, targetHistoryId: null },
    };
    await getDb(ctx.db)
      .update(mailboxCursor)
      .set({ coverage: advanced })
      .where(eq(mailboxCursor.id, cursor.id));
    expectedHistoryId = "160";
    expect(await saveMailDiscoveryBatch(ctx.db, state.params, 0, seam)).toEqual(
      { kind: "done" },
    );
    expect(sizes).toEqual([5, 5, 1]);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(11);
    expect(
      (await getDb(ctx.db).select().from(mailboxCursor))[0]?.coverage,
    ).toEqual(advanced);
    expect((await readRun(state.params.runId)).progress).toMatchObject({
      pagesDone: 1,
      saved: 11,
    });
  });
  it("pauses revoked authentication without moving the page or negatively classifying it, then reconnects", async () => {
    const state = await seed();
    const initial = await readRun(state.params.runId);
    expect(
      await listMailDiscovery(
        ctx.db,
        state.params,
        ports(
          gmail({
            getProfile: async () => {
              throw new GmailAuthorizationError(
                "Synthetic authorization expired before initialization",
              );
            },
          }),
        ),
      ),
    ).toEqual({ kind: "stopped" });
    expect(await readRun(state.params.runId)).toMatchObject({
      status: "paused_auth",
      failureCode: "gmail_reconnect_required",
      input: initial.input,
      progress: { phase: "paused", discoveryScope: { kind: "mailbox" } },
    });
    expect(
      mailboxDiscoveryProgress.parse(
        (await readRun(state.params.runId)).progress,
      ).page,
    ).toBeUndefined();
    const reconnected = await launchWorkflowRun(ctx.db, {
      runId: runEntityId.parse(state.params.runId),
      purpose: "mail_discovery",
    });
    state.params.attempt = reconnected.attempt;
    expect(
      mailboxDiscoveryProgress.parse(
        (await readRun(state.params.runId)).progress,
      ).discoveryScope,
    ).toEqual({ kind: "mailbox" });
    const provider = gmail({
      getMessage: async () => {
        throw new GmailAuthorizationError("Synthetic revoked authorization");
      },
    });
    await listMailDiscovery(ctx.db, state.params, ports(provider));
    expect(
      mailboxDiscoveryProgress.parse(
        (await readRun(state.params.runId)).progress,
      ).page?.scopedKey,
    ).toBeDefined();
    expect(
      await saveMailDiscoveryBatch(ctx.db, state.params, 0, ports(provider)),
    ).toEqual({ kind: "stopped" });
    expect((await readRun(state.params.runId)).status).toBe("paused_auth");
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual([]);
    const next = await launchWorkflowRun(ctx.db, {
      runId: runEntityId.parse(state.params.runId),
      purpose: "mail_discovery",
    });
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
      const frozenProgress = mailboxDiscoveryProgress.parse(
        (await readRun(state.params.runId)).progress,
      );
      await saveMailDiscoveryBatch(ctx.db, state.params, 0, ports(provider));
      await finishMailDiscovery(ctx.db, state.params);
      const completed = await readRun(state.params.runId);
      const waitingRun = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "completed",
        input: mailboxDiscoveryInput.parse(completed.input),
        execution: false,
      });
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "paused_auth",
          failureCode: "execution_limit",
          progress: { ...frozenProgress, phase: "paused" },
        })
        .where(eq(run.id, waitingRun));
      const until = new Date(Date.now() + 3_600_000);
      const waitingJob = await enqueueJob(ctx.db, {
        key: `run:${waitingRun}`,
        kind: "run.execute",
        input: { runId: waitingRun, purpose: "mail_discovery" },
        runId: waitingRun,
        availableAt: until,
      });
      await updateJobs(
        ctx.db,
        { id: waitingJob.id },
        { waitReason: "ai_funding_window" },
      );
      const retainedRun = await readRun(waitingRun);
      const [retainedJob] = await readJobs(ctx.db, { id: waitingJob.id });
      await continueMailDiscovery(ctx.db, state.params);
      await continueMailDiscovery(ctx.db, state.params);
      expect(
        await getDb(ctx.db)
          .select({ id: run.id })
          .from(run)
          .where(
            eq(run.clientKey, `mailbox-continuation:${state.params.runId}`),
          ),
      ).toEqual([]);
      expect(await readRun(waitingRun)).toEqual(retainedRun);
      expect((await readJobs(ctx.db, { id: waitingJob.id }))[0]).toEqual(
        retainedJob,
      );
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "completed",
          failureCode: null,
          progress: completed.progress,
        })
        .where(eq(run.id, waitingRun));
      await updateJobs(
        ctx.db,
        { id: waitingJob.id },
        { state: "completed", waitReason: null },
      );
      await continueMailDiscovery(ctx.db, state.params);
      await continueMailDiscovery(ctx.db, state.params);
      const admitted = (await created()).filter(
        (params) => params.runId !== waitingRun,
      );
      expect(admitted).toHaveLength(scanPending ? 2 : 1);
      expect(
        await Promise.all(
          admitted
            .slice(1)
            .map(async (params) => (await readRun(params.runId)).input),
        ),
      ).toEqual(scanPending ? [(await readRun(state.params.runId)).input] : []);
    },
  );
});
