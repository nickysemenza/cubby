/** Email-null headers must stay unknown despite stale legacy shell metadata;
 * cleanup and refetch must keep the same content/source-history identity. */
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  email as emailTable,
  orderMail,
  orderMailEvent,
} from "~/server/db/schema";
import { listEmailsRead } from "~/server/domains/email/repo/email";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { ingestGmailMessages } from "./ingest";
import { clearUnrelatedOriginal } from "./persistence";
import type { GmailProvider } from "./types";

const storage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};
const provider: GmailProvider = {
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({}),
  getMessage: async (id) => ({
    id,
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from("Synthetic original").toString("base64url") },
    },
  }),
};

describe("Gmail Email-owned metadata", () => {
  const ctx = withTestDb();
  it("clears the Email's shell despite stale legacy identity and preserves null headers, checksum and event history", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic metadata owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic metadata shop",
    });
    const identity = {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-message",
    };
    await ingestGmailMessages(ctx.db, provider, {
      ...identity,
      messageIds: [identity.messageId],
      callerJudges: true,
      storage,
    });
    const [email] = await getDb(ctx.db).select().from(emailTable);
    const [shell] = await getDb(ctx.db).select().from(orderMail);
    if (!email || !shell) throw new Error("Synthetic original missing");
    await getDb(ctx.db)
      .update(orderMail)
      .set({ vendorId: vendor.id })
      .where(eq(orderMail.id, shell.id));
    // Exercise pre-contraction rows too; after the drop, Email remains the same boundary.
    const legacy = await getDb(ctx.db).execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'OrderMail' AND column_name = 'mailboxId'
    `);
    if (legacy.rows.length)
      await getDb(ctx.db).execute(sql`
        UPDATE "OrderMail" SET "mailboxId" = 'stale-mailbox', "messageId" = 'stale-message',
          "threadId" = 'stale-thread', "historyId" = '999', "sender" = 'stale@example.test',
          "subject" = 'Stale shell header', "receivedAt" = '2025-01-01'
        WHERE "id" = ${shell.id}
      `);
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: shell.id,
        event: "placed",
        sourceKey: "synthetic-history",
        payload: {},
      })
      .returning();
    // The Vendor's Emails section reads the sender-proof Email's own headers.
    const review = await listEmailsRead(
      ctx.db,
      { vendorId: vendor.shortcode },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(review.data).toMatchObject([
      {
        messageId: identity.messageId,
        sender: null,
        subject: null,
        receivedAt: null,
        threadId: null,
        linkState: "none",
      },
    ]);
    expect(await clearUnrelatedOriginal(ctx.db, identity, storage)).toBeNull();
    const [retained] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [party.id],
      mailboxId: identity.mailboxId,
      messageId: identity.messageId,
    });
    expect(retained).toMatchObject({
      id: shell.id,
      mailboxId: identity.mailboxId,
      messageId: identity.messageId,
      sender: null,
      subject: null,
      receivedAt: null,
      threadId: null,
      historyId: null,
      rawChecksum: shell.rawChecksum,
      content: { bodyText: null, bodyHtml: null },
    });
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toEqual([event]);
    expect(
      (await getDb(ctx.db).select().from(emailTable))[0]?.orderMailId,
    ).toBe(shell.id);
    expect(
      await getDb(ctx.db)
        .select()
        .from(orderMail)
        .where(eq(orderMail.id, shell.id)),
    ).toHaveLength(1);
  });
});
