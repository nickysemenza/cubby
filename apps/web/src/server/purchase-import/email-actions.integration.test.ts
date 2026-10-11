import { parseShortcodeFor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { email as emailTable, orderMail, run } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { startEmailImport } from "./email-actions";

describe("explicit Email import", () => {
  const ctx = withTestDb();
  it("imports only the selected classification-only Email and refuses a stale selection", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic Email owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const emails: (typeof emailTable.$inferSelect)[] = [];
    for (const messageId of ["selected", "untouched"]) {
      const [original] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          rawChecksum: "a".repeat(64),
          content: {
            snippet: null,
            bodyText: "Synthetic order",
            bodyHtml: null,
          },
        })
        .returning();
      emails.push(
        await insertWithShortcode(ctx.db, "email", {
          ledgerPartyId: party.id,
          mailboxId: "synthetic-email-actions",
          messageId,
          sender: "shop@example.com",
          subject: "Synthetic receipt",
          orderMailId: original!.id,
          checksum: original!.rawChecksum,
          classification: "related",
          classificationVersion: "synthetic",
          executionPolicy: "classification_only",
          status: "pending",
        }),
      );
    }
    const selected = emails[0]!;
    const originalId = selected.orderMailId!;
    await getDb(ctx.db)
      .update(orderMail)
      .set({ content: { snippet: null, bodyText: null, bodyHtml: null } })
      .where(eq(orderMail.id, originalId));
    await expect(
      startEmailImport(
        ctx.db,
        {
          id: parseShortcodeFor("email", selected.shortcode),
          expectedChecksum: selected.checksum,
        },
        ctx.actor,
        { send: async () => {} },
      ),
    ).rejects.toThrow(/content.*unavailable/iu);
    await getDb(ctx.db)
      .update(orderMail)
      .set({
        content: { snippet: null, bodyText: "Synthetic order", bodyHtml: null },
      })
      .where(eq(orderMail.id, originalId));
    const queued: string[] = [];
    await expect(
      startEmailImport(
        ctx.db,
        {
          id: parseShortcodeFor("email", selected.shortcode),
          expectedChecksum: "b".repeat(64),
        },
        ctx.actor,
        {
          send: async (event) => {
            queued.push(event.runId);
          },
        },
      ),
    ).rejects.toThrow(/changed/iu);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
    const result = await startEmailImport(
      ctx.db,
      {
        id: parseShortcodeFor("email", selected.shortcode),
        expectedChecksum: selected.checksum,
      },
      ctx.actor,
      {
        send: async (event) => {
          queued.push(event.runId);
        },
      },
    );
    expect(result.runIds).toHaveLength(1);
    expect(queued).toHaveLength(1);
    const rows = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.ledgerPartyId, party.id));
    expect(rows.find((row) => row.id === selected.id)?.status).toBe(
      "researching",
    );
    expect(rows.find((row) => row.id === emails[1]!.id)).toMatchObject({
      runId: null,
      status: "pending",
      executionPolicy: "classification_only",
    });
  });
});
