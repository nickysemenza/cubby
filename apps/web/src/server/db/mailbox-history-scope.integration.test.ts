import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "@cubby/shared/sha256";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account, mailboxCursor, orderMail } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

const migration = readFileSync(
  join(import.meta.dirname, "../../../drizzle/0025_purchase_research.sql"),
  "utf8",
);

// Current Google connections cannot establish the owner of pre-mailbox originals
// or coverage cursors. Exercise the actual data statements without repeating DDL.
describe("historical Gmail mailbox scope migration", () => {
  const ctx = withTestDb();
  it.each([0, 1, 2])(
    "preserves unidentified history with %i current Google connections",
    async (connections) => {
      const db = getDb(ctx.db);
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic historical mail member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      for (let index = 0; index < connections; index++)
        await db.insert(account).values({
          id: crypto.randomUUID(),
          accountId: `synthetic-current-google-${index}`,
          providerId: "google",
          userId: ctx.actor.userId,
          updatedAt: new Date(),
        });
      const [cursor] = await db
        .insert(mailboxCursor)
        .values({
          ledgerPartyId: party.id,
          mailboxId: "synthetic-pre-migration-scope",
          historyId: "synthetic-unidentified-history",
          lastPolledAt: new Date("2025-01-01T12:00:00Z"),
        })
        .returning();
      const body = "Synthetic retained receipt from an unidentified mailbox.";
      const [mail] = await db
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          mailboxId: "synthetic-pre-migration-scope",
          messageId: "synthetic-historical-message",
          sender: "orders@example.test",
          subject: "Synthetic historical receipt",
          receivedAt: new Date("2025-01-01T12:00:00Z"),
          rawChecksum: await sha256Hex(body),
          content: { snippet: null, bodyHtml: null, bodyText: body },
        })
        .returning();
      if (!cursor || !mail) throw new Error("Synthetic history missing");
      const statements = migration
        .split("--> statement-breakpoint")
        .map((part) => part.replace(/^(\s*--[^\n]*(?:\n|$))+/u, "").trim())
        .filter((part) =>
          /^UPDATE "(?:MailboxCursor|OrderMail)"\s/u.test(part),
        );
      if (statements.length !== 2)
        throw new Error("Historical mailbox scope transform was not found");
      await db.transaction(async (tx) => {
        for (const statement of statements)
          await tx.execute(sql.raw(statement));
      });
      const [afterCursor] = await db
        .select()
        .from(mailboxCursor)
        .where(eq(mailboxCursor.id, cursor.id));
      const [afterMail] = await db
        .select()
        .from(orderMail)
        .where(eq(orderMail.id, mail.id));
      expect(afterCursor).toEqual({
        ...cursor,
        mailboxId: `legacy:${party.id}`,
      });
      expect(afterMail).toEqual({ ...mail, mailboxId: `legacy:${party.id}` });
    },
  );
});
