import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
/** Failures: shipment/no-ID/attachment-only sources remain confirmation-gated;
 * stale or foreign source bytes launch a Mail import; multi-source context is split. */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { orderMail, orderMailEvent, ledgerParty } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import type { startMailImport } from "../mail-import-run";
import { startOrderMailImport, startSelectedOrderMailImport } from "./import";

describe("member-owned Mail import launches", () => {
  const ctx = withTestDb();
  const queue = { send: async () => undefined };
  const seed = async (owned = true) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic source member",
      kind: "member",
      userId: owned ? ctx.actor.userId : null,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: "google-subject",
        messageId: crypto.randomUUID(),
        rawChecksum: "original-source",
        sender: "platform@example.test",
        subject: "Shipment update",
        receivedAt: new Date(),
        content: { bodyText: null, bodyHtml: null, snippet: null },
      })
      .returning();
    if (!mail) throw new Error("Synthetic mail missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "shipped",
        sourceKey: `synthetic:${mail.id}`,
        payload: {},
      })
      .returning();
    if (!event) throw new Error("Synthetic event missing");
    return {
      party,
      mail,
      input: { eventId: event.id, evidenceChecksum: mail.rawChecksum },
    };
  };
  const starter = async (rawLedgerPartyId: string) => {
    const ledgerPartyId = parseEntityId("ledgerParty", rawLedgerPartyId);
    const [party] = await getDb(ctx.db)
      .select({ shortcode: ledgerParty.shortcode })
      .from(ledgerParty)
      .where(eq(ledgerParty.id, ledgerPartyId));
    if (!party) throw new Error("Synthetic actor member missing");
    const row = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      ledgerPartyId,
      actorLedgerPartyShortcode: party.shortcode,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic researcher",
      actorEmail: "research@example.test",
      status: "running",
      trigger: "manual",
    });
    const research = vi.fn(
      async (..._args: Parameters<typeof startMailImport>) => [
        { runId: row.id, status: row.status },
      ],
    );
    return { row, research };
  };
  it("launches retained lifecycle evidence without vendor, order ID, or body eligibility rules", async () => {
    const source = await seed();
    const port = await starter(source.party.id);
    expect(
      await startOrderMailImport(
        ctx.db,
        source.input,
        ctx.actor,
        queue,
        "manual",
        port,
      ),
    ).toEqual({ runIds: [port.row.shortcode] });
    expect(port.research.mock.calls[0]?.[1]).toMatchObject({
      ledgerPartyId: source.party.id,
      messageIds: [source.mail.id],
      expectedChecksums: [
        { orderMailId: source.mail.id, checksum: source.mail.rawChecksum },
      ],
    });
  });
  it("returns every source-owned research Run when a selection overlaps ongoing source sets", async () => {
    const source = await seed();
    const first = await starter(source.party.id);
    const second = await starter(source.party.id);
    const research: typeof startMailImport = async () => [
      { runId: first.row.id, status: "running" },
      { runId: second.row.id, status: "running" },
    ];
    expect(
      await startOrderMailImport(
        ctx.db,
        source.input,
        ctx.actor,
        queue,
        "manual",
        { research },
      ),
    ).toEqual({ runIds: [first.row.shortcode, second.row.shortcode] });
  });
  it("refuses stale checksums and foreign ownership before any research launch", async () => {
    const own = await seed();
    const foreign = await seed(false);
    const port = await starter(own.party.id);
    await expect(
      startOrderMailImport(
        ctx.db,
        { ...own.input, evidenceChecksum: "stale" },
        ctx.actor,
        queue,
        "manual",
        port,
      ),
    ).rejects.toThrow(/changed/u);
    await expect(
      startOrderMailImport(
        ctx.db,
        foreign.input,
        ctx.actor,
        queue,
        "manual",
        port,
      ),
    ).rejects.toThrow(/member/u);
    expect(port.research).not.toHaveBeenCalled();
  });
  it("passes selected source context to one shared launcher instead of splitting semantic work", async () => {
    const a = await seed();
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ...a.mail,
        id: crypto.randomUUID(),
        messageId: "second-source",
      })
      .returning();
    if (!mail) throw new Error("Synthetic mail missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "refunded",
        sourceKey: "synthetic:second-source",
        payload: {},
      })
      .returning();
    if (!event) throw new Error("Synthetic event missing");
    const port = await starter(a.party.id);
    expect(
      await startSelectedOrderMailImport(
        ctx.db,
        {
          orders: [
            a.input,
            { eventId: event.id, evidenceChecksum: mail.rawChecksum },
          ],
        },
        ctx.actor,
        queue,
        port,
      ),
    ).toEqual({ runIds: [port.row.shortcode] });
    expect(port.research).toHaveBeenCalledTimes(1);
    expect(port.research.mock.calls[0]?.[1].messageIds).toEqual(
      expect.arrayContaining([a.mail.id, mail.id]),
    );
  });
});
