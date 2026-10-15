import { userId } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryInput,
  MAILBOX_RESEARCH_VERSION,
} from "@cubby/schemas/mailbox-research";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  email,
  run,
} from "~/server/db/schema";
import { recordDeletedHistoryEvent } from "~/server/domains/purchase-import/operations/gmail/discovery";
import { originalChecksum } from "~/server/domains/purchase-import/repo/gmail/checksum";
import { normalizeMessage } from "~/server/domains/purchase-import/repo/gmail/normalize";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { ingestGmailMessages } from "~/server/domains/purchase-import/service/gmail/ingest";
import { loadMailDiscoveryRead } from "~/server/domains/run/repo/run-discovery-read";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

// Reused verdicts need membership in every handling Run; later Email writes cannot rewrite those outcomes.
// Audit reads must page stored evidence, expose historical gaps, and refuse a foreign member.
const ctx = withTestDb();
it("retains reused discovery decisions per Run alongside current state without inference", async () => {
  const party = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic discovery owner",
    kind: "member",
    userId: ctx.actor.userId,
  });
  const mailboxId = "synthetic-audit-mailbox";
  const message = {
    id: "synthetic-audit-message",
    threadId: "synthetic-audit-thread",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "news@example.invalid" }],
      body: { data: Buffer.from("Synthetic newsletter").toString("base64url") },
    },
  };
  const checksum = await originalChecksum(normalizeMessage(mailboxId, message));
  const selected = await insertWithShortcode(ctx.db, "email", {
    ledgerPartyId: party.id,
    mailboxId,
    messageId: message.id,
    checksum,
    classification: "unrelated",
    classificationStage: "rule",
    classificationReason: "Synthetic newsletter rule",
    classificationVersion: MAILBOX_RESEARCH_VERSION,
    executionPolicy: "classification_only",
    status: "completed",
  });
  const frozen = await insertWithShortcode(ctx.db, "email", {
    ledgerPartyId: party.id,
    mailboxId,
    messageId: "synthetic-historical-message",
    checksum: "synthetic-historical-checksum",
    classification: "uncertain",
    classificationStage: "rule",
    classificationVersion: HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
    executionPolicy: "classification_only",
    status: "blocked",
  });
  const owners = [];
  for (let index = 0; index < 2; index++) {
    const owner = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic owner",
      actorEmail: "synthetic@example.invalid",
      actorLedgerPartyShortcode: party.shortcode,
      ledgerPartyId: party.id,
      input: mailboxDiscoveryInput.parse({
        mailboxId,
        scopedQueries: [],
        executionPolicy: "classification_only",
        emailAuditVersion: 1,
      }),
    });
    owners.push(owner);
    await ingestGmailMessages(
      ctx.db,
      {
        getMessage: async (id) => {
          expect(id).toBe(message.id);
          return message;
        },
        getAttachment: async () => ({}),
        listMessages: async () => ({}),
        listHistory: async () => ({}),
        getProfile: async () => ({ historyId: "1" }),
      },
      {
        ledgerPartyId: party.id,
        mailboxId,
        messageIds: [frozen.messageId, message.id],
        runId: owner.id,
        triage: async () => {
          throw new Error("Reused evidence must not invoke a model");
        },
      },
    );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, owner.id));
  }
  await getDb(ctx.db)
    .update(email)
    .set({
      classification: "related",
      classificationStage: "resolution",
      classificationReason: "Synthetic later member decision",
    })
    .where(eq(email.id, selected.id));
  for (const owner of owners) {
    const ownerRef = { userId: ctx.actor.userId, ledgerPartyId: party.id };
    const read = await loadMailDiscoveryRead(
      ctx.db,
      owner.shortcode,
      ownerRef,
      { cursor: 0, limit: 1 },
    );
    expect(read?.emails).toMatchObject({
      coverage: "complete",
      total: 2,
      nextCursor: 1,
    });
    const next = await loadMailDiscoveryRead(
      ctx.db,
      owner.shortcode,
      ownerRef,
      { cursor: 1, limit: 1 },
    );
    expect(next?.emails.nextCursor).toBeNull();
    const items = [...read!.emails.items, ...next!.emails.items];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: selected.shortcode,
          outcome: "reused",
          classification: "unrelated",
          ownershipAtExecution: { memberId: party.shortcode, mailboxId },
          current: expect.objectContaining({
            classification: "related",
            stage: "resolution",
          }),
        }),
        expect.objectContaining({
          id: frozen.shortcode,
          outcome: "frozen",
          classification: "uncertain",
        }),
      ]),
    );
    expect(JSON.stringify(items)).not.toContain(selected.id);
    expect(JSON.stringify(items)).not.toContain(frozen.id);
  }
  await expect(
    loadMailDiscoveryRead(ctx.db, owners[0]!.shortcode, {
      userId: userId.parse("synthetic-foreign"),
      ledgerPartyId: party.id,
    }),
  ).rejects.toThrow("does not belong");
});

