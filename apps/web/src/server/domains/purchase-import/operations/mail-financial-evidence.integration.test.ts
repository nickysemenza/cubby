/**
 * Failures: a transfer, incoming payment or reimbursement Email can only stay
 * unresolved or becomes a Purchase/Expense; Pi associates it with a
 * transaction whose provider identifier, amount or direction differs, or whose
 * identifier another transaction also holds; a forwarded copy's event is
 * trusted; a member's explicit review is refused for lacking a model verdict.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor, type RunId } from "@cubby/schemas/identifiers";
import type { MailFinancialEventModelOutput } from "@cubby/schemas/mailbox-research";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import * as runFeature from "~/server/ai/run-feature";
import { getDb } from "~/server/db/helpers";
import {
  email as emailTable,
  emailFinancialAssociation,
  expense,
  purchase,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { resolveMail } from "./mail-tool";
import {
  memberImportWorld,
  retainedMailFixture,
} from "./order-import.fixtures";

const mailboxId = "synthetic-financial-mailbox";
const body =
  "Synthetic Friend paid you $40.00 for dinner. Transaction ID SYN-P2P-77. Deposited to Synthetic checking.";

const attribution = (choice: "c0" | "c1") =>
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
  kind: "reimbursement",
  confidence: "high",
  amountText: "$40.00",
  currency: "USD",
  sourceAccountLabel: "Synthetic checking",
  providerEventId: "SYN-P2P-77",
  occurredOn: null,
  counterpartyLabel: "Synthetic Friend",
  ...overrides,
});

describe("financial-only Email evidence", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());

  async function world(
    transaction: {
      amount?: number;
      kind?: "income" | "purchase";
      ref?: string;
    } = {},
  ) {
    const { party } = await memberImportWorld(ctx.db, ctx.actor);
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic checking",
      identity: { kind: "cash" },
      ledgerPartyId: party.shortcode,
    });
    const posted = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: transaction.kind ?? "income",
      amount: transaction.amount ?? -40,
      status: "posted",
      transactionDate: "2026-09-10",
      postedDate: "2026-09-11",
      merchant: "Synthetic Friend",
      sourceRefs: [
        {
          source: "synthetic-p2p",
          externalId: transaction.ref ?? "SYN-P2P-77",
        },
      ],
    });
    const mail = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId,
      messageId: "synthetic-p2p-notice",
      checksum: await sha256Hex(body),
      content: { snippet: null, bodyText: body, bodyHtml: null },
    });
    const owner = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "discovery",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "synthetic@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      input: mailResearchRunInput.parse({
        kind: "mail_research",
        sources: [{ orderMailId: mail.id, checksum: mail.rawChecksum }],
      }),
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ runId: owner.id, status: "researching" })
      .where(eq(emailTable.orderMailId, mail.id));
    const pi: ActorContext = { ...ctx.actor, runId: owner.id as RunId };
    return { account, posted, mail, pi };
  }

  const resolveInput = (
    mail: Awaited<ReturnType<typeof world>>["mail"],
    transactionId: string,
  ) => ({
    mailboxId,
    messageId: mail.messageId,
    checksum: mail.rawChecksum,
    disposition: {
      kind: "financial" as const,
      transactionId: parseShortcodeFor("financialTransaction", transactionId),
      reason: "Synthetic reimbursement notice for this deposit",
    },
  });

  async function associations() {
    return getDb(ctx.db)
      .select({
        transactionId: emailFinancialAssociation.transactionId,
        sourceAccountLabel: emailFinancialAssociation.sourceAccountLabel,
      })
      .from(emailFinancialAssociation);
  }

  it("reuses an accepted reimbursement mapping without spending, idempotently", async () => {
    const { account, posted, mail, pi } = await world();
    await resolveMail(
      ctx.db,
      {
        ...resolveInput(mail, posted.output.id),
        disposition: {
          kind: "financial",
          transactionId: posted.output.id,
          reason: "Member verified the deposit",
          review: {
            reviewedAccountId: account.output.id,
            sourceAccountLabel: "Synthetic checking",
          },
        },
      },
      ctx.actor,
    );
    vi.spyOn(runFeature, "runStructuredFeature").mockResolvedValue(reported());
    const input = resolveInput(mail, posted.output.id);
    await expect(
      resolveMail(ctx.db, input, pi, undefined, attribution("c0")),
    ).resolves.toMatchObject({ disposition: "financial", purchaseIds: [] });
    await resolveMail(ctx.db, input, pi, undefined, attribution("c0"));
    expect(await associations()).toEqual([
      {
        transactionId: expect.any(String),
        sourceAccountLabel: "Synthetic checking",
      },
    ]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });

  it("refuses an unqualified equal provider id without an accepted cross-provider mapping", async () => {
    const { posted, mail, pi } = await world();
    vi.spyOn(runFeature, "runStructuredFeature").mockResolvedValue(reported());
    await expect(
      resolveMail(
        ctx.db,
        resolveInput(mail, posted.output.id),
        pi,
        undefined,
        attribution("c0"),
      ),
    ).rejects.toThrow(/cross-provider/);
    expect(await associations()).toEqual([]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });

  it.each([
    ["a forwarded copy", attribution("c1"), reported(), {}],
    [
      "another identifier",
      attribution("c0"),
      reported(),
      { ref: "SYN-P2P-78" },
    ],
    ["another amount", attribution("c0"), reported(), { amount: -41 }],
    ["the opposite direction", attribution("c0"), reported(), { amount: 40 }],
    [
      "a purchase charge",
      attribution("c0"),
      reported(),
      { kind: "purchase" as const, amount: 40 },
    ],
  ] as const)(
    "refuses Pi's association for %s",
    async (_, decide, output, transaction) => {
      const { posted, mail, pi } = await world(transaction);
      vi.spyOn(runFeature, "runStructuredFeature").mockResolvedValue(output);
      await expect(
        resolveMail(
          ctx.db,
          resolveInput(mail, posted.output.id),
          pi,
          undefined,
          decide,
        ),
      ).rejects.toThrow(/verify|match|uniquely/);
      expect(await associations()).toEqual([]);
    },
  );

  it("records a member's explicit review without a model verdict", async () => {
    const { account, posted, mail } = await world({ ref: "SYN-UNRELATED" });
    const structured = vi.spyOn(runFeature, "runStructuredFeature");
    await resolveMail(
      ctx.db,
      {
        ...resolveInput(mail, posted.output.id),
        disposition: {
          kind: "financial",
          transactionId: posted.output.id,
          reason: "Member matched the reimbursement deposit",
          review: {
            reviewedAccountId: account.output.id,
            sourceAccountLabel: "Synthetic checking",
          },
        },
      },
      ctx.actor,
    );
    expect(structured).not.toHaveBeenCalled();
    expect(await associations()).toHaveLength(1);
  });
});
