import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
/**
 * Selected-Email import failure modes: a shipment with no order id or vendor
 * must still launch; overlapping source sets must return every owning Run; a
 * stale checksum, another member's Email or a duplicate must launch
 * nothing; a selection is one shared launch.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import { email as emailTable, ledgerParty } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { syntheticRetainedMail } from "../service/gmail/retained-mail.fixtures";
import { startEmailImport } from "./email-actions";
import type { startMailImport } from "./mail-import-run";

describe("selected Email import", () => {
  const ctx = withTestDb();
  const queue = { send: async () => undefined };
  const seed = async (owned = true, party?: { id: string }) => {
    const owner =
      party ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic source member",
        kind: "member",
        userId: owned ? ctx.actor.userId : null,
      }));
    const checksum = "d".repeat(63) + Math.floor(Math.random() * 10);
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: parseEntityId("ledgerParty", owner.id),
      mailboxId: "google-subject",
      messageId: crypto.randomUUID(),
      rawChecksum: checksum,
      sender: "platform@example.test",
      subject: "Shipment update",
      receivedAt: new Date(),
      content: {
        bodyText: "Synthetic shipment",
        bodyHtml: null,
        snippet: null,
      },
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ classification: "related" })
      .where(eq(emailTable.orderMailId, mail.id));
    const [row] = await getDb(ctx.db)
      .select({ shortcode: emailTable.shortcode })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    return {
      party: owner,
      mail,
      item: {
        id: parseShortcodeFor("email", row!.shortcode),
        expectedChecksum: checksum,
      },
    };
  };
  const launcher = async (rawLedgerPartyId: string) => {
    const ledgerPartyId = parseEntityId("ledgerParty", rawLedgerPartyId);
    const [party] = await getDb(ctx.db)
      .select({ shortcode: ledgerParty.shortcode })
      .from(ledgerParty)
      .where(eq(ledgerParty.id, ledgerPartyId));
    const row = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      ledgerPartyId,
      actorLedgerPartyShortcode: party!.shortcode,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic importer",
      actorEmail: "import@example.test",
      status: "running",
      trigger: "manual",
    });
    const launch = vi.fn(
      async (..._args: Parameters<typeof startMailImport>) => [
        { runId: row.id, status: row.status },
      ],
    );
    return { row, launch };
  };

  it("launches a retained shipment without vendor, order id or body eligibility rules", async () => {
    const source = await seed();
    const port = await launcher(source.party.id);
    expect(
      await startEmailImport(
        ctx.db,
        { items: [source.item] },
        ctx.actor,
        queue,
        port,
      ),
    ).toEqual({ runIds: [port.row.shortcode] });
    expect(port.launch.mock.calls[0]?.[1]).toMatchObject({
      ledgerPartyId: source.party.id,
      messageIds: [source.mail.id],
      expectedChecksums: [
        { orderMailId: source.mail.id, checksum: source.mail.rawChecksum },
      ],
    });
  });

  it("returns every owning Run when a selection overlaps ongoing source sets", async () => {
    const source = await seed();
    const first = await launcher(source.party.id);
    const second = await launcher(source.party.id);
    const launch: typeof startMailImport = async () => [
      { runId: first.row.id, status: "running" },
      { runId: second.row.id, status: "running" },
    ];
    expect(
      await startEmailImport(
        ctx.db,
        { items: [source.item] },
        ctx.actor,
        queue,
        { launch },
      ),
    ).toEqual({ runIds: [first.row.shortcode, second.row.shortcode] });
  });

  it("refuses a stale checksum, another member's Email or a duplicate before any launch", async () => {
    const own = await seed();
    const foreign = await seed(false);
    const port = await launcher(own.party.id);
    const run = (items: (typeof own.item)[]) =>
      startEmailImport(ctx.db, { items }, ctx.actor, queue, port);
    await expect(
      run([{ ...own.item, expectedChecksum: "0".repeat(64) }]),
    ).rejects.toThrow(/changed/u);
    await expect(run([foreign.item])).rejects.toThrow(/member/u);
    await expect(run([own.item, own.item])).rejects.toThrow(/more than once/u);
    expect(port.launch).not.toHaveBeenCalled();
  });

  it("passes a selection to one shared launcher instead of splitting it", async () => {
    const a = await seed();
    const b = await seed(true, a.party);
    const port = await launcher(a.party.id);
    expect(
      await startEmailImport(
        ctx.db,
        { items: [a.item, b.item] },
        ctx.actor,
        queue,
        port,
      ),
    ).toEqual({ runIds: [port.row.shortcode] });
    expect(port.launch).toHaveBeenCalledTimes(1);
    expect(port.launch.mock.calls[0]?.[1].messageIds).toEqual([
      a.mail.id,
      b.mail.id,
    ]);
  });
});
