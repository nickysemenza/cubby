import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  orderMail,
  email as emailTable,
  emailClassificationObservation,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

// Retained originals without a processing ledger must survive promotion;
// rerunning the data transform must preserve their identities and unknown facts.
describe("Email ownership migration", () => {
  const ctx = withTestDb();
  it("promotes original-only mail once without inventing historical classification", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic migration owner",
      kind: "member",
    });
    // Recreate the historical physical boundary in this isolated fixture; the
    // retained runtime no longer declares or writes these duplicate columns.
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "Email" RENAME TO "MailboxMessage"`,
    );
    for (const field of [
      "mailboxId",
      "messageId",
      "threadId",
      "historyId",
      "sender",
      "subject",
      "receivedAt",
    ]) {
      await getDb(ctx.db).execute(
        sql`ALTER TABLE "OrderMail" ADD COLUMN ${sql.identifier(field)} ${sql.raw(field === "receivedAt" ? "timestamp" : "text")}`,
      );
    }
    const [original] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        rawChecksum: "a".repeat(64),
        content: {
          snippet: null,
          bodyText: "Synthetic retained receipt",
          bodyHtml: null,
        },
      })
      .returning();
    await getDb(ctx.db).execute(
      sql`UPDATE "OrderMail" SET "mailboxId" = 'synthetic-migration-mailbox', "messageId" = 'original-only' WHERE id = ${original!.id}::uuid`,
    );
    const migration = readFileSync(
      new URL(
        "../../../drizzle/0035_email_import_cutover.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const transform = migration
      .split("-- BEGIN EMAIL IDENTITY BACKFILL\n")[1]
      ?.split("-- END EMAIL IDENTITY BACKFILL")[0];
    if (!transform) throw new Error("Email identity data transform missing");
    for (const statement of transform
      .split("--> statement-breakpoint")
      .filter((value) => value.trim())) {
      await getDb(ctx.db).execute(sql.raw(statement));
    }
    const read = () =>
      getDb(ctx.db).execute(
        sql`SELECT e.*, identity.kind FROM "MailboxMessage" e JOIN "Entity" identity ON identity.id = e.id WHERE e."orderMailId" = ${original!.id}::uuid`,
      );
    const first = (await read()).rows;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      orderMailId: original!.id,
      kind: "email",
      sender: null,
      subject: null,
      classification: null,
      classificationVersion: null,
      status: "pending",
    });
    expect(first[0]?.shortcode).toMatch(
      /^EML-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/,
    );
    for (const statement of transform
      .split("--> statement-breakpoint")
      .filter((value) => value.trim())) {
      await getDb(ctx.db).execute(sql.raw(statement));
    }
    expect((await read()).rows).toEqual(first);
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "MailboxMessage" RENAME TO "Email"`,
    );
    for (const field of [
      "mailboxId",
      "messageId",
      "threadId",
      "historyId",
      "sender",
      "subject",
      "receivedAt",
    ]) {
      await getDb(ctx.db).execute(
        sql`ALTER TABLE "OrderMail" DROP COLUMN ${sql.identifier(field)}`,
      );
    }
    expect(
      (await getDb(ctx.db).select().from(orderMail))[0]?.content?.bodyText,
    ).toBe("Synthetic retained receipt");
  });
  it("preserves known historical predictions once with unknown stage and model before refresh", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic historical prediction member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const known = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-history-mailbox",
      messageId: "known-history",
      checksum: "b".repeat(64),
      classification: "unrelated",
      classificationStage: null,
      classificationReason: null,
      classificationVersion: "synthetic-old-version",
      status: "completed",
    });
    await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-history-mailbox",
      messageId: "unknown-history",
      classification: null,
      checksum: "c".repeat(64),
      status: "pending",
    });
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "Email" RENAME TO "MailboxMessage"`,
    );
    const migration = readFileSync(
      new URL(
        "../../../drizzle/0035_email_import_cutover.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const transform = migration
      .split("-- BEGIN HISTORICAL EMAIL PREDICTIONS\n")[1]
      ?.split("-- END HISTORICAL EMAIL PREDICTIONS")[0];
    if (transform === undefined)
      throw new Error("Historical Email prediction transform missing");
    const apply = async () => {
      for (const statement of transform
        .split("--> statement-breakpoint")
        .filter((value) => value.trim()))
        await getDb(ctx.db).execute(sql.raw(statement));
    };
    await apply();
    const first = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      emailId: known.id,
      checksum: "b".repeat(64),
      classification: "unrelated",
      stage: null,
      reason: null,
      classificationVersion: "synthetic-old-version",
      model: null,
      promptVersion: null,
      operation: null,
      usageId: null,
      runId: null,
    });
    await apply();
    expect(
      await getDb(ctx.db).select().from(emailClassificationObservation),
    ).toEqual(first);
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "MailboxMessage" RENAME TO "Email"`,
    );
    expect(
      (await getDb(ctx.db).select().from(emailTable)).find(
        (row) => row.id === known.id,
      )?.classification,
    ).toBe("unrelated");
  });
});
