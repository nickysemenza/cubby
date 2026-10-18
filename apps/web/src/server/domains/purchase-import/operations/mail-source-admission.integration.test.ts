/**
 * Failures: Pi cannot read a same-mailbox original it found while researching
 * (reads bound to the frozen roster), or reading one lets it resolve or import
 * it; a forwarded third-party confirmation becomes the recipient's Purchase or
 * VendorAccount under an automatic Run; a member's explicit selection is
 * second-guessed; a supporting original of the same purchase cannot be
 * imported, or one of another purchase joins the roster; equivalent original
 * and forwarded copies of one order book spending twice in either arrival
 * order; a vendor's direct mail to the mailbox owner's own address is
 * refused because headers-only evidence leaves the model uncertain.
 * Deterministic original checks precede all admission judgments.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { LedgerPartyId, RunId } from "@cubby/schemas/identifiers";
import {
  preparePurchaseImportInput,
  type ExtractedOrderCandidate,
} from "@cubby/schemas/purchase-import";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  email as emailTable,
  expense,
  importPreparedOrder,
  purchase,
  run,
  user,
  vendorAccount,
} from "~/server/db/schema";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { readMail, resolveMail } from "./mail-tool";
import {
  mailSource,
  memberImport,
  memberImportWorld,
  retainedMailFixture,
} from "./order-import.fixtures";

const mailboxId = "synthetic-admission-mailbox";

type Answers = {
  attribution?: "recipient" | "third_party" | "uncertain";
  relation?: "same_purchase" | "different" | "uncertain";
};

/** Answers the declared mail decisions; choice order follows each feature's roster. */
function decisions(answers: Answers) {
  return vi.fn<DecisionPort>(async (input) => {
    const relation = "admitted" in JSON.parse(input.state);
    const index = relation
      ? ["same_purchase", "different", "uncertain"].indexOf(
          answers.relation ?? "uncertain",
        )
      : ["recipient", "third_party", "uncertain"].indexOf(
          answers.attribution ?? "uncertain",
        );
    const choice = `c${index}`;
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: 0.97,
          probabilities: Object.fromEntries(
            [0, 1, 2].map((option) => [
              `c${option}`,
              option === index ? 0.97 : 0.015,
            ]),
          ),
        },
      },
    };
  });
}

const candidate = (orderId: string, amount = 24): ExtractedOrderCandidate => ({
  orderId,
  orderedAt: "2026-09-20T12:00:00Z",
  merchant: "Synthetic kettle shop",
  currency: "USD",
  printedGrandTotal: amount,
  lines: [
    { title: "Synthetic kettle", amount, quantity: 1, lineKind: "principal" },
  ],
  payments: [],
  allShipmentsDelivered: false,
});

