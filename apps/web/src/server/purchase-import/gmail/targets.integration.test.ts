/**
 * A member can receive a recognized retailer order before setting up browser
 * sync. Gmail bootstrap must still search that Vendor's known senders. A
 * member who never connected Google is not a target: a scheduled pass for
 * them could only fail.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { listGmailSyncTargets } from "./targets";

describe("Gmail sync targets", () => {
  const ctx = withTestDb();

  it("includes configured Vendor senders without a browser VendorAccount", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-google-subject",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Outfitters",
      website: "https://shop.example-outfitters.test/orders",
      orderEmailSenders: ["orders@example-outfitters.test"],
    });

    const targets = await listGmailSyncTargets(ctx.db);

    expect(targets).toContainEqual({
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: "synthetic-google-subject",
      scopedQueries: [
        {
          key: `vendor:${vendor.id}`,
          query:
            '{"Example Outfitters" from:example-outfitters.test from:orders@example-outfitters.test}',
        },
      ],
    });
  });

  it("leaves out a member who never connected Google", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic unconnected member",
      kind: "member",
      userId: ctx.actor.userId,
    });

    expect(await listGmailSyncTargets(ctx.db)).toEqual([]);
  });
});
