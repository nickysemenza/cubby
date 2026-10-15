/** An old routine flag cannot authorize deletion of immutable unpaid evidence
 * or workflow receipts; pruning must preserve the row, identity and raw history. */
import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  email as emailTable,
  emailClassificationObservation,
  emailRetrievalFailure,
  emailCandidateObservation,
  run,
  runOperation,
  aiUsage,
  runFinding,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { selectEmailEvidenceCandidate } from "./candidate-extraction";
import { pruneRoutineRuns } from "./discovery";
import { prepareEmailEvidenceCandidates } from "./evidence-candidates";
import {
  recordEmailClassificationObservation,
  recordEmailRetrievalFailure,
  recordEmailCandidateObservation,
} from "./observations";
import { syntheticRetainedMail } from "./retained-mail.fixtures";

describe("routine Gmail history retention", () => {
  const ctx = withTestDb();
  it.each([
    "rule_prediction",
    "raw_retrieval_failure",
    "candidate_preview",
    "workflow_attempt",
    "target_outcome",
  ] as const)(
    "keeps an old routine Run with unpaid %s history",
    async (kind) => {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic history member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const scope = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_discovery",
        trigger: "manual",
        status: "completed",
        routine: true,
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic history member",
        actorEmail: "history@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        input: {
          mailboxId: "synthetic-history-mailbox",
          scopedQueries: [],
          executionPolicy: "classification_only",
        },
        endedAt: new Date("2026-01-01"),
      });
      const identity = {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-history-mailbox",
        messageId: "synthetic-history-message",
      };
      const checksum = "a".repeat(64);
      if (kind === "candidate_preview")
        await syntheticRetainedMail(ctx.db, {
          ...identity,
          rawChecksum: checksum,
          content: {
            bodyText: "Synthetic retained evidence",
            bodyHtml: null,
            snippet: null,
          },
        });
      else
        await insertWithShortcode(ctx.db, "email", {
          ...identity,
          provider: "gmail",
          status: "completed",
          checksum,
        });
      const [email] = await getDb(ctx.db).select().from(emailTable);
      if (!email) throw new Error("Synthetic history Email missing");
      if (kind === "rule_prediction")
        await recordEmailClassificationObservation(ctx.db, {
          emailId: email.id,
          runId: scope.id,
          checksum,
          classification: "unrelated",
          stage: "rule",
          reason: "Synthetic deterministic promotion rule",
          classificationVersion: MAILBOX_RESEARCH_VERSION,
        });
      else if (kind === "raw_retrieval_failure")
        await recordEmailRetrievalFailure(ctx.db, {
          ...identity,
          runId: scope.id,
          httpStatus: 404,
          error: 'Gmail 404 {"error":"Synthetic missing original"}',
        });
      else if (kind === "candidate_preview") {
        await getDb(ctx.db)
          .update(emailTable)
          .set({ classification: "related" })
          .where(eq(emailTable.id, email.id));
        const source = {
          sourceKey: `gmail:${identity.mailboxId}:${identity.messageId}`,
          checksum,
          content: "Synthetic retained evidence",
        };
        const prepared = await prepareEmailEvidenceCandidates(source);
        const preview = await selectEmailEvidenceCandidate(
          prepared,
          async () => source,
          async () => {
            throw new Error("Orderless evidence cannot invoke a model");
          },
        );
        await recordEmailCandidateObservation(ctx.db, {
          emailId: email.id,
          preview: { ...preview, runId: scope.id },
        });
      } else
        await getDb(ctx.db)
          .insert(runOperation)
          .values({
            runId: scope.id,
            operationId: `synthetic:${kind}`,
            kind,
            inputFingerprint: "synthetic-history-input",
            state: "completed",
            result: { source: "synthetic-mail", disposition: "completed" },
            completedAt: new Date("2026-01-01"),
          });
      const readHistory = () => {
        if (kind === "rule_prediction")
          return getDb(ctx.db).select().from(emailClassificationObservation);
        if (kind === "raw_retrieval_failure")
          return getDb(ctx.db).select().from(emailRetrievalFailure);
        if (kind === "candidate_preview")
          return getDb(ctx.db).select().from(emailCandidateObservation);
        return getDb(ctx.db).select().from(runOperation);
      };
      const history = await readHistory();
      expect(history).toHaveLength(1);
      expect(await getDb(ctx.db).select().from(aiUsage)).toEqual([]);
      expect(await getDb(ctx.db).select().from(runFinding)).toEqual([]);
      expect(await pruneRoutineRuns(ctx.db, new Date("2026-03-01"))).toBe(0);
      expect(
        await getDb(ctx.db).select().from(run).where(eq(run.id, scope.id)),
      ).toEqual([scope]);
      expect(await readHistory()).toEqual(history);
    },
  );
});
