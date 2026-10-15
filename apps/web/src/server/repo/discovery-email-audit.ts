import { aiExecutionKind } from "@cubby/schemas/ai-evaluation";
import { runEntityId, parseEntityId } from "@cubby/schemas/identifiers";
import {
  discoveryEmailReceipt,
  discoveryEmailAuditPage,
} from "@cubby/schemas/mailbox-research";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { email, emailClassificationObservation, run } from "~/server/db/schema";
import { enqueueAiEvaluation } from "~/server/repo/ai-evaluation-requests";
import { getDb } from "~/server/repo/database-helpers";

/** A handling receipt shares the durable ledger; a reused verdict does not create a prediction. */
export async function recordDiscoveryEmailReceipt(
  db: Database,
  input: {
    runId?: string;
    mailboxId: string;
    messageId: string;
    ledgerPartyId: string;
    expected?: typeof email.$inferSelect | null;
    observationId?: string | null;
    outcome?: z.infer<typeof discoveryEmailReceipt>["outcome"];
  },
) {
  if (!input.runId) return;
  const [owner] = await getDb(db)
    .select()
    .from(run)
    .where(eq(run.id, runEntityId.parse(input.runId)));
  if (owner?.purpose !== "mail_discovery") return;
  if (owner.ledgerPartyId !== input.ledgerPartyId)
    throw new Error("Discovery handling ownership changed");
  const [current] = await getDb(db)
    .select()
    .from(email)
    .where(
      and(
        eq(
          email.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(email.mailboxId, input.mailboxId),
        eq(email.messageId, input.messageId),
      ),
    );
  const handled = current ?? input.expected;
  if (!handled) return;
  if (
    handled.ledgerPartyId !== owner.ledgerPartyId ||
    handled.mailboxId !== input.mailboxId
  )
    throw new Error("Discovery receipt is outside its member/mailbox scope");
  const [observation] = input.observationId
    ? await getDb(db)
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.id, input.observationId))
    : [];
  const receipt = discoveryEmailReceipt.parse({
    id: handled.shortcode,
    emailId: handled.id,
    sourceChecksum: handled.checksum,
    handledAt: new Date().toISOString(),
    observationId: observation?.id ?? null,
    outcome:
      input.outcome ??
      (handled.status === "deleted"
        ? "removed"
        : handled.status === "excluded"
          ? "excluded"
          : observation
            ? "classified"
            : "reused"),
    classification:
      input.outcome === "changed"
        ? null
        : (observation?.classification ?? handled.classification),
    stage:
      input.outcome === "changed"
        ? null
        : (observation?.stage ?? handled.classificationStage),
    ownershipAtExecution: {
      memberId: owner.actorLedgerPartyShortcode,
      mailboxId: input.mailboxId,
    },
  });
  await enqueueAiEvaluation(db, {
    runId: owner.id,
    executionKind: "mail_discovery",
    shareKey: null,
    workKey: `discovery-handled:${owner.id}:${handled.id}:${handled.checksum ?? "missing"}:${receipt.outcome}`,
    feature: "mailbox-relevance",
    target: {
      kind: "email",
      entity: "email",
      recordId: handled.id,
      field: null,
      assessmentIds: [],
    },
    provenance: {
      dependencies: [],
      inputFingerprint: handled.checksum ?? "",
      optionFingerprint: "",
      model: observation?.model ?? null,
    },
    snapshot: {
      ledgerPartyId: input.ledgerPartyId,
      actorUserId: owner.actorUserId,
      mailboxId: input.mailboxId,
    },
    state: "completed",
    receipt,
  });
}

/** Historical observations prove only their own membership; Run/Email processing links prove none. */
export async function readDiscoveryEmailAudit(
  db: Database,
  owner: typeof run.$inferSelect,
  mailboxId: string,
  complete: boolean,
  page: { cursor: number; limit: number },
) {
  const evidence = sql`(
    SELECT item.id AS key, item.receipt AS evidence FROM "AiEvaluationRequest" AS request
      JOIN "AiEvaluation" AS item ON item.id = request."evaluationId"
      WHERE request."runId" = ${owner.id} AND item."executionKind" = ${aiExecutionKind.enum.mail_discovery} AND item.receipt IS NOT NULL
    UNION ALL
    SELECT observation.id AS key, jsonb_build_object(
      'id', original.shortcode, 'emailId', observation."emailId", 'sourceChecksum', observation.checksum,
      'handledAt', to_char(observation."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'observationId', observation.id, 'outcome', ${discoveryEmailReceipt.shape.outcome.enum.classified}::text, 'classification', observation.classification, 'stage', observation.stage,
      'ownershipAtExecution', jsonb_build_object('memberId', ${owner.actorLedgerPartyShortcode}::text, 'mailboxId', ${mailboxId}::text)
    ) AS evidence FROM "EmailClassificationObservation" AS observation JOIN "Email" AS original ON original.id = observation."emailId"
      WHERE observation."runId" = ${owner.id} AND NOT EXISTS (
        SELECT 1 FROM "AiEvaluationRequest" AS request JOIN "AiEvaluation" AS item ON item.id = request."evaluationId"
          WHERE request."runId" = ${owner.id} AND item."executionKind" = ${aiExecutionKind.enum.mail_discovery} AND item.receipt->>'observationId' = observation.id::text
      )
  ) AS audit`;
  const [counted, selected] = await Promise.all([
    getDb(db).execute(sql`SELECT count(*)::int AS count FROM ${evidence}`),
    getDb(db).execute(
      sql`SELECT evidence FROM ${evidence} ORDER BY evidence->>'handledAt', key LIMIT ${page.limit} OFFSET ${page.cursor}`,
    ),
  ]);
  const count =
    z.object({ rows: z.array(z.object({ count: z.number() })) }).parse(counted)
      .rows[0]?.count ?? 0;
  const receipts = z
    .object({ rows: z.array(z.object({ evidence: discoveryEmailReceipt })) })
    .parse(selected)
    .rows.map((row) => row.evidence);
  const current = receipts.length
    ? await getDb(db)
        .select()
        .from(email)
        .where(
          inArray(
            email.id,
            receipts.map((receipt) => receipt.emailId),
          ),
        )
    : [];
  return discoveryEmailAuditPage.parse({
    coverage: complete ? "complete" : "incomplete",
    total: count,
    nextCursor:
      page.cursor + receipts.length < count
        ? page.cursor + receipts.length
        : null,
    items: receipts.map(({ emailId, observationId, ...receipt }) => {
      const row = current.find((item) => item.id === emailId);
      const owned =
        row?.ledgerPartyId === owner.ledgerPartyId &&
        row.mailboxId === mailboxId;
      return {
        ...receipt,
        evidence: observationId ? "observation" : "receipt",
        current:
          owned && !row.deletedAt
            ? {
                classification: row.classification,
                stage: row.classificationStage,
                status: row.status,
                checksum: row.checksum,
              }
            : null,
        currentAvailability:
          !row || row.deletedAt
            ? "removed"
            : owned
              ? "available"
              : "ownership_changed",
      };
    }),
  });
}
