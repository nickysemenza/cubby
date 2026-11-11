/**
 * Failures: a settled Mail import whose every admitted Email has an outcome
 * ends in review with a false "Coordinator ended without finishing the run"
 * finding; a Run with an Email Pi resolved unresolved (an Amazon Pay notice
 * converge cannot settle) ends in review with no finding naming that Email,
 * so the member's queue never shows it; excluded Email blocks completion.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { LedgerPartyId, RunId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import { email as emailTable, run } from "~/server/db/schema";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { publishRunFinding } from "~/server/domains/run/repo/run-finding";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { runFinding } from "~/server/testing/run-finding.fixtures";

import { resolveRunFinding } from "../repo/findings";
import { settleReviewedMailRun } from "../repo/mail-run-settlement";
import * as extraction from "./agents/extract";
import { claimMailImportWork } from "./mail-import-claim";
import { resolveMail } from "./mail-tool";
import {
  mailSource,
  memberImportWorld,
  prepareMemberImport,
  retainedMailFixture,
} from "./order-import.fixtures";
import { reconcileSettledRun, stopRunForReview } from "./run-review";

const mailboxId = "synthetic-settlement-mailbox";
const generation = "00000000-0000-4000-8000-0000000000d1";

describe("Mail import settlement", () => {
  const ctx = withTestDb();

  async function unresolvedCommit(purpose: "mail_import" | "file_import") {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const first = await retain(party.id, "synthetic-first-order");
    const next = await retain(party.id, "synthetic-next-order");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose,
      trigger: "foreground",
      input: mailResearchRunInput.parse({
        kind: "mail_research",
        sources: [first, next].map((mail) => ({
          orderMailId: mail.id,
          checksum: mail.rawChecksum,
        })),
      }),
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ runId, status: "researching" })
      .where(eq(emailTable.ledgerPartyId, party.id));
    const actor = { ...ctx.actor, runId };
    await getDb(ctx.db)
      .update(run)
      .set({ agentSessionId: "synthetic-batch-agent" })
      .where(eq(run.id, runId));
    const audit = vi
      .spyOn(extraction, "auditPurchaseImportBatch")
      .mockResolvedValue({ findings: [] });
    const preparation = await prepareMemberImport(ctx.db, actor, {
      key: "synthetic-unresolved",
      orders: [
        {
          stableOrderId: "synthetic-order",
          vendorId: vendor.shortcode,
          source: mailSource(first),
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYNTHETIC-ORDER",
              merchant: vendor.name,
              orderedAt: "2026-09-20T12:00:00.000Z",
              currency: "USD",
              printedGrandTotal: 12,
              lines: [
                {
                  title: "Synthetic garden tool",
                  amount: 12,
                  lineKind: "principal",
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          resolutions: [
            {
              kind: "unresolved",
              reason: "Synthetic variant needs confirmation",
            },
          ],
        },
      ],
    });
    const committed = await preparation.commit();
    return { runId, first, next, committed, audit, preparation };
  }

  it("continues a Mail batch after an unresolved principal commit and reviews its findings at batch end", async () => {
    const { runId, next, committed, audit, preparation } =
      await unresolvedCommit("mail_import");
    expect(committed.status).toBe("running");
    expect(await preparation.commit()).toEqual(committed);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, runId)))[0],
    ).toMatchObject({ status: "running", endedAt: null });
    expect(await claimMailImportWork(ctx.db, runId)).toMatchObject({
      kind: "email",
      email: { messageId: next.messageId },
    });
    await resolveMail(
      ctx.db,
      {
        mailboxId,
        messageId: next.messageId,
        checksum: next.rawChecksum,
        disposition: {
          kind: "unrelated",
          reason: "Synthetic unrelated notice",
        },
      },
      { ...ctx.actor, runId },
    );
    expect(
      await reconcileSettledRun(ctx.db, {
        runId,
        operationId: "settled:commit-findings",
        generation: null,
      }),
    ).toMatchObject({ status: "needs_review" });
    const findings = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.runId, runId));
    expect(findings).toContainEqual(
      expect.objectContaining({ kind: "product_unresolved", status: "open" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        kind: "unresolved_targets",
        summary: expect.stringContaining("product_unresolved"),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        renderedBatch: expect.arrayContaining([
          expect.objectContaining({ orderId: "SYNTHETIC-ORDER" }),
        ]),
      }),
    );
  });

  it("keeps a member file import's unresolved principal commit terminal", async () => {
    const { runId, committed, audit } = await unresolvedCommit("file_import");
    expect(committed.status).toBe("needs_review");
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, runId)))[0],
    ).toMatchObject({ status: "needs_review", endedAt: expect.any(Date) });
    expect(audit).toHaveBeenCalled();
  });

  it.each(["review", "settlement"] as const)(
    "releases unclaimed Email when %s revisits a Run already stopped for review",
    async (path) => {
      const { party } = await memberImportWorld(ctx.db, ctx.actor);
      const mail = await retain(party.id, "synthetic-unclaimed");
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_import",
        trigger: "manual",
        input: {
          kind: "mail_research",
          sources: [{ orderMailId: mail.id, checksum: mail.rawChecksum }],
        },
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({ runId, status: "researching" })
        .where(eq(emailTable.orderMailId, mail.id));
      // A historical terminal write omitted source release; both entry points must repair it idempotently.
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "needs_review",
          endedAt: new Date(),
          agentSessionId: "synthetic-review-agent",
        })
        .where(eq(run.id, runId));
      if (path === "review")
        await stopRunForReview(ctx.db, {
          runId,
          operationId: "review:again",
          kind: "other",
          summary: "Synthetic batch review",
        });
      else
        await reconcileSettledRun(ctx.db, {
          runId,
          operationId: "settled:already-review",
          generation: null,
        });
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(emailTable)
            .where(eq(emailTable.orderMailId, mail.id))
        )[0],
      ).toMatchObject({ runId: null, status: "pending" });
    },
  );

  async function retain(partyId: LedgerPartyId, messageId: string) {
    return retainedMailFixture(ctx.db, {
      ledgerPartyId: partyId,
      mailboxId,
      messageId,
      checksum: await sha256Hex(messageId),
      sender: "notices@pay.example.test",
      content: {
        snippet: null,
        bodyText: `Synthetic notice ${messageId}`,
        bodyHtml: null,
      },
    });
  }

  async function settledRun(
    statuses: Record<
      string,
      "completed" | "excluded" | "unsettled" | "researching"
    >,
    openFinding = false,
  ) {
    const { party } = await memberImportWorld(ctx.db, ctx.actor);
    const roster: RetainedMail[] = [];
    for (const messageId of Object.keys(statuses))
      roster.push(await retain(party.id, messageId));
    const owner = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "discovery",
      dispatchEventId: generation,
      agentSessionId: "synthetic-settlement-agent",
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
    const runId = owner.id as RunId;
    const actor: ActorContext = { ...ctx.actor, runId };
    if (openFinding)
      await publishRunFinding(ctx.db, {
        runId,
        ledgerPartyId: party.id,
        entityKind: "run",
        entityId: runId,
        kind: "product_unresolved",
        summary: "Synthetic commit identity needs review",
        proposedFix: null,
        evidenceFingerprint: "synthetic-open-commit-finding",
      });
    for (const mail of roster) {
      await getDb(ctx.db)
        .update(emailTable)
        .set({ runId, status: "researching" })
        .where(eq(emailTable.orderMailId, mail.id));
      const status = statuses[mail.messageId];
      if (status === "unsettled")
        await resolveMail(
          ctx.db,
          {
            mailboxId,
            messageId: mail.messageId,
            checksum: mail.rawChecksum,
            disposition: {
              kind: "unresolved",
              category: "unknown" as const,
              reason:
                "finance.converge review_required: needs a dated, confirmed funding account",
            },
          },
          actor,
        );
      else if (status !== "researching")
        await getDb(ctx.db)
          .update(emailTable)
          .set({ status })
          .where(eq(emailTable.orderMailId, mail.id));
    }
    const outcome = await reconcileSettledRun(ctx.db, {
      runId,
      operationId: "settled:1",
      generation,
      sequence: 1,
      receivedEventIds: new Set([generation]),
    });
    const findings = await getDb(ctx.db)
      .select({ kind: runFinding.kind, summary: runFinding.summary })
      .from(runFinding)
      .where(eq(runFinding.runId, runId));
    return { outcome, findings, status: await runStatusOf(runId), runId };
  }

  async function runStatusOf(runId: RunId) {
    const [stored] = await getDb(ctx.db)
      .select({ status: run.status })
      .from(run)
      .where(eq(run.id, runId));
    return stored?.status;
  }

  it("completes a Run whose admitted Email is all imported, linked or excluded", async () => {
    const settled = await settledRun({
      "settled-imported": "completed",
      "settled-excluded": "excluded",
    });
    expect(settled).toMatchObject({
      outcome: { reconciled: true, status: "completed" },
      findings: [],
      status: "completed",
    });
  });

  it.each(["completed", "unsettled"] as const)(
    "reviews open commit findings alongside %s Emails, then completes once they are resolved",
    async (status) => {
      const settled = await settledRun(
        { "synthetic-imported": "completed", "synthetic-with-finding": status },
        true,
      );
      expect(settled.status).toBe("needs_review");
      expect(settled.findings).toContainEqual(
        expect.objectContaining({
          kind: "unresolved_targets",
          summary: expect.stringMatching(/product_unresolved/u),
        }),
      );
      const open = await getDb(ctx.db)
        .select({ id: runFinding.id })
        .from(runFinding)
        .where(eq(runFinding.runId, settled.runId));
      const statuses = [];
      for (const { id } of open) {
        await resolveRunFinding(ctx.db, { id, action: "dismiss" }, ctx.actor);
        await settleReviewedMailRun(ctx.db, id, ctx.actor.userId);
        statuses.push(await runStatusOf(settled.runId));
      }
      expect(statuses).toEqual([
        ...open.slice(1).map(() => "needs_review"),
        "completed",
      ]);
    },
  );

  it("completes a Run whose unresolved Email has a recorded outcome", async () => {
    const settled = await settledRun({
      "settled-imported": "completed",
      "payment-notice": "unsettled",
    });
    expect(settled).toMatchObject({
      outcome: { reconciled: true, status: "completed" },
      findings: [],
      status: "completed",
    });
  });

  it("keeps the unfinished-coordinator finding for Email still being researched", async () => {
    const settled = await settledRun({
      "settled-imported": "completed",
      "still-open": "researching",
    });
    expect(settled.status).toBe("needs_review");
    expect(settled.findings).toEqual([
      {
        kind: "other",
        summary: expect.stringContaining(
          "Coordinator ended without finishing the run",
        ),
      },
    ]);
  });
});
