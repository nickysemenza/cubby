/**
 * Failure: a migrated `legacy:<party>` Email row duplicating a message the
 * current mailbox now holds stays `pending` forever, since no sync writes the
 * legacy mailbox again. Only a pending, ownership-resolved legacy copy of the
 * same message settles; reviewed history and other messages are untouched.
 */
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { email as emailTable } from "~/server/db/schema";

import {
  memberImportWorld,
  retainedMailFixture,
} from "../../operations/order-import.fixtures";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";
import { readEmail, saveEmail, saveMailboxMetadata } from "./persistence";

describe("legacy mailbox Email supersession", () => {
  const ctx = withTestDb();

  it("invalidates legacy supersession even when current metadata is unchanged", async () => {
    const { party } = await memberImportWorld(ctx.db, ctx.actor);
    const metadata = {
      ledgerPartyId: party.id,
      checksum: "d".repeat(64),
      executionPolicy: "classification_only",
      mail: {
        sourceKey: "synthetic-legacy-metadata-source",
        mailboxId: "synthetic-current-mailbox",
        messageId: "synthetic-metadata-duplicate",
        threadId: null,
        historyId: null,
        internalDate: null,
        labelIds: [],
        headers: {
          from: "receipts@example.test",
          subject: "Synthetic legacy receipt",
        },
        snippet: null,
        bodyText: null,
        bodyHtml: null,
      },
    } satisfies Parameters<typeof saveMailboxMetadata>[1];
    await saveMailboxMetadata(ctx.db, metadata);
    const identity = {
      ledgerPartyId: party.id,
      mailboxId: metadata.mail.mailboxId,
      messageId: metadata.mail.messageId,
    };
    const current = await readEmail(ctx.db, identity);
    const legacy = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: `legacy:${party.id}`,
      messageId: metadata.mail.messageId,
      checksum: "e".repeat(64),
    });
    // The capture moves the search family's JobInvalidation row; the
    // execution Job row is never written by a capture.
    const search = async () =>
      (
        await getDb(ctx.db).execute(
          sql`SELECT j.generation, j.xmin::text AS xmin, m.revision::int AS revision, m.xmin::text AS "markerXmin"
            FROM "Job" j JOIN "JobInvalidation" m ON m.key = j.key WHERE j.key = 'refresh:search'`,
        )
      ).rows[0];
    const original = await search();
    await saveMailboxMetadata(ctx.db, metadata);
    expect(await readEmail(ctx.db, identity)).toEqual(current);
    expect(
      await readEmail(ctx.db, { ...identity, mailboxId: `legacy:${party.id}` }),
    ).toMatchObject({ orderMailId: legacy.id, status: "excluded" });
    const superseded = await search();
    expect(superseded?.revision).toBe(Number(original?.revision) + 1);
    expect(superseded?.markerXmin).not.toBe(original?.markerXmin);
    expect({
      generation: superseded?.generation,
      xmin: superseded?.xmin,
    }).toEqual({ generation: original?.generation, xmin: original?.xmin });
    await saveMailboxMetadata(ctx.db, metadata);
    expect(await search()).toEqual(superseded);
  });

  it("excludes a pending legacy copy once the current mailbox holds the message", async () => {
    const { party } = await memberImportWorld(ctx.db, ctx.actor);
    const legacyMailbox = `legacy:${party.id}`;
    const legacy = (messageId: string, classificationVersion?: string) =>
      retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: legacyMailbox,
        messageId,
        checksum: messageId.padEnd(64, "0").slice(0, 64),
        classificationVersion,
      });
    const duplicate = await legacy("synthetic-duplicate");
    const reviewed = await legacy(
      "synthetic-reviewed",
      HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
    );
    const other = await legacy("synthetic-other");
    for (const messageId of ["synthetic-duplicate", "synthetic-reviewed"])
      await saveEmail(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-current-mailbox",
        messageId,
        checksum: "c".repeat(64),
        classification: "related",
        status: "pending",
      });
    const status = async (orderMailId: string) =>
      (
        await getDb(ctx.db)
          .select({ status: emailTable.status })
          .from(emailTable)
          .where(eq(emailTable.orderMailId, orderMailId))
      )[0]?.status;
    expect({
      duplicate: await status(duplicate.id),
      reviewed: await status(reviewed.id),
      other: await status(other.id),
    }).toEqual({
      duplicate: "excluded",
      reviewed: "pending",
      other: "pending",
    });
  });
});