describe("Mail import source admission", () => {
  const ctx = withTestDb();

  async function world() {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: "Synthetic kettle shop" },
    });
    return { party, vendor };
  }

  async function retain(
    partyId: LedgerPartyId,
    messageId: string,
    body: string,
    overrides: {
      mailboxId?: string;
      threadId?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    return retainedMailFixture(ctx.db, {
      ledgerPartyId: partyId,
      mailboxId: overrides.mailboxId ?? mailboxId,
      messageId,
      threadId: overrides.threadId,
      checksum: await sha256Hex(`${messageId}:${body}`),
      sender: "orders@kettle.example.test",
      content: {
        snippet: null,
        bodyText: body,
        bodyHtml: null,
        headers: overrides.headers,
      },
    });
  }

  async function mailRun(
    party: { id: LedgerPartyId; shortcode: string; name: string },
    roster: readonly RetainedMail[],
    trigger: "discovery" | "foreground",
  ) {
    const owner = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger,
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "synthetic@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      input: mailResearchRunInput.parse({
        kind: "mail_research",
        sources: roster.map((mail) => ({
          orderMailId: mail.id,
          checksum: mail.rawChecksum,
        })),
      }),
    });
    for (const mail of roster)
      await getDb(ctx.db)
        .update(emailTable)
        .set({ runId: owner.id, status: "researching" })
        .where(eq(emailTable.orderMailId, mail.id));
    const actor: ActorContext = { ...ctx.actor, runId: owner.id as RunId };
    return { id: owner.id as RunId, actor };
  }

  function prepareInput(
    runId: RunId,
    key: string,
    vendorId: string,
    mail: RetainedMail,
    orderId: string,
  ) {
    return preparePurchaseImportInput.parse({
      _runExecution: {
        runId,
        operationId: `prepare:${key}`,
        itemOperationIds: [`item:${key}`],
      },
      orders: [
        {
          stableOrderId: key,
          itemOperationId: `item:${key}`,
          vendorId,
          source: mailSource(mail),
          evidenceChecksum: mail.rawChecksum,
          extractionRevision: "synthetic@1",
          extraction: {
            status: "ready" as const,
            candidate: candidate(orderId),
          },
          lineIds: [`${key}:line-1`],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    });
  }

  async function emailRow(mail: RetainedMail) {
    const [row] = await getDb(ctx.db)
      .select({ runId: emailTable.runId, status: emailTable.status })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    return row;
  }

  async function rosterOf(runId: RunId) {
    const [row] = await getDb(ctx.db)
      .select({ input: run.input })
      .from(run)
      .where(eq(run.id, runId));
    return mailResearchRunInput
      .parse(row?.input)
      .sources.map((source) => source.orderMailId);
  }

  it("reads a same-mailbox original outside the roster for context but writes only admitted Email", async () => {
    const { party } = await world();
    const admitted = await retain(
      party.id,
      "admitted-shipment",
      "Shipped SYN-1",
    );
    const found = await retain(party.id, "found-original", "Order SYN-1");
    const elsewhere = await retain(party.id, "other-mailbox", "Order SYN-2", {
      mailboxId: "synthetic-unadmitted-mailbox",
    });
    const { actor } = await mailRun(party, [admitted], "discovery");

    await expect(
      readMail(ctx.db, { mailboxId, messageId: found.messageId }, actor),
    ).resolves.toMatchObject({
      boundToRun: false,
      checksum: found.rawChecksum,
      content: { bodyText: "Order SYN-1" },
    });
    await expect(
      readMail(ctx.db, { mailboxId, messageId: admitted.messageId }, actor),
    ).resolves.toMatchObject({ boundToRun: true });
    await expect(
      readMail(
        ctx.db,
        { mailboxId: elsewhere.mailboxId, messageId: elsewhere.messageId },
        actor,
      ),
    ).rejects.toThrow(/mailboxes it admitted/);
    await expect(
      resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: found.messageId,
          checksum: found.rawChecksum,
          disposition: { kind: "unresolved", reason: "Synthetic context" },
        },
        actor,
      ),
    ).rejects.toThrow(/did not admit/);
    expect(await emailRow(found)).toEqual({ runId: null, status: "pending" });
  });

  it("withholds a forwarded third-party confirmation from automatic import and links it without a VendorAccount", async () => {
    const { party, vendor } = await world();
    const forwarded = await retain(
      party.id,
      "forwarded-receipt",
      "---------- Forwarded message ---------\nFrom: orders@kettle.example.test\nTo: relative@example.test\nOrder SYN-3 for Relative: Synthetic kettle USD 24.00",
    );
    const { id, actor } = await mailRun(party, [forwarded], "discovery");
    const port = decisions({ attribution: "third_party" });

    await expect(
      preparePurchaseImport(
        ctx.db,
        prepareInput(id, "forwarded", vendor.shortcode, forwarded, "SYN-3"),
        actor,
        port,
      ),
    ).rejects.toThrow(/attribution is third_party/);
    expect(await getDb(ctx.db).select().from(importPreparedOrder)).toEqual([]);
    expect(await emailRow(forwarded)).toEqual({
      runId: id,
      status: "researching",
    });

    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYN-3",
    });
    await resolveMail(
      ctx.db,
      {
        mailboxId,
        messageId: forwarded.messageId,
        checksum: forwarded.rawChecksum,
        disposition: {
          kind: "linked",
          purchaseIds: [existing.shortcode],
          event: "confirmation",
        },
      },
      actor,
      undefined,
      port,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(vendorAccount)
        .where(
          and(
            eq(vendorAccount.ledgerPartyId, party.id),
            notDeleted(vendorAccount),
          ),
        ),
    ).toEqual([]);
  });

  it("imports a vendor's direct mail to the owner's address under an automatic Run without the model", async () => {
    const { party, vendor } = await world();
    const [owner] = await getDb(ctx.db)
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, ctx.actor.userId));
    // An invoice whose body is only its PDF: headers are the whole evidence.
    const invoice = await retain(party.id, "own-invoice", "Invoice attached.", {
      headers: {
        from: "Synthetic kettle shop <orders@kettle.example.test>",
        to: owner!.email.toUpperCase(),
      },
    });
    const { id, actor } = await mailRun(party, [invoice], "discovery");
    const port = vi.fn<DecisionPort>(async () => {
      throw new Error("Own mail needs no attribution decision");
    });
    const prepared = await preparePurchaseImport(
      ctx.db,
      prepareInput(id, "own-invoice", vendor.shortcode, invoice, "SYN-9"),
      actor,
      port,
    );
    expect(prepared.orders).toHaveLength(1);
    expect(port).not.toHaveBeenCalled();
  });

  it("imports a member-selected forwarded confirmation without second-guessing the selection", async () => {
    const { party, vendor } = await world();
    const forwarded = await retain(
      party.id,
      "selected-forward",
      "Fwd: Order SYN-4 Synthetic kettle USD 24.00",
    );
    const { id, actor } = await mailRun(party, [forwarded], "foreground");
    const port = vi.fn<DecisionPort>(async () => {
      throw new Error("An explicit selection needs no attribution decision");
    });
    const prepared = await preparePurchaseImport(
      ctx.db,
      prepareInput(id, "selected", vendor.shortcode, forwarded, "SYN-4"),
      actor,
      port,
    );
    expect(prepared.orders).toHaveLength(1);
    expect(port).not.toHaveBeenCalled();
  });

  it("admits and imports a supporting original of the same purchase, replaying without another admission", async () => {
    const { party, vendor } = await world();
    const shipment = await retain(
      party.id,
      "anchor-shipment",
      "Your order SYN-5 has shipped",
      { threadId: "synthetic-thread-5" },
    );
    const original = await retain(
      party.id,
      "supporting-original",
      "Order SYN-5 confirmed: Synthetic kettle USD 24.00",
      { threadId: "synthetic-thread-5" },
    );
    const { id, actor } = await mailRun(party, [shipment], "discovery");
    const port = decisions({
      attribution: "recipient",
      relation: "same_purchase",
    });
    const input = prepareInput(
      id,
      "supporting",
      vendor.shortcode,
      original,
      "SYN-5",
    );
    const prepared = await preparePurchaseImport(ctx.db, input, actor, port);
    expect(await rosterOf(id)).toEqual([shipment.id, original.id]);
    expect(await emailRow(original)).toEqual({
      runId: id,
      status: "researching",
    });
    const unavailable = vi.fn<DecisionPort>(async () => {
      throw new Error("Synthetic decision service unavailable on replay");
    });
    await expect(
      preparePurchaseImport(ctx.db, input, actor, unavailable),
    ).resolves.toEqual(prepared);
    expect(unavailable).not.toHaveBeenCalled();
    expect(await rosterOf(id)).toEqual([shipment.id, original.id]);

    const committed = await commitPurchaseImport(
      ctx.db,
      {
        _runExecution: { runId: id, operationId: "commit:supporting" },
        prepareOperationId: "prepare:supporting",
        defaultTrade: "other",
        resolutions: [
          {
            stableOrderId: "supporting",
            stableLineId: "supporting:line-1",
            resolution: { kind: "expense_only" },
          },
        ],
      },
      actor,
      port,
    );
    expect(committed.items[0]?.outcome).toBe("created");
    expect(
      await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(and(eq(purchase.orderId, "SYN-5"), notDeleted(purchase))),
    ).toHaveLength(1);
  });

  it.each([
    ["another purchase", { attribution: "recipient", relation: "different" }],
    [
      "a third-party copy",
      { attribution: "third_party", relation: "same_purchase" },
    ],
  ] as const)(
    "refuses a supporting original that is %s and leaves the roster unchanged",
    async (_, answers) => {
      const { party, vendor } = await world();
      const shipment = await retain(party.id, "anchor-6", "Shipped SYN-6");
      const other = await retain(party.id, "other-6", "Order SYN-7 confirmed");
      const { id, actor } = await mailRun(party, [shipment], "discovery");
      await expect(
        preparePurchaseImport(
          ctx.db,
          prepareInput(id, "other", vendor.shortcode, other, "SYN-7"),
          actor,
          decisions(answers),
        ),
      ).rejects.toThrow(/same purchase|attribute/);
      expect(await rosterOf(id)).toEqual([shipment.id]);
      expect(await emailRow(other)).toEqual({ runId: null, status: "pending" });
    },
  );

  it.each([
    ["original first", ["original", "forwarded"]],
    ["forwarded copy first", ["forwarded", "original"]],
  ] as const)(
    "converges an order's original and self-forwarded copy on one Purchase and one spend (%s)",
    async (_, order) => {
      const { party, vendor } = await world();
      const sources = {
        original: await retain(
          party.id,
          "order-original",
          "Order SYN-8 confirmed: Synthetic kettle USD 24.00",
        ),
        forwarded: await retain(
          party.id,
          "order-forwarded",
          "Fwd: Order SYN-8 confirmed: Synthetic kettle USD 24.00",
        ),
      };
      for (const key of order)
        await memberImport(ctx.db, ctx.actor, {
          key,
          orders: [
            {
              stableOrderId: key,
              vendorId: vendor.shortcode,
              source: mailSource(sources[key]),
              extraction: { status: "ready", candidate: candidate("SYN-8") },
            },
          ],
          defaultTrade: "other",
        });
      const purchases = await getDb(ctx.db)
        .select({ id: purchase.id })
        .from(purchase)
        .where(and(eq(purchase.orderId, "SYN-8"), notDeleted(purchase)));
      expect(purchases).toHaveLength(1);
      const spend = await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .where(
          and(eq(expense.purchaseId, purchases[0]!.id), notDeleted(expense)),
        );
      expect(spend.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBe(24);
    },
  );
});
