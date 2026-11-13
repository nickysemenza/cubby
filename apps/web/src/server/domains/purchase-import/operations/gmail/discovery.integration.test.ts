/** Plausible failures: baseline capture follows listing; pages checkpoint before
 * source/Mail import dispatch; interrupted pages duplicate sources; retries replay a
 * changed manifest; revoked auth becomes negative; stale attempts move coverage;
 * bounded passes wait a day instead of scheduling the next durable pass;
 * targeted search falls through to whole-mailbox history or searches a Vendor
 * name; completed coverage keeps chaining passes; one mailbox starves another. */
import { runEntityId, vendorShortcode } from "@cubby/schemas/identifiers";
import { kernelWaitCause } from "@cubby/schemas/kernel/machinery";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  mailboxCursor,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  run,
  vendor,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { setMailImport } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readRunPass } from "~/server/domains/run/repo/run-execution";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";
import { withRunPassFixture } from "~/server/workflows/runs/pass.fixtures";

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
  withRunPassFixture(args[0], args[1].runId, () =>
    listMailDiscoveryImplementation(...args),
  );
const saveMailDiscoveryBatch = (
  ...args: Parameters<typeof saveMailDiscoveryBatchImplementation>
) =>
  withRunPassFixture(args[0], args[1].runId, () =>
    saveMailDiscoveryBatchImplementation(...args),
  );
const finishMailDiscovery = (
  ...args: Parameters<typeof finishMailDiscoveryImplementation>
) =>
  withRunPassFixture(args[0], args[1].runId, () =>
    finishMailDiscoveryImplementation(...args),
  );
const continueMailDiscovery = (
  ...args: Parameters<typeof continueMailDiscoveryImplementation>
) =>
  withRunPassFixture(args[0], args[1].runId, () =>
    continueMailDiscoveryImplementation(...args),
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
      await repositoryQueries(ctx.db).execute<{
        runId: string;
        attempt: number;
      }>(sql`
      SELECT p.key AS "runId", (p.cursor->>'generation')::int AS attempt FROM "Pass" p
      WHERE p.name = 'run.execute' ORDER BY p."createdAt", p.key`)
    ).rows
      .filter((row) => discovery.has(runEntityId.parse(row.runId)))
      .map((row) => ({ ...row, runId: runEntityId.parse(row.runId) }));
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
      const finishedExecution = await readRunPass(ctx.db, successor.runId);
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
      await repositoryQueries(ctx.db).execute(
        sql`UPDATE "Pass" SET "doneAt" = now(), "claimToken" = NULL, "claimDeadline" = NULL WHERE name = 'run.execute' AND key = ${successor.runId}`,
      );
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: frozenRun.shortcode, action: "retry" },
        "mail_discovery",
      );
      const retriedExecution = await readRunPass(ctx.db, successor.runId);
      expect(retriedExecution).toMatchObject({
        runId: successor.runId,
        state: "due",
        generation: (finishedExecution.generation ?? 0) + 1,
      });
      if (!retriedExecution)
        throw new Error("Synthetic retried execution missing");
      expect(await readRun(successor.runId)).toMatchObject({
        status: "running",
        input: frozenRun.input,
        progress: { page: frozen, attempt: retriedExecution.generation ?? 1 },
      });
      const retry = { ...successor, attempt: retriedExecution.generation ?? 1 };
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
  it("retains a provider page and its funding deadline as a Pass wait", async () => {
    const state = await seed();
    const { advanceRunPass } =
      await import("~/server/workflows/runs/pass.fixtures");
    const { AiBudgetExhaustedError } = await import("~/server/ai/budget");
    const { pauseForFunding } =
      await import("~/server/domains/run/repo/execution-context");
    const discovery = await import("./discovery");
    const windowEnd = new Date(Date.now() + 3_600_000).toISOString();
    const budget = new AiBudgetExhaustedError(
      {
        windowStart: new Date().toISOString(),
        windowEnd,
        credit: { spentUsd: 1 },
        openaiCredit: { spentUsd: 1 },
        plan: { limitUsd: 1, spentUsd: 1 },
        paid: { limitUsd: 1, spentUsd: 1 },
      },
      "Synthetic funding refusal",
    );
    const relevance = vi.fn(async () => {
      await pauseForFunding(
        ctx.db,
        runEntityId.parse(state.params.runId),
        budget,
      );
      throw budget;
    });
    const seam: DiscoveryPorts = {
      ...ports(gmail()),
      triage: async () => "uncertain",
      relevance,
    };
    const real = discovery.advanceMailDiscoveryPage;
    const page = vi
      .spyOn(discovery, "advanceMailDiscoveryPage")
      .mockImplementation((db, params, cursor) =>
        real(db, params, cursor, seam),
      );
    try {
      await advanceRunPass(ctx.db);
      const frozen = await readRun(state.params.runId);
      await advanceRunPass(ctx.db);
      expect(await readRun(state.params.runId)).toMatchObject({
        status: "paused_auth",
        failureCode: "execution_limit",
        input: frozen.input,
        progress: frozen.progress,
      });
      expect(await readRunPass(ctx.db, state.params.runId)).toMatchObject({
        state: "waiting",
        waitCause: "funding",
        attempts: 0,
        availableAt: budget.until,
      });
      const calls = relevance.mock.calls.length;
      await repositoryQueries(ctx.db).execute(
        sql`UPDATE "Pass" SET "availableAt" = now() WHERE name = 'run.execute' AND key = ${state.params.runId}`,
      );
      await advanceRunPass(ctx.db);
      expect(relevance).toHaveBeenCalledTimes(calls);
      expect(await readRunPass(ctx.db, state.params.runId)).toMatchObject({
        waitCause: "funding",
        availableAt: budget.until,
        attempts: 0,
      });
    } finally {
      page.mockRestore();
    }
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
      const { startRunPass } = await import("~/server/workflows/runs/run-pass");
      await startRunPass(ctx.db, {
        runId: waitingRun,
        purpose: "mail_discovery",
        generation: 1,
        restart: false,
      });
      await repositoryQueries(ctx.db).execute(
        sql`UPDATE "Pass" SET "availableAt" = ${until.toISOString()}::timestamp, "waitCause" = ${kernelWaitCause.enum.funding} WHERE name = 'run.execute' AND key = ${waitingRun}`,
      );
      const retainedRun = await readRun(waitingRun);
      const retainedPass = await readRunPass(ctx.db, waitingRun);
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
      expect(await readRunPass(ctx.db, waitingRun)).toEqual(retainedPass);
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "completed",
          failureCode: null,
          progress: completed.progress,
        })
        .where(eq(run.id, waitingRun));
      await repositoryQueries(ctx.db).execute(
        sql`UPDATE "Pass" SET "doneAt" = now(), "waitCause" = NULL WHERE name = 'run.execute' AND key = ${waitingRun}`,
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
