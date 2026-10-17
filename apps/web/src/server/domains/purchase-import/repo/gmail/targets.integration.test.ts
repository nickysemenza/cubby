/**
 * A member can receive a recognized retailer order before setting up browser
 * sync. Gmail bootstrap must still search that Vendor's known senders. A
 * member who never connected Google is not a target: a scheduled pass for
 * them could only fail.
 */
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
      // Literal sender and website-domain searches; never the Vendor name.
      scopedQueries: [
        {
          key: `vendor:${vendor.id}:domain:example-outfitters.test`,
          query: '"example-outfitters.test"',
        },
        {
          key: `vendor:${vendor.id}:from:orders@example-outfitters.test`,
          query: "from:orders@example-outfitters.test",
        },
      ],
    });
  });

  it("searches each unallocated merchant once, regardless of case or spacing", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic charge member",
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
    const card = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic card",
      identity: { kind: "cash" },
      ledgerPartyId: party.shortcode,
      provisional: false,
    });
    for (const [index, merchant] of [
      "Synthetic Market",
      "synthetic  market",
      "Other Shop",
    ].entries())
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: card.output.id,
        kind: "purchase",
        amount: 10 + index,
        status: "posted",
        transactionDate: "2026-09-01",
        postedDate: "2026-09-02",
        merchant,
        sourceRefs: [
          { source: "synthetic-bank", externalId: `synthetic-charge-${index}` },
        ],
        allocations: [],
      });

    const [target] = await listGmailSyncTargets(ctx.db);

    // Gmail search ignores case, so either spelling may carry the query.
    expect(
      target?.scopedQueries.map(({ key, query }) => [key, query.toLowerCase()]),
    ).toEqual([
      ["merchant:synthetic market", '"synthetic market"'],
      ["merchant:other shop", '"other shop"'],
    ]);
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
