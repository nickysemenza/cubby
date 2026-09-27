/**
 * A member can receive a recognized retailer order before setting up browser
 * sync. Gmail bootstrap must still search that Vendor's known senders.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

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
    await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Outfitters",
      website: "https://shop.example-outfitters.test/orders",
      orderEmailSenders: ["orders@example-outfitters.test"],
    });

    const targets = await listGmailSyncTargets(ctx.db);

    expect(targets).toContainEqual({
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: "me",
      bootstrap: {
        knownSenders: [
          "example-outfitters.test",
          "orders@example-outfitters.test",
        ],
      },
    });
  });
});
