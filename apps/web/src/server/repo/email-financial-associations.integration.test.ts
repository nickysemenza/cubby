import { parseEntityId } from "@cubby/schemas/identifiers";
import { mailFinancialAssociation } from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  emailFinancialAssociation,
  financialAccount,
  financialTransaction,
  orderMail,
} from "~/server/db/schema";
import { clearUnrelatedOriginal } from "~/server/purchase-import/gmail/persistence";
import { getDb } from "~/server/repo/database-helpers";
import {
  hasAcceptedEmailAssociation,
  readEmailAssociations,
} from "~/server/repo/email";
import { readEmailFinancialAssociations } from "~/server/repo/email-financial-associations";
import { emailReviewReport } from "~/server/repo/entity-report/email";
import { readRetainedMail } from "~/server/repo/retained-mail";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

// Persisted-read failures: target deletion erases reviewed history/protection;
// an account move rewrites the reviewed account or hides current-account drift.
describe("reviewed Email financial evidence", () => {
  const ctx = withTestDb();

  it("preserves reviewed refund history and its original after account drift and target deletion", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic financial evidence owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const identity = {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-financial-mailbox",
      messageId: "synthetic-refund-message",
    };
    const [original] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        rawChecksum: "a".repeat(64),
        content: {
          snippet: null,
          bodyText: "Synthetic refund evidence",
          bodyHtml: null,
          headers: {},
        },
      })
      .returning();
    if (!original) throw new Error("Synthetic original missing");
    const email = await insertWithShortcode(ctx.db, "email", {
      ...identity,
      orderMailId: original.id,
      checksum: original.rawChecksum,
      classification: "related",
      status: "completed",
    });
    const emailId = parseEntityId("email", email.id);
    const makeAccount = (name: string) =>
      insertWithShortcode(ctx.db, "financialAccount", {
        name,
        identity: { kind: "credit_card", issuer: null, network: "visa" },
      });
    const reviewed = await makeAccount("Synthetic reviewed card");
    const current = await makeAccount("Synthetic replacement card");
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: reviewed.id,
        kind: "refund",
        status: "posted",
        amount: -12,
        postedDate: "2026-09-03",
      },
    );
    const reviewedAt = new Date("2026-09-04T18:00:00Z");
    await getDb(ctx.db)
      .insert(emailFinancialAssociation)
      .values({
        emailId: parseEntityId("email", email.id),
        evidenceChecksum: original.rawChecksum,
        transactionId: transaction.id,
        reviewedAccountId: reviewed.id,
        sourceAccountLabel: "Synthetic card ending 1234",
        reviewReason: "Matched refund and reviewed the statement account",
        decidedByUserId: ctx.actor.userId,
        createdAt: reviewedAt,
      });
    const expected = {
      transactionId: transaction.shortcode,
      reviewedAccountId: reviewed.shortcode,
      currentAccountId: reviewed.shortcode,
      sourceAccountLabel: "Synthetic card ending 1234",
      reviewReason: "Matched refund and reviewed the statement account",
      evidenceChecksum: original.rawChecksum,
      reviewedAt: reviewedAt.toISOString(),
      transactionDeleted: false,
      reviewedAccountDeleted: false,
      accountChanged: false,
    };
    expect(await readEmailFinancialAssociations(ctx.db, emailId)).toEqual([
      expected,
    ]);
    expect(
      mailFinancialAssociation
        .array()
        .parse(await readEmailFinancialAssociations(ctx.db, emailId)),
    ).toEqual([expected]);
    expect(
      (await readEmailAssociations(ctx.db, email.shortcode, ctx.actor))
        .financialAssociations,
    ).toEqual([expected]);
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ accountId: current.id })
      .where(eq(financialTransaction.id, transaction.id));
    expect(await readEmailFinancialAssociations(ctx.db, emailId)).toEqual([
      {
        ...expected,
        currentAccountId: current.shortcode,
        accountChanged: true,
      },
    ]);
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransaction.id, transaction.id));
    await getDb(ctx.db)
      .update(financialAccount)
      .set({ deletedAt: new Date() })
      .where(eq(financialAccount.id, reviewed.id));
    expect(await readEmailFinancialAssociations(ctx.db, emailId)).toEqual([
      {
        ...expected,
        currentAccountId: null,
        accountChanged: true,
        transactionDeleted: true,
        reviewedAccountDeleted: true,
      },
    ]);
    const blocks = await emailReviewReport(
      ctx.db,
      email.shortcode,
      null,
      ctx.actor,
    );
    const rows = blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        entity: null,
        id: null,
        title: transaction.shortcode,
        at: reviewedAt.toISOString(),
        statuses: expect.arrayContaining([
          expect.objectContaining({ tone: "warning" }),
        ]),
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        entity: null,
        id: null,
        title: reviewed.shortcode,
        statuses: expect.arrayContaining([
          expect.objectContaining({ tone: "warning" }),
        ]),
      }),
    );
    expect(await hasAcceptedEmailAssociation(ctx.db, identity)).toBe(true);
    const storage = {
      put: async () => undefined,
      get: async () => new Uint8Array(),
      delete: async () => undefined,
    };
    expect(await clearUnrelatedOriginal(ctx.db, identity, storage)).toEqual({
      orderMailId: original.id,
      checksum: original.rawChecksum,
    });
    const [retained] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [party.id],
      mailboxId: identity.mailboxId,
      messageId: identity.messageId,
    });
    expect(retained?.content.bodyText).toBe("Synthetic refund evidence");
  });
});
