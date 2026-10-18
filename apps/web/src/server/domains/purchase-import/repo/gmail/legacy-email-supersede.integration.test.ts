/**
 * Failure: a migrated `legacy:<party>` Email row duplicating a message the
 * current mailbox now holds stays `pending` forever, since no sync writes the
 * legacy mailbox again. Only a pending, ownership-resolved legacy copy of the
 * same message settles; reviewed history and other messages are untouched.
 */
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { email as emailTable } from "~/server/db/schema";

import {
  memberImportWorld,
  retainedMailFixture,
} from "../../operations/order-import.fixtures";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";
import { saveEmail } from "./persistence";

describe("legacy mailbox Email supersession", () => {
  const ctx = withTestDb();

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
