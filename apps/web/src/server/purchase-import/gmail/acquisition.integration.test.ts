/** Plausible boundary failures: unrelated content/attachments persist; interrupted
 * attachment upload becomes completed; legacy checksums skip new routing; mailbox
 * identities collide; provider/auth failures become negative classifications. */
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
  orderMailCandidateDecision,
  importSourceClaim,
  importSourceOrder,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { importedPurchaseFixture } from "../import-run.fixtures";
import { ingestGmailMessages } from "./ingest";
import { createBetterAuthGmailAccountStore } from "./persistence";
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
  // Current raw bytes must advance canonical freshness without a successful
  // researcher write. Routine rediscovery cannot erase an ownership block.
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
    const [original] = await getDb(ctx.db).select().from(orderMail);
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
        .update(mailboxMessage)
        .set({
          classificationVersion: "legacy-source-identity-unresolved/v1",
          status: "blocked",
        })
        .where(eq(mailboxMessage.messageId, input.messageIds[0]!));
      const [disposition] = await getDb(ctx.db).select().from(mailboxMessage);
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
      expect(await getDb(ctx.db).select().from(mailboxMessage)).toEqual([
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
      storage,
      triage: async () => "uncertain",
      relevance: async () => ({ classification: "unrelated" }),
    });
    expect(result.unrelated).toEqual(["irrelevant"]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toEqual([]);
    expect(getAttachment).toHaveBeenCalledTimes(1);
    const [ledger] = await getDb(ctx.db).select().from(mailboxMessage);
    expect(ledger).toMatchObject({
      messageId: "irrelevant",
      classification: "unrelated",
      status: "completed",
      orderMailId: null,
    });
    expect(JSON.stringify(ledger)).not.toContain("Synthetic notice");
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
    const [ledger] = await getDb(ctx.db).select().from(mailboxMessage);
    expect(ledger?.checksum).toBe(retained?.rawChecksum);
    await getDb(ctx.db)
      .update(mailboxMessage)
      .set({ status: "researching" })
      .where(eq(mailboxMessage.messageId, "replay"));
    const replay = await ingestGmailMessages(ctx.db, provider(), input);
    expect(replay.orderMailIds).toEqual(original.orderMailIds);
    await getDb(ctx.db)
      .update(mailboxMessage)
      .set({ status: "completed" })
      .where(eq(mailboxMessage.messageId, "replay"));
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
    const [pending] = await getDb(ctx.db).select().from(mailboxMessage);
    expect(pending?.status).toBe("pending");
    fail = false;
    const saved = await ingestGmailMessages(ctx.db, provider(), input);
    expect(saved.orderMailIds).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toHaveLength(
      1,
    );
    expect((await getDb(ctx.db).select().from(mailboxMessage))[0]?.status).toBe(
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
        .from(mailboxMessage)
        .where(eq(mailboxMessage.messageId, "not-read")),
    ).toEqual([]);
  });
  it("reprocesses a legacy classified checksum and removes unrelated originals with no historical decisions", async () => {
    const party = await member();
    await getDb(ctx.db)
      .insert(orderMail)
      .values({
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
    await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["legacy-negative"],
      triage,
      relevance: async () => ({ classification: "unrelated" }),
      storage,
    });
    expect(triage).toHaveBeenCalledTimes(1);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
  });
  it("preserves an attachment-owned original before negative acquisition can delete its object", async () => {
    const party = await member();
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "manual",
      status: "completed",
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
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
      })
      .returning();
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
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "mail_attachment",
        externalKey: `gmail:${mail.mailboxId}:${mail.messageId}:attachment:${attachment.providerAttachmentId}`,
        checksum: attachment.checksum,
        firstRunId: runId,
        lastRunId: runId,
      });
    const deleted: string[] = [];
    const outcome = await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageIds: [mail.messageId],
      triage: async () => "unrelated",
      relevance: async () => ({ classification: "unrelated" }),
      storage: {
        ...storage,
        delete: async (key) => {
          deleted.push(key);
        },
      },
    });
    expect(deleted).toEqual([]);
    expect(outcome.unrelated).toEqual([]);
    expect(outcome.orderMailIds).toEqual([mail.id]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([mail]);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toEqual([
      attachment,
    ]);
  });
  it("preserves historical dismissal and original content when new triage disagrees", async () => {
    const party = await member();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic merchant",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
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
      })
      .returning();
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
      triage: async () => "unrelated",
      relevance: async () => ({ classification: "unrelated" }),
      storage,
    });
    expect(outcome.unrelated).toEqual([]);
    expect(outcome.orderMailIds).toEqual([mail.id]);
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
        triage: async () => "unrelated",
        relevance,
        storage,
      },
    );
    expect(relevance).toHaveBeenCalledTimes(1);
    expect(result.orderMailIds).toHaveLength(1);
  });
  it("keeps an unavailable message body as an explicit uncertain gap without inventing original bytes", async () => {
    const party = await member();
    const relevance = vi.fn(async () => ({
      classification: "uncertain" as const,
    }));
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "google-one",
      messageIds: ["ambiguous"],
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
    expect(result.blocked).toEqual(["ambiguous"]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMailAttachment)).toEqual([]);
    expect((await getDb(ctx.db).select().from(mailboxMessage))[0]?.status).toBe(
      "blocked",
    );
    expect(result.orderMailIds).toEqual([]);
    expect(relevance).toHaveBeenCalledTimes(1);
  });
});
