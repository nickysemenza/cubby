/** Plausible boundary failures: unrelated content/attachments persist; interrupted
 * attachment upload becomes completed; legacy checksums skip new routing; mailbox
 * identities collide; provider/auth failures become negative classifications;
 * persisted classification-only retries escalate uncertainty to Luna or lose headers. */
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  email as emailTable,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
  orderMailCandidateDecision,
  importSourceClaim,
  importSourceOrder,
  emailClassificationObservation,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { readRetainedMail } from "~/server/repo/retained-mail";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { importedPurchaseFixture } from "../import-run.fixtures";
import { syntheticMailImportRun } from "./execution.fixtures";
import { ingestGmailMessages } from "./ingest";
import { createBetterAuthGmailAccountStore } from "./persistence";
import { clearUnrelatedOriginal } from "./persistence";
import { syntheticRetainedMail } from "./retained-mail.fixtures";
import { GmailAuthorizationError } from "./tokens";
import { GmailApiError, type GmailProvider } from "./types";

const provider = (overrides: Partial<GmailProvider> = {}): GmailProvider => ({
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({ data: "cGRm" }),
  getMessage: async (id) => ({
    id,
    internalDate: "1788220800000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "shared@platform.example" },
        { name: "Subject", value: "Synthetic notice" },
      ],
      body: {
        data: Buffer.from("A synthetic original message").toString("base64url"),
      },
      parts: [
        {
          partId: "pdf",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "attachment", size: 3 },
        },
      ],
    },
  }),
  ...overrides,
});

