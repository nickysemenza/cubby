/**
 * Failures: a forwarded or uncertain Email prepares a booking event; a
 * model-reported amount, identifier or account label absent from the original
 * is accepted; an ambiguous amount literal is read one way; a forged or
 * mutated preparation, or one whose Email changed after inference, still
 * passes the booking assertion; another member's Email is prepared; a
 * vendor's direct mail to the owner's own address still waits on an
 * uncertain model, or a forwarded copy to that address skips it.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { MailFinancialEventModelOutput } from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb, withTransaction } from "~/server/db/helpers";
import { email as emailTable, orderMail, user } from "~/server/db/schema";

import {
  memberImportWorld,
  retainedMailFixture,
} from "../operations/order-import.fixtures";
import {
  assertMailFinancialEvidenceCurrent,
  type PreparedMailFinancialEvent,
} from "../repo/mail-financial-event";
import {
  literalAmountMinor,
  prepareMailFinancialEvent,
} from "./mail-financial-event";

const body =
  "You paid Synthetic Gardens $1,234.50 with Visa ending 0000. Payment ID SYN-PAY-1001.";

const attribution = (choice: "c0" | "c1" | "c2") =>
  vi.fn<DecisionPort>(async () => ({
    answers: {
      selection: {
        type: "choice",
        choice,
        confidence: 0.97,
        probabilities: { c0: 0.01, c1: 0.01, c2: 0.01, [choice]: 0.97 },
      },
    },
  }));

const reported = (
  overrides: Partial<MailFinancialEventModelOutput> = {},
): MailFinancialEventModelOutput => ({
  kind: "purchase_payment",
  confidence: "high",
  amountText: "$1,234.50",
  currency: "USD",
  sourceAccountLabel: "Visa ending 0000",
  providerEventId: "SYN-PAY-1001",
  occurredOn: null,
  counterpartyLabel: "Synthetic Gardens",
  ...overrides,
});

describe("literal amounts", () => {
  it.each([
    ["$1,234.50", "USD", 123_450],
    ["1.234,50 €", "EUR", 123_450],
    ["USD 42", "USD", 4_200],
    ["¥1,200", "JPY", 1_200],
    ["$1,234", "USD", 123_400],
    ["1 234,56", "EUR", 123_456],
  ])("reads %s as %s minor units", (text, currency, minor) => {
    expect(literalAmountMinor(text, currency)).toBe(minor);
  });

  it.each([
    ["1,234 or 2,000", "USD"],
    ["1,234.567", "USD"],
    ["0.00", "USD"],
    ["no amount", "USD"],
  ])("refuses %s", (text, currency) => {
    expect(literalAmountMinor(text, currency)).toBeNull();
  });
});

describe("mail financial event port", () => {
  const ctx = withTestDb();

  async function retained(headers?: Record<string, string>) {
    const { party } = await memberImportWorld(ctx.db, ctx.actor);
    const mail = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-payment",
      checksum: await sha256Hex(body),
      content: { snippet: null, bodyText: body, bodyHtml: null, headers },
    });
    const [row] = await getDb(ctx.db)
      .select({ id: emailTable.id })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    return { mail, emailId: parseEntityId("email", row!.id) };
  }

  it("prepares a recipient's verified event and revalidates it in the booking transaction", async () => {
    const { emailId, mail } = await retained();
    const result = await prepareMailFinancialEvent(
      ctx.db,
      { emailId },
      ctx.actor,
      { decide: attribution("c0"), extract: async () => reported() },
    );
    if (result.status !== "verified") throw new Error(result.reason);
    const event = await withTransaction(ctx.db, (tx) =>
      assertMailFinancialEvidenceCurrent(tx, result.preparation, ctx.actor),
    );
    expect(event).toEqual({
      kind: "purchase_payment",
      amount: { minor: 123_450, currency: "USD" },
      sourceAccountLabel: "Visa ending 0000",
      providerEventId: "SYN-PAY-1001",
      occurredOn: null,
      counterpartyLabel: "Synthetic Gardens",
    });
    expect(result.preparation.checksum).toBe(mail.rawChecksum);
    expect(Object.isFrozen(result.preparation.event.amount)).toBe(true);
    expect(() => {
      (result.preparation.event.amount as { minor: number }).minor = 1;
    }).toThrow(/read only/);

    const forged: PreparedMailFinancialEvent = { ...result.preparation };
    await expect(
      withTransaction(ctx.db, (tx) =>
        assertMailFinancialEvidenceCurrent(tx, forged, ctx.actor),
      ),
    ).rejects.toThrow(/verified preparation/);

    await getDb(ctx.db)
      .update(orderMail)
      .set({
        content: {
          snippet: null,
          bodyText: "Payment cancelled.",
          bodyHtml: null,
        },
      })
      .where(eq(orderMail.id, mail.id));
    await expect(
      withTransaction(ctx.db, (tx) =>
        assertMailFinancialEvidenceCurrent(tx, result.preparation, ctx.actor),
      ),
    ).rejects.toThrow(/no longer shows/);
  });

  it.each([
    [
      "a forwarded third-party copy",
      attribution("c1"),
      reported(),
      /not attributed/,
    ],
    ["uncertain attribution", attribution("c2"), reported(), /not attributed/],
    [
      "an identifier absent from the original",
      attribution("c0"),
      reported({ providerEventId: "SYN-PAY-9999" }),
      /not in the original/,
    ],
    [
      "an ambiguous amount",
      attribution("c0"),
      reported({ amountText: "$1,234.50", currency: "JPY" }),
      /amount or currency/,
    ],
    [
      "a low-confidence event",
      attribution("c0"),
      reported({ confidence: "medium" }),
      /does not confidently/,
    ],
  ] as const)("leaves %s unverified", async (_, decide, output, reason) => {
    const { emailId } = await retained();
    await expect(
      prepareMailFinancialEvent(ctx.db, { emailId }, ctx.actor, {
        decide,
        extract: async () => output,
      }),
    ).resolves.toEqual({
      status: "unverified",
      reason: expect.stringMatching(reason),
    });
  });

  async function ownerAddress() {
    const [owner] = await getDb(ctx.db)
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, ctx.actor.userId));
    return owner!.email;
  }

  it("attributes a vendor's direct mail to the owner without the model", async () => {
    const { emailId } = await retained({
      from: "Synthetic Gardens <billing@gardens.example.test>",
      to: await ownerAddress(),
    });
    const decide = attribution("c2");
    const result = await prepareMailFinancialEvent(
      ctx.db,
      { emailId },
      ctx.actor,
      { decide, extract: async () => reported() },
    );
    expect(result.status).toBe("verified");
    expect(decide).not.toHaveBeenCalled();
  });

  it("asks the model about a forwarded copy to the owner", async () => {
    const { emailId } = await retained({
      from: "Synthetic Gardens <billing@gardens.example.test>",
      to: await ownerAddress(),
      "x-forwarded-to": await ownerAddress(),
    });
    const decide = attribution("c2");
    await expect(
      prepareMailFinancialEvent(ctx.db, { emailId }, ctx.actor, {
        decide,
        extract: async () => reported(),
      }),
    ).resolves.toEqual({
      status: "unverified",
      reason: expect.stringMatching(/uncertain; model uncertain at p=0\.97/),
    });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("refuses another member's Email before inference", async () => {
    const { emailId } = await retained();
    const extract = vi.fn(async () => reported());
    await expect(
      prepareMailFinancialEvent(
        ctx.db,
        { emailId },
        {
          ...ctx.actor,
          userId: "synthetic-other-user" as typeof ctx.actor.userId,
        },
        { decide: attribution("c0"), extract },
      ),
    ).resolves.toMatchObject({ status: "unverified" });
    expect(extract).not.toHaveBeenCalled();
  });
});
