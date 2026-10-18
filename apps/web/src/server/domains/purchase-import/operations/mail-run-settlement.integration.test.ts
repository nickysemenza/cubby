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
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { email as emailTable, run, runFinding } from "~/server/db/schema";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { resolveMail } from "./mail-tool";
import {
  memberImportWorld,
  retainedMailFixture,
} from "./order-import.fixtures";
import { reconcileSettledRun } from "./run-review";

const mailboxId = "synthetic-settlement-mailbox";
const generation = "00000000-0000-4000-8000-0000000000d1";

describe("Mail import settlement", () => {
  const ctx = withTestDb();

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
      "completed" | "excluded" | "blocked" | "researching"
    >,
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
    for (const mail of roster) {
      await getDb(ctx.db)
        .update(emailTable)
        .set({ runId, status: "researching" })
        .where(eq(emailTable.orderMailId, mail.id));
      const status = statuses[mail.messageId];
      if (status === "blocked")
        await resolveMail(
          ctx.db,
          {
            mailboxId,
            messageId: mail.messageId,
            checksum: mail.rawChecksum,
            disposition: {
              kind: "unresolved",
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
    const [stored] = await getDb(ctx.db)
      .select({ status: run.status })
      .from(run)
      .where(eq(run.id, runId));
    return { outcome, findings, status: stored?.status };
  }

  it("completes a Run whose admitted Email is all imported, linked or excluded", async () => {
    const settled = await settledRun({
      "settled-imported": "completed",
      "settled-excluded": "excluded",
    });
    expect(settled).toEqual({
      outcome: { reconciled: true, status: "completed" },
      findings: [],
      status: "completed",
    });
  });

  it("reviews a settled Run with an unresolved Email under a finding naming it and its reason", async () => {
    const settled = await settledRun({
      "settled-imported": "completed",
      "payment-notice": "blocked",
    });
    expect(settled.status).toBe("needs_review");
    expect(settled.findings).toEqual([
      {
        kind: "unresolved_targets",
        summary: expect.stringMatching(
          /payment-notice.*needs a dated, confirmed funding account/su,
        ),
      },
    ]);
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
