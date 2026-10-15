/** A failed post-commit cache deletion must leave its durable retry receipt
 * while the same expiry pass clears every independent abandoned original. */
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import { getDb } from "~/server/db/helpers";
import {
  email as emailTable,
  orderMail,
  orderMailAttachment,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import type { OrderMailAttachmentStorage } from "./attachment-storage";
import { disposeExpiredSearchOriginals } from "./persistence";
import { syntheticRetainedMail } from "./retained-mail.fixtures";

describe("member-search expiry failure isolation", () => {
  const ctx = withTestDb();
  it("clears a second expired original in the same pass after the first post-commit deletion fails", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic expiry member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const originals = [];
    const objects = new Map<string, Uint8Array>();
    for (const suffix of ["first", "second"]) {
      const source = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-expiry-mailbox",
        messageId: `synthetic-expired-${suffix}`,
        rawChecksum: "a".repeat(64),
        content: {
          snippet: "Synthetic cache",
          bodyText: `Synthetic ${suffix} original`,
          bodyHtml: null,
        },
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          classification: "uncertain",
          searchOrigin: "member_search",
          searchExpiresAt: new Date("2001-01-01T00:00:00Z"),
        })
        .where(eq(emailTable.orderMailId, source.id));
      const key = `order-mail-attachment/synthetic-expired-${suffix}`;
      objects.set(key, Uint8Array.from([1, 2, 3]));
      const [attachment] = await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: source.id,
          providerAttachmentId: `gmail:synthetic-expiry-mailbox:synthetic-expired-${suffix}:part:cache`,
          filename: "synthetic.pdf",
          mimeType: "application/pdf",
          checksum: "b".repeat(64),
          pendingObjectKey: key,
        })
        .returning();
      if (!attachment) throw new Error("Synthetic expiry attachment missing");
      originals.push({ source, attachment, key });
    }
    const attempted: string[] = [];
    const storage: OrderMailAttachmentStorage = {
      put: async () => undefined,
      get: async (key) => objects.get(key) ?? new Uint8Array(),
      delete: async (key) => {
        attempted.push(key);
        if (attempted.length === 1)
          throw new Error("Synthetic first expired deletion unavailable");
        objects.delete(key);
      },
    };
    const failure = await disposeExpiredSearchOriginals(ctx.db, storage).then(
      () => null,
      (error) => describeErrorCauses(error),
    );
    expect(failure?.causes.map((cause) => cause.message)).toContain(
      "Synthetic first expired deletion unavailable",
    );
    expect(attempted).toHaveLength(2);
    for (const original of originals) {
      const [shell] = await getDb(ctx.db)
        .select()
        .from(orderMail)
        .where(eq(orderMail.id, original.source.id));
      const [email] = await getDb(ctx.db)
        .select()
        .from(emailTable)
        .where(eq(emailTable.orderMailId, original.source.id));
      const [attachment] = await getDb(ctx.db)
        .select()
        .from(orderMailAttachment)
        .where(eq(orderMailAttachment.id, original.attachment.id));
      expect(shell?.content.bodyText).toBeNull();
      expect(email?.contentClearedAt).toBeInstanceOf(Date);
      expect(email?.classification).toBe("uncertain");
      expect(attachment?.pendingObjectKey).toBeNull();
      const failed = original.key === attempted[0];
      expect(attachment?.pendingDeleteKeys).toEqual(
        failed ? [original.key] : [],
      );
      expect(objects.has(original.key)).toBe(failed);
    }
  });
});
