/** Historical, already accepted events must preserve credit direction,
 * combined-charge exclusion, household dates and reopened-source cutoffs.
 * This exercises the live PostgreSQL matcher without the deleted classifier. */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { orderMail, orderMailEvent } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { matchProcessedOrderMail } from "./match";

describe("retained financial mail matching", () => {
  const ctx = withTestDb();
  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic historical mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic historical merchant",
    });
    const window = {
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      dateFrom: "2026-09-03",
      dateTo: "2026-09-17",
    };
    async function event(input: {
      orderId: string;
      amount: number;
      event?: string;
      occurredAt?: string;
      receivedAt?: string;
      savedAt?: string;
    }) {
      const occurredAt = input.occurredAt ?? "2026-09-10T12:00:00Z";
      const [mail] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          vendorId: vendor.id,
          mailboxId: "synthetic-historical-mailbox",
          messageId: crypto.randomUUID(),
          sender: "merchant@example.test",
          subject: "Historical accepted source",
          receivedAt: new Date(input.receivedAt ?? occurredAt),
          rawChecksum: "synthetic-historical-checksum",
          createdAt: new Date(input.savedAt ?? "2026-09-11T10:00:00Z"),
        })
        .returning();
      if (!mail)
        throw new Error("Synthetic retained historical source missing");
      await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: mail.id,
          orderId: input.orderId,
          event: input.event ?? "placed",
          amount: input.amount,
          occurredAt: new Date(occurredAt),
          sourceKey: crypto.randomUUID(),
          payload: {},
        });
    }
    const matching = (amount: number, savedAfter?: Date) =>
      matchProcessedOrderMail(ctx.db, { ...window, amount, savedAfter });
    return { event, matching };
  }

  it("never matches a refund mail to a charge hunt, or an order confirmation to a statement credit", async () => {
    const s = await fixture();
    await s.event({ orderId: "OLD-REFUND", amount: 42, event: "refunded" });
    await s.event({ orderId: "SMALL-ORDER", amount: 18.5 });
    expect(await s.matching(42)).toBeNull();
    expect(await s.matching(-18.5)).toBeNull();
    await s.event({ orderId: "RIGHT-CHARGE", amount: 42 });
    await s.event({ orderId: "RIGHT-CREDIT", amount: 18.5, event: "refunded" });
    expect(await s.matching(42)).toEqual(["RIGHT-CHARGE"]);
    expect(await s.matching(-18.5)).toEqual(["RIGHT-CREDIT"]);
  });

  it("does not sum a refund into a combined-charge subset", async () => {
    const s = await fixture();
    await s.event({ orderId: "CHARGED-A", amount: 20 });
    await s.event({ orderId: "REFUNDED-B", amount: 10, event: "refunded" });
    expect(await s.matching(30)).toBeNull();
    await s.event({ orderId: "CHARGED-C", amount: 10 });
    expect((await s.matching(30))?.sort()).toEqual(["CHARGED-A", "CHARGED-C"]);
  });

  it("matches a new hunt to order mail processed before the statement charge", async () => {
    const s = await fixture();
    await s.event({
      orderId: "EARLY-CONFIRMATION",
      amount: 51.75,
      occurredAt: "2026-09-08T15:00:00Z",
    });
    await s.event({
      orderId: "OUTSIDE-WINDOW",
      amount: 51.75,
      occurredAt: "2026-08-20T15:00:00Z",
    });
    await s.event({ orderId: "COMBINED-A", amount: 12 });
    await s.event({ orderId: "COMBINED-B", amount: 7.5 });
    expect(await s.matching(51.75)).toEqual(["EARLY-CONFIRMATION"]);
    expect((await s.matching(19.5))?.sort()).toEqual([
      "COMBINED-A",
      "COMBINED-B",
    ]);
  });

  it("bounds a charge's mail window by household days, not UTC days", async () => {
    const s = await fixture();
    await s.event({
      orderId: "LAST-EVENING",
      amount: 41.5,
      occurredAt: "2026-09-18T02:00:00Z",
    });
    await s.event({
      orderId: "BEFORE-FIRST-DAY",
      amount: 17.25,
      occurredAt: "2026-09-03T06:00:00Z",
    });
    await s.event({
      orderId: "LATE-DELIVERY",
      amount: 8.5,
      occurredAt: "2026-09-18T02:00:00Z",
      receivedAt: "2026-09-18T08:00:00Z",
    });
    expect(await s.matching(41.5)).toEqual(["LAST-EVENING"]);
    expect(await s.matching(17.25)).toBeNull();
    expect(await s.matching(8.5)).toEqual(["LATE-DELIVERY"]);
  });

  it("does not re-match a reopened charge with mail saved before it was left", async () => {
    const s = await fixture();
    await s.event({
      orderId: "OLD-SAVED-SOURCE",
      amount: 33,
      savedAt: "2026-09-11T10:00:00Z",
    });
    const cutoff = new Date("2026-09-11T11:00:00Z");
    expect(await s.matching(33, cutoff)).toBeNull();
    await s.event({
      orderId: "NEW-SAVED-SOURCE",
      amount: 33,
      savedAt: "2026-09-11T12:00:00Z",
    });
    expect(await s.matching(33, cutoff)).toEqual(["NEW-SAVED-SOURCE"]);
  });
});
