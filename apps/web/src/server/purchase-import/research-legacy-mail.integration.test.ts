import { runEntityId } from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  mailboxMessage,
  orderMail,
  orderMailEvent,
  run,
  runOrderCandidate,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { productResearchFixture } from "./product-research.fixtures";
import { loadMailResearchSources } from "./research-run";
import { researchServiceFor } from "./research-service";
import { controlRun } from "./run-service";

// Historical event selections have no replacement task roster. Conversion must
// prove the original event/order/checksum mapping and preserve mailbox provenance,
// candidate outcomes and stopped-child replay without executing the old loop.
describe("historical mail research admission", () => {
  const ctx = withTestDb();
  async function fixture(selected: boolean) {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const sources = [];
    for (const name of selected
      ? ["settled", "pending", "another"]
      : ["pending"]) {
      const orderId = `EXAMPLE-LEGACY-${name.toUpperCase()}`;
      const bodyText = `Synthetic order ${orderId}: one exact small device, total $12.00`;
      const [mail] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: f.party.id,
          vendorId: f.order.vendorId,
          mailboxId:
            name === "another"
              ? "synthetic-other-owned-mailbox"
              : `legacy:${f.party.id}`,
          // Repeated Gmail IDs in different mailboxes must not alias ledger ownership.
          messageId:
            name === "settled"
              ? "synthetic-settled-message"
              : "synthetic-repeated-message-id",
          sender: "orders@example.test",
          subject: `Synthetic ${name} order`,
          receivedAt: new Date("2026-09-01T18:00:00Z"),
          rawChecksum: await sha256Hex(bodyText),
          content: { snippet: null, bodyText, bodyHtml: null },
        })
        .returning();
      if (!mail) throw new Error("Synthetic historical original missing.");
      const [event] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: mail.id,
          event: "order_placed",
          orderId,
          sourceKey: `synthetic-placement:${orderId}`,
          payload: {},
        })
        .returning();
      if (!event) throw new Error("Synthetic historical event missing.");
      sources.push({ mail, event, name });
    }
    const orders = sources.map(({ mail, event }) => ({
      eventId: event.id,
      evidenceChecksum: mail.rawChecksum,
      orderId: event.orderId!,
    }));
    const originalId = runEntityId.parse(crypto.randomUUID());
    const original = await insertWithShortcode(ctx.db, "run", {
      id: originalId,
      ledgerPartyId: f.party.id,
      actorUserId: ctx.actor.userId,
      actorName: f.parent.actorName,
      actorEmail: f.parent.actorEmail,
      actorLedgerPartyShortcode: f.parent.actorLedgerPartyShortcode,
      actorLedgerPartyName: f.parent.actorLedgerPartyName,
      actorLedgerPartyKind: f.parent.actorLedgerPartyKind,
      vendorId: f.order.vendorId,
      purpose: "account_sync",
      coordinatorModel: coordinatorModelFor("account_sync"),
      agentSessionId: importRunAgentIdentity(originalId, "account_sync"),
      dispatchEventId: crypto.randomUUID(),
      trigger: "manual",
      status: "needs_review",
      attempt: selected ? 2 : null,
      parentRunId: f.parent.id,
      input: selected
        ? { kind: "order_mail_import", orders }
        : { kind: "order_mail_import", ...orders[0]! },
    });
    if (selected)
      await getDb(ctx.db)
        .insert(runOrderCandidate)
        .values(
          sources.map(({ event, name }) => ({
            runId: original.id,
            orderId: event.orderId!,
            state: name === "settled" ? "imported" : "skipped",
          })),
        );
    for (const { mail, name } of sources)
      await getDb(ctx.db)
        .insert(mailboxMessage)
        .values({
          ledgerPartyId: f.party.id,
          mailboxId: mail.mailboxId,
          messageId: mail.messageId,
          checksum: mail.rawChecksum,
          classification: "related",
          classificationVersion: "synthetic-historical-version",
          status: name === "settled" ? "completed" : "researching",
          orderMailId: mail.id,
          runId: original.id,
        });
    return { f, original, sources };
  }
  it.each([false, true])(
    "converts exact legacy mail sources, preserving original scope and lineage (selected=%s)",
    async (selected) => {
      const { f, original, sources } = await fixture(selected);
      const candidates = await getDb(ctx.db)
        .select()
        .from(runOrderCandidate)
        .where(eq(runOrderCandidate.runId, original.id));
      const input = {
        runPublicId: original.shortcode,
        action: "retry" as const,
      };
      const result = await controlRun(ctx.db, ctx.actor, input);
      if (!("successorRunId" in result) || !result.successorRunId)
        throw new Error("Synthetic historical mail child missing.");
      const id = runEntityId.parse(result.successorRunId);
      const [successor] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, id));
      if (!successor) throw new Error("Synthetic historical mail Run missing.");
      expect(successor).toMatchObject({
        purpose: "mail_import",
        predecessorRunId: original.id,
        parentRunId: f.parent.id,
        attempt: original.attempt === null ? null : original.attempt + 1,
        cause: "retry",
      });
      const expected = sources.filter(({ name }) => name !== "settled");
      expect(mailResearchRunInput.parse(successor.input).sources).toEqual(
        expected
          .map(({ mail }) => ({
            orderMailId: mail.id,
            checksum: mail.rawChecksum,
          }))
          .sort((a, b) => a.orderMailId.localeCompare(b.orderMailId)),
      );
      expect(await loadMailResearchSources(ctx.db, id)).toEqual(
        expect.arrayContaining(
          expected.map(({ mail }) =>
            expect.objectContaining({
              orderMailId: mail.id,
              mailboxId: mail.mailboxId,
            }),
          ),
        ),
      );
      const tasks = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, id));
      expect(tasks.map((task) => task.workKey).sort()).toEqual(
        expected.map(({ mail }) => mail.id).sort(),
      );
      expect(
        await researchServiceFor(ctx.db, fromPartial<Env>({}), id).researchNext(
          {},
          crypto.randomUUID(),
        ),
      ).toMatchObject({ status: "working", work: { kind: "mail" } });
      const messages = await getDb(ctx.db).select().from(mailboxMessage);
      for (const { mail, name } of sources)
        expect(
          messages.find((message) => message.orderMailId === mail.id),
        ).toMatchObject({
          mailboxId: mail.mailboxId,
          messageId: mail.messageId,
          runId: name === "settled" ? original.id : id,
        });
      expect(
        await getDb(ctx.db).select().from(run).where(eq(run.id, original.id)),
      ).toEqual([original]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(runOrderCandidate)
          .where(eq(runOrderCandidate.runId, original.id)),
      ).toEqual(candidates);
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: successor.shortcode,
        action: "cancel",
      });
      await getDb(ctx.db)
        .update(orderMailEvent)
        .set({ supersededAt: new Date() })
        .where(eq(orderMailEvent.id, expected[0]!.event.id));
      expect(await controlRun(ctx.db, ctx.actor, input)).toMatchObject({
        successorRunId: id,
        successorStatus: "failed",
        created: false,
      });
    },
  );
  it.each([
    "changed_checksum",
    "superseded_event",
    "order_identity",
    "missing_candidate",
  ] as const)(
    "refuses unproven historical mail mapping: %s",
    async (reason) => {
      const { original, sources } = await fixture(true);
      const pending = sources.find(({ name }) => name === "pending")!;
      if (reason === "changed_checksum")
        await getDb(ctx.db)
          .update(orderMail)
          .set({ rawChecksum: "f".repeat(64) })
          .where(eq(orderMail.id, pending.mail.id));
      if (reason === "superseded_event")
        await getDb(ctx.db)
          .update(orderMailEvent)
          .set({ supersededAt: new Date() })
          .where(eq(orderMailEvent.id, pending.event.id));
      if (reason === "order_identity")
        await getDb(ctx.db)
          .update(orderMailEvent)
          .set({ orderId: "EXAMPLE-OTHER-ORDER" })
          .where(eq(orderMailEvent.id, pending.event.id));
      if (reason === "missing_candidate")
        await getDb(ctx.db)
          .delete(runOrderCandidate)
          .where(eq(runOrderCandidate.orderId, pending.event.orderId!));
      await expect(
        controlRun(ctx.db, ctx.actor, {
          runPublicId: original.shortcode,
          action: "retry",
        }),
      ).rejects.toThrow(/Historical mail/);
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.predecessorRunId, original.id)),
      ).toEqual([]);
    },
  );
  it("establishes durable source ownership for proven historical originals with no mailbox ledger", async () => {
    const { original, sources } = await fixture(false);
    const source = sources[0]!.mail;
    await getDb(ctx.db)
      .delete(mailboxMessage)
      .where(eq(mailboxMessage.orderMailId, source.id));
    const result = await controlRun(ctx.db, ctx.actor, {
      runPublicId: original.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in result) || !result.successorRunId)
      throw new Error("Synthetic historical child missing.");
    expect(
      await getDb(ctx.db)
        .select()
        .from(mailboxMessage)
        .where(eq(mailboxMessage.orderMailId, source.id)),
    ).toEqual([
      expect.objectContaining({
        ledgerPartyId: source.ledgerPartyId,
        mailboxId: source.mailboxId,
        messageId: source.messageId,
        orderMailId: source.id,
        checksum: source.rawChecksum,
        status: "researching",
        runId: result.successorRunId,
      }),
    ]);
  });
  it("keeps covered historical candidates settled when retrying the saved selection", async () => {
    const { original, sources } = await fixture(true);
    const settled = sources.find(({ name }) => name === "settled")!;
    await getDb(ctx.db)
      .update(runOrderCandidate)
      .set({ state: "covered" })
      .where(eq(runOrderCandidate.orderId, settled.event.orderId!));
    const result = await controlRun(ctx.db, ctx.actor, {
      runPublicId: original.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in result) || !result.successorRunId)
      throw new Error("Synthetic retry child missing.");
    const tasks = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, runEntityId.parse(result.successorRunId)));
    expect(tasks.map((task) => task.workKey).sort()).toEqual(
      sources
        .filter(({ name }) => name !== "settled")
        .map(({ mail }) => mail.id)
        .sort(),
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(mailboxMessage)
        .where(eq(mailboxMessage.orderMailId, settled.mail.id)),
    ).toEqual([
      expect.objectContaining({ runId: original.id, status: "completed" }),
    ]);
  });
});
