import { runEntityId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as cloud from "~/server/cf-env";
import { account } from "~/server/db/auth.schema";
import {
  mailboxCursor,
  mailboxMessage,
  orderMail,
  run,
  runEvidence,
  runTarget,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import * as gmail from "./gmail/provider";
import { GmailAuthorizationError } from "./gmail/tokens";
import * as routing from "./gmail/triage-model";
import type { GmailProvider } from "./gmail/types";
import { startProductResearch } from "./product-research-run";
import { startMailResearch } from "./research-run";
import { researchServiceFor } from "./research-service";
import { startOrResumeRun } from "./run-service";

const toolResult = z.record(z.string(), z.json());

// Boundary failures: Product/account research cannot search; scoped paging loses
// history or leaks provider tokens; replay starts duplicate children; discovery
// steals parent write authority; foreign task/mailbox/query continuations work;
// fresh searches cannot choose another mailbox; continuation accounts switch;
// context reads steal another Run's source ownership; negative mail retains content.
describe("scoped research mail search", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  async function fixture(
    purpose: "product_enrichment" | "account_sync" = "product_enrichment",
    secondWork = false,
  ) {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail-search member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const google = {
      id: crypto.randomUUID(),
      accountId: "synthetic-search-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    };
    await getDb(ctx.db).insert(account).values(google);
    let admittedId: string;
    if (purpose === "product_enrichment") {
      const item = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic copper kettle", manufacturer: "" }),
        ctx.actor,
      );
      const otherItem = secondWork
        ? await createProductFixture(
            ctx.db,
            makeProductInput({
              name: "Another synthetic kettle",
              manufacturer: "",
            }),
            ctx.actor,
          )
        : null;
      const [started] = await startProductResearch(
        ctx.db,
        {
          ledgerPartyId: member.id,
          userId: ctx.actor.userId,
          productIds: [
            item.entityId,
            ...(otherItem ? [otherItem.entityId] : []),
          ],
          cause: "member_request",
        },
        { send: async () => {} },
      );
      if (!started)
        throw new Error("Synthetic Product research admission missing");
      admittedId = started.runId;
    } else {
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic search shop",
        website: "https://shop.example.test/account",
        browserDomains: ["shop.example.test"],
      });
      const browserAccount = await insertWithShortcode(
        ctx.db,
        "vendorAccount",
        {
          label: "Synthetic search account",
          vendorId: vendor.id,
          ledgerPartyId: member.id,
          browserSyncEnabled: true,
        },
      );
      admittedId = (
        await startOrResumeRun(ctx.db, {
          ledgerPartyId: member.id,
          vendorAccountId: browserAccount.id,
          trigger: "manual",
        })
      ).id;
    }
    const [parent] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(admittedId)));
    if (!parent) throw new Error("Synthetic admitted search Run missing");
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, parent.id));
    const [target, otherTarget] = targets;
    if (!target) throw new Error("Synthetic search target missing");
    const deliveries: unknown[] = [];
    vi.spyOn(cloud, "getPurchaseAgentQueue").mockReturnValue({
      send: async (event) => {
        deliveries.push(event);
      },
    });
    vi.spyOn(routing, "productionMailTriage").mockReturnValue(
      async (content) =>
        content.includes("Synthetic promotion") ? "unrelated" : "related",
    );
    const list = vi.fn<GmailProvider["listMessages"]>(async ({ pageToken }) =>
      pageToken
        ? { messages: [{ id: "synthetic-second" }] }
        : {
            messages: [
              { id: "synthetic-first" },
              { id: "synthetic-negative" },
              { id: "synthetic-trash" },
            ],
            nextPageToken: "synthetic-private-google-page",
          },
    );
    const provider = fromPartial<GmailProvider>({
      listMessages: list,
      getMessage: async (id: string) => ({
        id,
        labelIds: id === "synthetic-trash" ? ["TRASH"] : ["INBOX"],
        internalDate: "1790856000000",
        snippet: "Synthetic receipt",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "unknown@platform.example.test" },
            {
              name: "Subject",
              value:
                id === "synthetic-negative"
                  ? "Synthetic promotion"
                  : "Synthetic purchased variant",
            },
          ],
          body: {
            data: Buffer.from(
              "One synthetic copper kettle, size XL. Total USD 24.",
            ).toString("base64url"),
          },
        },
      }),
    });
    const providers = vi
      .spyOn(gmail, "gmailProviderForUser")
      .mockResolvedValue(provider);
    const bytes = new Map<string, Uint8Array>();
    const service = researchServiceFor(
      ctx.db,
      fromPartial<Env>({ R2_KEY_PREFIX: "synthetic/search" }),
      parent.id,
      {
        observations: {
          storage: {
            put: async (key, value) => {
              bytes.set(key, value);
            },
            get: async (key) => {
              const value = bytes.get(key);
              if (!value) throw new Error("Synthetic original missing");
              return new TextDecoder().decode(value);
            },
          },
        },
      },
    );
    const input = { workRef: target.id, query: "synthetic copper kettle" };
    return {
      member,
      google,
      parent,
      target,
      otherTarget,
      service,
      input,
      providers,
      list,
      deliveries,
    };
  }

  it("lets Product research page full scoped history, admit related child work, and replay without claiming parent write authority or broad coverage", async () => {
    const f = await fixture();
    const callId = crypto.randomUUID();
    const first = toolResult.parse(
      await f.service.researchMailSearch(f.input, callId),
    );
    const continuationRef = z.uuid().parse(first.continuationRef);
    expect(JSON.stringify(first)).not.toContain(
      "synthetic-private-google-page",
    );
    expect(first).toMatchObject({
      moreAvailable: true,
      sources: [{ subject: "Synthetic purchased variant" }],
    });
    expect(f.list).toHaveBeenCalledWith({
      query: "(synthetic copper kettle) -in:spam -in:trash",
      maxResults: 25,
    });
    const [child] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, f.parent.id));
    expect(child).toMatchObject({
      purpose: "mail_import",
      cause: "source_discovered",
      status: "running",
    });
    expect(f.deliveries).toHaveLength(1);
    const [mail] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.messageId, "synthetic-first"));
    if (!mail || !child) throw new Error("Synthetic discovered source missing");
    const [ledger] = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.orderMailId, mail.id));
    expect(ledger).toMatchObject({ runId: child.id, status: "researching" });
    const observed = toolResult.parse(
      await f.service.researchMailRead(
        { workRef: f.target.id, messageRef: mail.id },
        crypto.randomUUID(),
      ),
    );
    const [evidence] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, z.uuid().parse(observed.evidenceId)));
    expect(evidence?.sourceMetadata).toMatchObject({
      contextOnly: true,
      orderMailId: mail.id,
    });
    expect(await f.service.researchMailSearch(f.input, callId)).toEqual(first);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.deliveries).toHaveLength(1);
    const second = await f.service.researchMailSearch(
      { ...f.input, continuationRef },
      crypto.randomUUID(),
    );
    expect(second).toMatchObject({
      moreAvailable: false,
      continuationRef: null,
      sources: [{ subject: "Synthetic purchased variant" }],
    });
    expect(f.list).toHaveBeenLastCalledWith({
      query: "(synthetic copper kettle) -in:spam -in:trash",
      maxResults: 25,
      pageToken: "synthetic-private-google-page",
    });
    expect(await getDb(ctx.db).select().from(mailboxCursor)).toEqual([]);
    const originals = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.ledgerPartyId, f.member.id));
    expect(originals.map((mail) => mail.messageId).sort()).toEqual([
      "synthetic-first",
      "synthetic-second",
    ]);
    const [negative] = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(
        and(
          eq(mailboxMessage.ledgerPartyId, f.member.id),
          eq(mailboxMessage.messageId, "synthetic-negative"),
        ),
      );
    expect(negative).toMatchObject({
      classification: "unrelated",
      status: "completed",
      orderMailId: null,
    });
  });

  it("allows a fresh search in another issued owned mailbox while refusing switched-account or borrowed pagination before fetching mail", async () => {
    const f = await fixture("product_enrichment", true);
    await getDb(ctx.db)
      .update(account)
      .set({ id: "synthetic-auth-account-text" })
      .where(eq(account.id, f.google.id));
    await getDb(ctx.db).insert(account).values({
      id: "synthetic-second-auth-account-text",
      accountId: "synthetic-other-search-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const choice = toolResult.parse(
      await f.service.researchMailSearch(f.input, crypto.randomUUID()),
    );
    expect(choice.status).toBe("mailbox_required");
    const choices = z
      .array(z.object({ mailboxRef: z.uuid() }))
      .length(2)
      .parse(choice.mailboxChoices);
    expect(f.providers).not.toHaveBeenCalled();
    expect(JSON.stringify(choice)).not.toContain("synthetic-auth-account-text");
    const firstChoice = choices[0];
    const otherChoice = choices[1];
    if (!firstChoice || !otherChoice)
      throw new Error("Synthetic issued choices missing");
    await expect(
      f.service.researchMailSearch(
        { ...f.input, mailboxRef: crypto.randomUUID() },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/Mailbox choice/u);
    const first = toolResult.parse(
      await f.service.researchMailSearch(
        { ...f.input, ...firstChoice },
        crypto.randomUUID(),
      ),
    );
    expect(f.providers).toHaveBeenLastCalledWith(
      ctx.db,
      ctx.actor.userId,
      f.google.accountId,
    );
    const continuationRef = z.uuid().parse(first.continuationRef);
    await expect(
      f.service.researchMailSearch(
        { ...f.input, continuationRef, query: "another synthetic query" },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/continuation/u);
    const otherTarget = f.otherTarget;
    if (!otherTarget) throw new Error("Synthetic second task missing");
    await expect(
      f.service.researchMailSearch(
        { ...f.input, continuationRef, workRef: otherTarget.id },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/continuation/u);
    await expect(
      f.service.researchMailSearch(
        { ...f.input, ...otherChoice, continuationRef },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/continuation|mailbox/u);
    expect(f.list).toHaveBeenCalledTimes(1);
    const otherSearchInput = {
      ...f.input,
      ...otherChoice,
      query: "another synthetic query",
    };
    const otherSearchCallId = crypto.randomUUID();
    const otherSearch = await f.service.researchMailSearch(
      otherSearchInput,
      otherSearchCallId,
    );
    expect(otherSearch).toMatchObject({ moreAvailable: true });
    expect(f.providers).toHaveBeenLastCalledWith(
      ctx.db,
      ctx.actor.userId,
      "synthetic-other-search-mailbox",
    );
    expect(
      await f.service.researchMailSearch(otherSearchInput, otherSearchCallId),
    ).toEqual(otherSearch);
    expect(f.list).toHaveBeenCalledTimes(2);
    await expect(
      f.service.researchMailSearch(
        { ...f.input, ...otherChoice, continuationRef },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/continuation/u);
    expect(f.list).toHaveBeenCalledTimes(2);
    const [child] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, f.parent.id));
    if (!child) throw new Error("Synthetic child missing");
    const [childWork] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, child.id));
    if (!childWork) throw new Error("Synthetic child task missing");
    const childService = researchServiceFor(
      ctx.db,
      fromPartial<Env>({}),
      child.id,
    );
    await expect(
      childService.researchMailSearch(
        { ...f.input, workRef: childWork.id, continuationRef },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/continuation/u);
    expect(f.list).toHaveBeenCalledTimes(2);
    await getDb(ctx.db)
      .update(account)
      .set({ accountId: "synthetic-reconnected-different-account" })
      .where(eq(account.id, "synthetic-auth-account-text"));
    await expect(
      f.service.researchMailSearch(
        { ...f.input, continuationRef },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(/no longer connected/u);
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it("replays an interrupted bounded page after dispatch failure even when Gmail search results change", async () => {
    const f = await fixture("account_sync");
    let fails = true;
    vi.mocked(cloud.getPurchaseAgentQueue).mockReturnValue({
      send: async (event) => {
        if (fails) throw new Error("Synthetic queue interruption");
        f.deliveries.push(event);
      },
    });
    const callId = crypto.randomUUID();
    await expect(f.service.researchMailSearch(f.input, callId)).rejects.toThrow(
      /dispatch failed/u,
    );
    const [failed] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, f.parent.id));
    expect(failed?.status).toBe("dispatch_failed");
    f.list.mockResolvedValue({ messages: [] });
    fails = false;
    const recovered = toolResult.parse(
      await f.service.researchMailSearch(f.input, callId),
    );
    expect(recovered).toMatchObject({
      moreAvailable: true,
      sources: [{ subject: "Synthetic purchased variant" }],
    });
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.deliveries).toHaveLength(1);
    const children = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, f.parent.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      id: failed?.id,
      status: "running",
      dispatchAttempts: 2,
    });
    expect(z.uuid().parse(recovered.continuationRef)).toBeTruthy();
    expect(await f.service.researchMailSearch(f.input, callId)).toEqual(
      recovered,
    );
    expect(f.deliveries).toHaveLength(1);
  });

  it("refuses child admission when the parent is canceled during delayed Gmail acquisition", async () => {
    const f = await fixture();
    f.list.mockImplementationOnce(async () => {
      await getDb(ctx.db)
        .update(run)
        .set({ status: "failed", failureCode: "synthetic_canceled" })
        .where(eq(run.id, f.parent.id));
      return { messages: [{ id: "synthetic-first" }] };
    });
    await expect(
      f.service.researchMailSearch(f.input, crypto.randomUUID()),
    ).rejects.toThrow(/Execution authorization Run is no longer executable/u);
    expect(f.deliveries).toHaveLength(0);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.parentRunId, f.parent.id)),
    ).toEqual([]);
  });

  it("refuses child admission when the parent is deleted after its unlocked check while waiting for original mail", async () => {
    const f = await fixture();
    const [source] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.member.id,
        mailboxId: "synthetic-search-mailbox",
        messageId: "synthetic-parent-delete-source",
        sender: "receipts@search.example.test",
        subject: "Synthetic parent deletion receipt",
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: "c".repeat(64),
        content: {
          bodyText: "Synthetic original receipt",
          bodyHtml: null,
          snippet: null,
        },
      })
      .returning();
    if (!source) throw new Error("Synthetic original source missing");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: f.member.id,
      mailboxId: source.mailboxId,
      messageId: source.messageId,
      checksum: source.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-version",
      orderMailId: source.id,
      status: "pending",
    });
    let admission: ReturnType<typeof startMailResearch> | undefined;
    await withTransaction(ctx.db, async (tx) => {
      await tx
        .select()
        .from(orderMail)
        .where(eq(orderMail.id, source.id))
        .for("update");
      admission = startMailResearch(
        ctx.db,
        {
          ledgerPartyId: f.member.id,
          userId: ctx.actor.userId,
          mailboxId: source.mailboxId,
          messageIds: [source.id],
          expectedChecksums: [
            { orderMailId: source.id, checksum: source.rawChecksum },
          ],
          parentRunId: f.parent.id,
          parentWorkRef: f.target.id,
        },
        {
          send: async (event) => {
            f.deliveries.push(event);
          },
        },
      );
      admission.catch(() => undefined);
      await expect
        .poll(
          async () => {
            const waiting = await getDb(ctx.db).execute(sql`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%"OrderMail"%'
        `);
            return waiting.rows[0]?.count;
          },
          { timeout: 5000 },
        )
        .toBe(1);
      await tx
        .update(run)
        .set({ deletedAt: new Date() })
        .where(eq(run.id, f.parent.id));
    });
    await expect(admission).rejects.toThrow(/parent research|retired|fenced/u);
    expect(f.deliveries).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.parentRunId, f.parent.id)),
    ).toEqual([]);
  });

  it("refuses child admission when a still-running parent is retired during delayed Gmail acquisition", async () => {
    const f = await fixture();
    f.list.mockImplementationOnce(async () => {
      await getDb(ctx.db)
        .update(run)
        .set({ retiredAt: new Date(), retirementReason: "unrelated_source" })
        .where(eq(run.id, f.parent.id));
      return { messages: [{ id: "synthetic-first" }] };
    });
    await expect(
      f.service.researchMailSearch(f.input, crypto.randomUUID()),
    ).rejects.toThrow(/retired|parent research|fenced|live coordinator/u);
    expect(f.deliveries).toHaveLength(0);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.parentRunId, f.parent.id)),
    ).toEqual([]);
  });

  it("refuses child admission after the assigned parent work settles during delayed Gmail acquisition", async () => {
    const f = await fixture();
    f.list.mockImplementationOnce(async () => {
      await getDb(ctx.db)
        .update(runTarget)
        .set({ state: "completed" })
        .where(eq(runTarget.id, f.target.id));
      return { messages: [{ id: "synthetic-first" }] };
    });
    await expect(
      f.service.researchMailSearch(f.input, crypto.randomUUID()),
    ).rejects.toThrow(/parent research|settled|fenced/u);
    expect(f.deliveries).toHaveLength(0);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.parentRunId, f.parent.id)),
    ).toEqual([]);
  });

  it("retains another owned mailbox's original as context without stealing its admitted Run or source ownership", async () => {
    const f = await fixture();
    await f.service.researchMailSearch(f.input, crypto.randomUUID());
    const [foreign] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.member.id,
        mailboxId: "synthetic-other-owned-mailbox",
        messageId: "synthetic-other-mailbox-message",
        sender: "orders@another.example.test",
        subject: "Synthetic other mailbox receipt",
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: "b".repeat(64),
        content: {
          snippet: null,
          bodyText: "Synthetic private original in another mailbox",
          bodyHtml: null,
        },
      })
      .returning();
    if (!foreign) throw new Error("Synthetic other mailbox source missing");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: f.member.id,
      mailboxId: foreign.mailboxId,
      messageId: foreign.messageId,
      checksum: foreign.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-version",
      orderMailId: foreign.id,
      status: "pending",
    });
    const [started] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: f.member.id,
        userId: ctx.actor.userId,
        mailboxId: foreign.mailboxId,
        messageIds: [foreign.id],
      },
      { send: async () => {} },
    );
    if (!started) throw new Error("Synthetic other mailbox admission missing");
    const before = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.orderMailId, foreign.id));
    expect(before).toMatchObject([
      { runId: started.runId, status: "researching" },
    ]);
    const callId = crypto.randomUUID();
    const input = { workRef: f.target.id, messageRef: foreign.id };
    const observed = toolResult.parse(
      await f.service.researchMailRead(input, callId),
    );
    expect(await f.service.researchMailRead(input, callId)).toEqual(observed);
    const evidence = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, f.parent.id));
    expect(evidence).toMatchObject([
      {
        id: observed.evidenceId,
        targetId: f.target.id,
        sourceMetadata: {
          contextOnly: true,
          orderMailId: foreign.id,
          mailboxId: foreign.mailboxId,
          messageId: foreign.messageId,
          checksum: foreign.rawChecksum,
        },
      },
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(mailboxMessage)
        .where(eq(mailboxMessage.orderMailId, foreign.id)),
    ).toEqual(before);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, started.runId)),
    ).toMatchObject([{ workKey: foreign.id, state: "pending" }]);
  });

  it("returns a reconnect capability result without fencing Product and ordinary cloud research", async () => {
    const f = await fixture();
    f.providers.mockRejectedValue(
      new GmailAuthorizationError("Synthetic revoked Gmail authorization"),
    );
    const callId = crypto.randomUUID();
    const unavailable = await f.service.researchMailSearch(f.input, callId);
    expect(unavailable).toMatchObject({
      status: "capability_unavailable",
      capability: "gmail",
      code: "gmail_reconnect_required",
      detail: expect.stringContaining("Synthetic revoked Gmail authorization"),
      retryAfterReconnect: true,
    });
    const [parent] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.parent.id));
    expect(parent?.status).toBe("running");
    expect(
      await f.service.researchFind(
        { workRef: f.target.id, query: "synthetic" },
        crypto.randomUUID(),
      ),
    ).toMatchObject({ results: expect.any(Array) });
    expect(await f.service.researchMailSearch(f.input, callId)).toEqual(
      unavailable,
    );
    expect(f.providers).toHaveBeenCalledTimes(1);
    expect(await getDb(ctx.db).select().from(mailboxMessage)).toEqual([]);
    expect(f.deliveries).toHaveLength(0);
  });
});