it("records exact deleted history handling without inventing an Email, and preserves frozen skips", async () => {
  const party = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic deletion owner",
    kind: "member",
    userId: ctx.actor.userId,
  });
  const mailboxId = "synthetic-deletion-mailbox";
  const owner = await insertWithShortcode(ctx.db, "run", {
    purpose: "mail_discovery",
    trigger: "manual",
    status: "running",
    actorUserId: ctx.actor.userId,
    actorName: "Synthetic owner",
    actorEmail: "synthetic@example.invalid",
    actorLedgerPartyShortcode: party.shortcode,
    ledgerPartyId: party.id,
    input: mailboxDiscoveryInput.parse({
      mailboxId,
      scopedQueries: [],
      executionPolicy: "classification_only",
      emailAuditVersion: 1,
    }),
  });
  const current = await insertWithShortcode(ctx.db, "email", {
    ledgerPartyId: party.id,
    mailboxId,
    messageId: "synthetic-existing-deletion",
    checksum: "a".repeat(64),
    classification: "related",
    classificationStage: "rule",
    classificationVersion: MAILBOX_RESEARCH_VERSION,
    executionPolicy: "classification_only",
    status: "completed",
  });
  const frozen = await insertWithShortcode(ctx.db, "email", {
    ledgerPartyId: party.id,
    mailboxId,
    messageId: "synthetic-frozen-deletion",
    checksum: "b".repeat(64),
    classification: "uncertain",
    classificationStage: "rule",
    classificationVersion: HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
    executionPolicy: "classification_only",
    status: "blocked",
  });
  for (const messageId of [
    current.messageId,
    frozen.messageId,
    "synthetic-never-saved",
  ])
    await recordDeletedHistoryEvent(ctx.db, {
      runId: owner.id,
      ledgerPartyId: party.id,
      mailboxId,
      messageId,
    });

  const rows = await getDb(ctx.db)
    .select()
    .from(email)
    .where(eq(email.mailboxId, mailboxId));
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === current.id)?.status).toBe("deleted");
  expect(rows.find((row) => row.id === frozen.id)?.status).toBe("blocked");
  const read = await loadMailDiscoveryRead(ctx.db, owner.shortcode, {
    userId: ctx.actor.userId,
    ledgerPartyId: party.id,
  });
  expect(read?.emails.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: current.shortcode, outcome: "removed" }),
      expect.objectContaining({ id: frozen.shortcode, outcome: "frozen" }),
    ]),
  );
  expect(read?.emails.total).toBe(2);
});

it("does not count candidate extraction publication as another handled Email", async () => {
  const party = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic preview owner",
    kind: "member",
    userId: ctx.actor.userId,
  });
  const mailboxId = "synthetic-preview-mailbox";
  const owner = await insertWithShortcode(ctx.db, "run", {
    purpose: "mail_discovery",
    trigger: "manual",
    status: "running",
    actorUserId: ctx.actor.userId,
    actorName: "Synthetic owner",
    actorEmail: "synthetic@example.invalid",
    actorLedgerPartyShortcode: party.shortcode,
    ledgerPartyId: party.id,
    input: mailboxDiscoveryInput.parse({
      mailboxId,
      scopedQueries: [],
      executionPolicy: "classification_only",
      emailAuditVersion: 1,
    }),
  });
  const message = {
    id: "synthetic-preview-message",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "From", value: "shop@example.invalid" }],
      body: {
        data: Buffer.from(
          '<script type="application/ld+json">{"@type":"Order","orderNumber":"SYNTHETIC-ORDER","seller":{"name":"Synthetic shop"},"priceCurrency":"USD","price":"8.00","orderedItem":{"name":"Synthetic basil","offers":{"price":"8.00","priceCurrency":"USD"}}}</script>',
        ).toString("base64url"),
      },
    },
  };
  const { ingestGmailMessages } =
    await import("~/server/domains/purchase-import/service/gmail/ingest");
  await ingestGmailMessages(
    ctx.db,
    {
      getMessage: async () => message,
      getAttachment: async () => ({}),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
      getProfile: async () => ({ historyId: "1" }),
    },
    {
      ledgerPartyId: party.id,
      mailboxId,
      messageIds: [message.id],
      runId: owner.id,
      triage: async () => "related",
      candidateChoice: async () => ({
        selectedIndex: 0,
        confidence: "high",
        probability: 0.95,
      }),
    },
  );
  const requests = await getDb(ctx.db)
    .select({ receipt: aiEvaluation.receipt })
    .from(aiEvaluationRequest)
    .innerJoin(
      aiEvaluation,
      eq(aiEvaluation.id, aiEvaluationRequest.evaluationId),
    )
    .where(
      and(
        eq(aiEvaluationRequest.runId, owner.id),
        eq(aiEvaluation.executionKind, "mail_discovery"),
      ),
    );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.receipt).toMatchObject({ outcome: "classified" });
});