describe("Gmail acquisition retention and replay", () => {
  const ctx = withTestDb();
  const member = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
  const storage = {
    put: vi.fn(async () => undefined),
    get: async () => new Uint8Array(),
    delete: async () => undefined,
  };
  const ordinaryImportRun = (
    party: Pick<Awaited<ReturnType<typeof member>>, "id">,
  ) =>
    syntheticMailImportRun(ctx.db, ctx.actor, {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
    });
  it("keeps uncertain attachment content without relevance escalation on classification-only retries", async () => {
    const party = await member();
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      input: {
        mailboxId: "google-one",
        scopedQueries: [],
        executionPolicy: "classification_only",
      },
    });
    const relevance = vi.fn(async () => ({
      classification: "unrelated" as const,
    }));
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["classification-only-retry"],
      runId,
      triage: async () => "uncertain" as const,
      relevance,
      storage,
    };
    await ingestGmailMessages(ctx.db, provider(), input);
    await ingestGmailMessages(ctx.db, provider(), input);
    expect(relevance).not.toHaveBeenCalled();
    const [email] = await getDb(ctx.db).select().from(emailTable);
    expect(email).toMatchObject({
      classification: "uncertain",
      classificationStage: "jev",
      executionPolicy: "classification_only",
      sender: "shared@platform.example",
      subject: "Synthetic notice",
      receivedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toHaveLength(
      1,
    );
  });
  it("keeps unrelated headers and original identity while discarding body and attachment bytes", async () => {
    const party = await member();
    const gmail = provider({
      getMessage: async (id) => ({
        id,
        threadId: "synthetic-thread",
        historyId: "120",
        internalDate: "1788220800000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "newsletter@example.test" },
            { name: "Subject", value: "Synthetic weekly news" },
          ],
          body: {
            data: Buffer.from(
              "Unrelated synthetic newsletter content",
            ).toString("base64url"),
          },
        },
      }),
    });
    await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["headers-only"],
      triage: async () => "unrelated",
      storage,
    });
    const [email] = await getDb(ctx.db).select().from(emailTable);
    expect(email).toMatchObject({
      messageId: "headers-only",
      sender: "newsletter@example.test",
      subject: "Synthetic weekly news",
      threadId: "synthetic-thread",
      historyId: "120",
      receivedAt: new Date("2026-09-01T00:00:00.000Z"),
      classification: "unrelated",
      orderMailId: null,
      executionPolicy: "classification_only",
    });
    expect(email?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(JSON.stringify(email)).not.toContain(
      "Unrelated synthetic newsletter content",
    );
  });
  it("clears an unaccepted original's content while preserving its checksum and historical event identity", async () => {
    const party = await member();
    await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["clear-content-shell"],
      triage: async () => "related",
      storage,
    });
    const [original] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [party.id],
    });
    if (!original) throw new Error("Synthetic content missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: original.id,
        event: "placed",
        sourceKey: "synthetic-clear-event",
        payload: {},
      })
      .returning();
    const deleted: string[] = [];
    await clearUnrelatedOriginal(
      ctx.db,
      {
        ledgerPartyId: party.id,
        mailboxId: original.mailboxId,
        messageId: original.messageId,
      },
      {
        ...storage,
        delete: async (key) => {
          deleted.push(key);
        },
      },
    );
    const [cleared] = await getDb(ctx.db).select().from(orderMail);
    expect(cleared).toMatchObject({
      id: original.id,
      rawChecksum: original.rawChecksum,
      content: { snippet: null, bodyText: null, bodyHtml: null },
    });
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toEqual([event]);
    expect(
      (await getDb(ctx.db).select().from(emailTable))[0]?.orderMailId,
    ).toBe(original.id);
    expect(
      (await getDb(ctx.db).select().from(orderMailAttachment))[0]
        ?.pendingObjectKey,
    ).toBeNull();
    expect(deleted).toHaveLength(1);
  });
  it("retains uncertain attachment-only bytes with unknown headers and date instead of inventing metadata", async () => {
    const party = await member();
    await ingestGmailMessages(
      ctx.db,
      provider({
        getMessage: async (id) => ({
          id,
          payload: {
            parts: [
              {
                partId: "pdf",
                filename: "receipt.pdf",
                mimeType: "application/pdf",
                body: { attachmentId: "attachment", size: 3 },
              },
            ],
          },
        }),
      }),
      {
        ledgerPartyId: party.id,
        mailboxId: "google-one",
        messageIds: ["unknown-headers"],
        storage,
        triage: async () => "unrelated",
      },
    );
    expect((await getDb(ctx.db).select().from(emailTable))[0]).toMatchObject({
      classification: "uncertain",
      sender: null,
      subject: null,
      receivedAt: null,
    });
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toHaveLength(
      1,
    );
    expect(
      (await getDb(ctx.db).select().from(emailTable))[0]?.receivedAt,
    ).toBeNull();
  });
  // Current raw bytes must advance canonical freshness without a successful
  // researcher write. Routine rediscovery cannot erase an ownership block.
  it("preserves known checksums, classification and content ownership when Gmail reports an original unavailable", async () => {
    const party = await member();
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["unavailable-known-original"],
      triage: async () => "related" as const,
      storage,
    };
    await ingestGmailMessages(ctx.db, provider(), input);
    const [before] = await getDb(ctx.db).select().from(emailTable);
    const originals = await getDb(ctx.db).select().from(orderMail);
    await ingestGmailMessages(
      ctx.db,
      provider({
        getMessage: async () => {
          throw new GmailApiError({
            status: 404,
            message: "Synthetic unavailable original",
          });
        },
      }),
      input,
    );
    expect((await getDb(ctx.db).select().from(emailTable))[0]).toMatchObject({
      checksum: before?.checksum,
      classification: "related",
      status: "deleted",
      orderMailId: originals[0]?.id,
      sender: "shared@platform.example",
      subject: "Synthetic notice",
    });
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual(originals);
  });
  it("advances only the canonical checksum when a related original refreshes before research", async () => {
    const f = await importedPurchaseFixture(ctx.db, ctx.actor);
    if (!f.association) throw new Error("Synthetic accepted order missing");
    const input = {
      ledgerPartyId: f.party.id,
      mailboxId: "google-one",
      messageIds: ["refresh-before-research"],
      storage,
      triage: async () => "related" as const,
    };
    await ingestGmailMessages(ctx.db, provider(), input);
    const [original] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [f.party.id],
    });
    if (!original) throw new Error("Synthetic original missing");
    const [root] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.party.id,
        kind: "mail_message",
        externalKey: `gmail:${original.mailboxId}:${original.messageId}`,
        checksum: original.rawChecksum,
        firstRunId: f.parent.id,
        lastRunId: f.parent.id,
      })
      .returning();
    if (!root) throw new Error("Synthetic canonical source missing");
    await getDb(ctx.db)
      .update(importSourceClaim)
      .set({ canonicalClaimId: root.id, checksum: original.rawChecksum })
      .where(eq(importSourceClaim.id, f.association.sourceClaimId));
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ checksum: original.rawChecksum })
      .where(eq(importSourceOrder.id, f.association.id));
    const [alias] = await getDb(ctx.db)
      .select()
      .from(importSourceClaim)
      .where(eq(importSourceClaim.id, f.association.sourceClaimId));
    const [accepted] = await getDb(ctx.db)
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.id, f.association.id));
    const gmail = provider();
    const message = await gmail.getMessage(original.messageId);
    await ingestGmailMessages(
      ctx.db,
      provider({
        getMessage: async () => ({
          ...message,
          payload: {
            ...message.payload,
            body: {
              data: Buffer.from(
                "Refreshed synthetic related original bytes",
              ).toString("base64url"),
            },
          },
        }),
      }),
      input,
    );
    const [refreshed] = await getDb(ctx.db).select().from(orderMail);
    expect(refreshed?.rawChecksum).not.toBe(original.rawChecksum);
    const [currentRoot] = await getDb(ctx.db)
      .select()
      .from(importSourceClaim)
      .where(eq(importSourceClaim.id, root.id));
    expect(currentRoot?.checksum).toBe(refreshed?.rawChecksum);
    expect(
      await getDb(ctx.db)
        .select()
        .from(importSourceClaim)
        .where(eq(importSourceClaim.id, f.association.sourceClaimId)),
    ).toEqual([alias]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(importSourceOrder)
        .where(eq(importSourceOrder.id, f.association.id)),
    ).toEqual([accepted]);
  });
  it.each(["related", "deleted", "excluded"] as const)(
    "preserves unresolved ownership independently of %s rediscovery",
    async (discovery) => {
      const party = await member();
      const input = {
        ledgerPartyId: party.id,
        mailboxId: "google-one",
        messageIds: ["unresolved-owner"],
        storage,
        triage: async () => "related" as const,
      };
      await ingestGmailMessages(ctx.db, provider(), input);
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          classificationVersion: "legacy-source-identity-unresolved/v1",
          status: "blocked",
        })
        .where(eq(emailTable.messageId, input.messageIds[0]!));
      const [disposition] = await getDb(ctx.db).select().from(emailTable);
      const originals = await getDb(ctx.db).select().from(orderMail);
      const attachments = await getDb(ctx.db)
        .select()
        .from(orderMailAttachment);
      const gmail =
        discovery === "deleted"
          ? provider({
              getMessage: async () => {
                throw new GmailApiError({
                  status: 404,
                  message: "Synthetic deleted source",
                });
              },
            })
          : discovery === "excluded"
            ? provider({
                getMessage: async (id) => ({ id, labelIds: ["TRASH"] }),
              })
            : provider();
      const outcome = await ingestGmailMessages(ctx.db, gmail, input);
      expect(outcome.orderMailIds).toEqual([]);
      expect(await getDb(ctx.db).select().from(emailTable)).toEqual([
        disposition,
      ]);
      expect(await getDb(ctx.db).select().from(orderMail)).toEqual(originals);
      expect(await getDb(ctx.db).select().from(orderMailAttachment)).toEqual(
        attachments,
      );
    },
  );
  it("reads and refreshes only the frozen Google account identity when accounts coexist", async () => {
    await getDb(ctx.db)
      .insert(account)
      .values(
        ["one", "two"].map((label) => ({
          id: crypto.randomUUID(),
          userId: ctx.actor.userId,
          providerId: "google",
          accountId: `synthetic-google-${label}`,
          accessToken: `synthetic-token-${label}`,
          refreshToken: `synthetic-refresh-${label}`,
          updatedAt: new Date(),
        })),
      );
    const store = createBetterAuthGmailAccountStore(
      ctx.db,
      "synthetic-google-two",
    );
    expect((await store.findGoogleAccount(ctx.actor.userId))?.accessToken).toBe(
      "synthetic-token-two",
    );
    await store.updateGoogleAccount(ctx.actor.userId, {
      accessToken: "synthetic-refreshed-two",
      accessTokenExpiresAt: new Date("2027-01-01"),
    });
    const accounts = await getDb(ctx.db).select().from(account);
    expect(
      accounts.find((row) => row.accountId === "synthetic-google-one")
        ?.accessToken,
    ).toBe("synthetic-token-one");
    expect(
      accounts.find((row) => row.accountId === "synthetic-google-two")
        ?.accessToken,
    ).toBe("synthetic-refreshed-two");
    expect(
      await createBetterAuthGmailAccountStore(
        ctx.db,
        "synthetic-disconnected",
      ).findGoogleAccount(ctx.actor.userId),
    ).toBeNull();
  });
  it("persists only a negative ledger after transient interpretation, with no durable original or attachments", async () => {
    const party = await member();
    const gmail = provider();
    const getAttachment = vi.spyOn(gmail, "getAttachment");
    const result = await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["irrelevant"],
      runId: await ordinaryImportRun(party),
      storage,
      triage: async () => "uncertain",
      relevance: async () => ({ classification: "unrelated" }),
    });
    expect(result.unrelated).toEqual(["irrelevant"]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toEqual([]);
    expect(getAttachment).toHaveBeenCalledTimes(1);
    const [ledger] = await getDb(ctx.db).select().from(emailTable);
    expect(ledger).toMatchObject({
      messageId: "irrelevant",
      classification: "unrelated",
      status: "completed",
      orderMailId: null,
    });
    expect(ledger?.subject).toBe("Synthetic notice");
    expect(JSON.stringify(ledger)).not.toContain(
      "A synthetic original message",
    );
  });
  it("returns an unchanged researching source for dispatch replay while completed sources stay completed", async () => {
    const party = await member();
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["replay"],
      storage,
      triage: async () => "related" as const,
      relevance: async () => ({ classification: "related" as const }),
    };
    const original = await ingestGmailMessages(ctx.db, provider(), input);
    const [retained] = await getDb(ctx.db).select().from(orderMail);
    const [ledger] = await getDb(ctx.db).select().from(emailTable);
    expect(ledger?.checksum).toBe(retained?.rawChecksum);
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "researching" })
      .where(eq(emailTable.messageId, "replay"));
    const replay = await ingestGmailMessages(ctx.db, provider(), input);
    expect(replay.orderMailIds).toEqual(original.orderMailIds);
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "completed" })
      .where(eq(emailTable.messageId, "replay"));
    expect(
      (await ingestGmailMessages(ctx.db, provider(), input)).orderMailIds,
    ).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
    expect(
      (await getDb(ctx.db).select().from(orderMail))[0]?.content,
    ).toMatchObject({
      headers: { from: "shared@platform.example", subject: "Synthetic notice" },
    });
  });
  it("retries interrupted related attachment storage without duplicating retained originals", async () => {
    const party = await member();
    let fail = true;
    const interrupted = {
      ...storage,
      put: async () => {
        if (fail) throw new Error("synthetic upload unavailable");
      },
    };
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["receipt"],
      storage: interrupted,
      triage: async () => "related" as const,
    };
    await expect(
      ingestGmailMessages(ctx.db, provider(), input),
    ).rejects.toThrow("synthetic upload unavailable");
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toEqual([]);
    fail = false;
    const saved = await ingestGmailMessages(ctx.db, provider(), input);
    expect(saved.orderMailIds).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toHaveLength(
      1,
    );
    expect((await getDb(ctx.db).select().from(emailTable))[0]?.status).toBe(
      "pending",
    );
  });
  it("excludes fetched Spam/Trash and preserves authorization failures for reconnect", async () => {
    const party = await member();
    const gmail = provider({
      getMessage: async (id) => ({ id, labelIds: ["TRASH"] }),
    });
    const triage = vi.fn(async () => "related" as const);
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["trashed"],
      storage,
      triage,
    };
    expect((await ingestGmailMessages(ctx.db, gmail, input)).excluded).toEqual([
      "trashed",
    ]);
    expect(triage).not.toHaveBeenCalled();
    await expect(
      ingestGmailMessages(
        ctx.db,
        provider({
          getMessage: async () => {
            throw new GmailAuthorizationError("synthetic revoked");
          },
        }),
        { ...input, messageIds: ["not-read"] },
      ),
    ).rejects.toThrow("synthetic revoked");
    expect(
      await getDb(ctx.db)
        .select()
        .from(emailTable)
        .where(eq(emailTable.messageId, "not-read")),
    ).toEqual([]);
  });
  it("reprocesses a legacy classified checksum and clears unrelated bytes while preserving the original shell", async () => {
    const party = await member();
    await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageId: "legacy-negative",
      rawChecksum: "old",
      classifiedChecksum: "old",
      sender: "irrelevant@example.test",
      subject: "Legacy newsletter",
      receivedAt: new Date(),
      content: {
        bodyText: "Legacy negative content",
        bodyHtml: null,
        snippet: null,
      },
    });
    const triage = vi.fn(async () => "unrelated" as const);
    await ingestGmailMessages(
      ctx.db,
      provider({
        getMessage: async (id) => ({
          ...(await provider().getMessage(id)),
          payload: {
            mimeType: "text/plain",
            body: {
              data: Buffer.from("Synthetic newsletter").toString("base64url"),
            },
          },
        }),
      }),
      {
        ledgerPartyId: party.id,
        mailboxId: "google-one",
        messageIds: ["legacy-negative"],
        triage,
        relevance: async () => ({ classification: "unrelated" }),
        storage,
      },
    );
    expect(triage).toHaveBeenCalledTimes(1);
    expect(
      await readRetainedMail(ctx.db, { ledgerPartyIds: [party.id] }),
    ).toMatchObject([
      {
        messageId: "legacy-negative",
        rawChecksum: "old",
        content: { bodyText: null, bodyHtml: null, snippet: null },
      },
    ]);
  });
  it("preserves an accepted attachment-owned legacy original before negative acquisition can delete its object", async () => {
    const fixture = await importedPurchaseFixture(ctx.db, ctx.actor);
    if (!fixture.association)
      throw new Error("Synthetic accepted association missing");
    const party = fixture.party;
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageId: "attachment-owned-original",
      rawChecksum: "old-original",
      sender: "receipts@example.test",
      subject: "Synthetic retained receipt",
      receivedAt: new Date(),
      content: {
        snippet: null,
        bodyHtml: null,
        bodyText: "Synthetic retained original",
      },
    });
    if (!mail) throw new Error("Synthetic attachment original missing");
    const [attachment] = await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: mail.id,
        providerAttachmentId: "attachment",
        filename: "synthetic-receipt.pdf",
        mimeType: "application/pdf",
        checksum: "accepted-attachment",
        pendingObjectKey: "synthetic-retained-original/receipt.pdf",
      })
      .returning();
    if (!attachment) throw new Error("Synthetic retained attachment missing");
    await getDb(ctx.db)
      .update(importSourceClaim)
      .set({
        kind: "mail_attachment",
        externalKey: `gmail:${mail.mailboxId}:${mail.messageId}:attachment:${attachment.providerAttachmentId}`,
        checksum: attachment.checksum,
      })
      .where(eq(importSourceClaim.id, fixture.association.sourceClaimId));
    const deleted: string[] = [];
    const outcome = await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageIds: [mail.messageId],
      runId: await ordinaryImportRun(party),
      triage: async () => "unrelated",
      relevance: async () => ({ classification: "unrelated" }),
      storage: {
        ...storage,
        delete: async (key) => {
          deleted.push(key);
        },
      },
    });
    expect(
      (await getDb(ctx.db).select().from(emailClassificationObservation))[0],
    ).toMatchObject({
      classification: "unrelated",
      conflict: { kind: "accepted_unrelated" },
    });
    expect(deleted).toEqual([]);
    expect(outcome.unrelated).toEqual([]);
    expect(outcome.orderMailIds).toEqual([mail.id]);
    expect(
      await readRetainedMail(ctx.db, {
        ledgerPartyIds: [party.id],
        orderMailIds: [mail.id],
      }),
    ).toEqual([
      {
        ...mail,
        sender: "shared@platform.example",
        subject: "Synthetic notice",
        receivedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ]);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toEqual([
      attachment,
    ]);
  });
  it("preserves historical dismissal and original identity while clearing unaccepted bytes", async () => {
    const party = await member();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic merchant",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
    });
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageId: "human-decision",
      rawChecksum: "old",
      classifiedChecksum: "old",
      sender: "shared@example.test",
      subject: "Original source",
      receivedAt: new Date(),
      content: {
        bodyText: "Historical original",
        bodyHtml: null,
        snippet: null,
      },
    });
    if (!mail) throw new Error("Synthetic original missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "SYNTHETIC-ORDER",
        sourceKey: "synthetic:human-decision",
        payload: {},
      })
      .returning();
    if (!event) throw new Error("Synthetic event missing");
    await getDb(ctx.db).insert(orderMailCandidateDecision).values({
      eventId: event.id,
      purchaseId: purchase.id,
      decision: "dismissed",
      evidenceChecksum: "old",
      decidedByUserId: ctx.actor.userId,
    });
    const outcome = await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["human-decision"],
      runId: await ordinaryImportRun(party),
      triage: async () => "unrelated",
      relevance: async () => ({ classification: "unrelated" }),
      storage,
    });
    expect(outcome.unrelated).toEqual(["human-decision"]);
    expect(outcome.orderMailIds).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toMatchObject([
      { id: mail.id, rawChecksum: "old", content: { bodyText: null } },
    ]);
    expect(
      (await getDb(ctx.db).select().from(orderMailCandidateDecision))[0]
        ?.decision,
    ).toBe("dismissed");
  });

  it("escalates uncertain and attachment-only mail transiently before retaining related originals", async () => {
    const party = await member();
    const relevance = vi.fn(async () => ({
      classification: "related" as const,
    }));
    const result = await ingestGmailMessages(
      ctx.db,
      provider({
        getMessage: async (id) => ({
          id,
          internalDate: "1788220800000",
          payload: {
            parts: [
              {
                partId: "pdf",
                filename: "receipt.pdf",
                mimeType: "application/pdf",
                body: { attachmentId: "attachment", size: 3 },
              },
            ],
          },
        }),
      }),
      {
        ledgerPartyId: party.id,
        mailboxId: "google-one",
        messageIds: ["attachment-only"],
        runId: await ordinaryImportRun(party),
        triage: async () => "unrelated",
        relevance,
        storage,
      },
    );
    expect(relevance).toHaveBeenCalledTimes(1);
    expect(result.orderMailIds).toHaveLength(1);
  });
  it("retains available uncertain attachment bytes while keeping the unavailable body empty", async () => {
    const party = await member();
    const relevance = vi.fn(async () => ({
      classification: "uncertain" as const,
    }));
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["ambiguous"],
      runId: await ordinaryImportRun(party),
      triage: async () => "uncertain" as const,
      relevance,
      storage,
    };
    const result = await ingestGmailMessages(
      ctx.db,
      provider({
        getMessage: async (id) => ({
          id,
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "Synthetic unavailable original" },
            ],
            body: { attachmentId: "missing-body", size: 12 },
          },
        }),
      }),
      input,
    );
    expect(result.blocked).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toMatchObject([
      { content: { bodyText: null, bodyHtml: null } },
    ]);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toHaveLength(
      1,
    );
    expect((await getDb(ctx.db).select().from(emailTable))[0]?.status).toBe(
      "pending",
    );
    expect(result.orderMailIds).toHaveLength(1);
    expect(relevance).toHaveBeenCalledTimes(1);
  });
});
