import {
  executionAuthorizationInput,
  executionAuthorizationRef,
} from "@cubby/schemas/execution-authorization";
import type { RunId, VendorId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import { runStatus } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import {
  readVendorMailPrerequisites,
  windowedVendorQuery,
} from "~/server/domains/purchase-import/repo/gmail/vendor-mail-scope";
import {
  assertExecutionAuthorization,
  readExecutionAuthorizationEvidence,
} from "~/server/domains/run/repo/execution-authorization";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

const WAITING_PREREQUISITE = "vendor_history_prerequisite";
const WAITING_MAILBOX = "vendor_history_mailbox_busy";
const initialProgress = {
  attempt: 0,
  phase: "listing" as const,
  pagesDone: 0,
  saved: 0,
  deleted: 0,
  excluded: 0,
  unrelated: 0,
  events: 0,
  droppedEvents: 0,
};

/** The approval is durable intent; each Vendor's discovery Run owns its lifecycle. */
export async function materializeVendorHistory(
  db: Database,
  hints: { authorizationRunId?: RunId; vendorId?: VendorId } = {},
) {
  const intents: { intentRunId: RunId; expectedGeneration: string }[] = [];
  const roots = await getDb(db)
    .select()
    .from(run)
    .where(
      and(
        notDeleted(run),
        eq(run.purpose, "background"),
        eq(run.status, "completed"),
        hints.authorizationRunId
          ? eq(run.id, hints.authorizationRunId)
          : undefined,
        hints.vendorId
          ? sql`${run.input}->'scope'->'vendors' @> ${JSON.stringify([{ vendorId: hints.vendorId }])}::jsonb`
          : undefined,
        // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- JSON keys and immutable approval discriminants, not database enum columns.
        sql`${run.input}->>'kind' = 'execution_authorization' AND ${run.input}->'scope'->>'kind' = 'vendor_backfill'`,
        sql`(${run.input}->>'expiresAt')::timestamptz > now()`,
        // includes-deleted: a generation tombstone counts as materialized and must never be recreated.
        sql`(NOT EXISTS (SELECT 1 FROM "Run" child WHERE child."parentRunId" = ${run.id}) OR EXISTS (SELECT 1 FROM "Run" child WHERE child."parentRunId" = ${run.id} AND child."deletedAt" IS NULL AND child.status = ${runStatus.enum.needs_review} AND child."failureCode" IN (${WAITING_PREREQUISITE}, ${WAITING_MAILBOX})) OR (SELECT count(*) FROM "Run" child WHERE child."parentRunId" = ${run.id}) < jsonb_array_length(${run.input}->'scope'->'vendors'))`,
      ),
    )
    .orderBy(
      sql`CASE WHEN (SELECT count(*) FROM "Run" child WHERE child."parentRunId" = ${run.id}) < jsonb_array_length(${run.input}->'scope'->'vendors') THEN 0 ELSE 1 END`,
      run.startedAt,
      run.id,
    )
    .limit(50);
  for (const root of roots) {
    const approval = executionAuthorizationInput.parse(root.input);
    if (approval.scope.kind !== "vendor_backfill") continue;
    const ref = executionAuthorizationRef.parse({
      runId: root.id,
      approvalFingerprint: await sha256Hex(JSON.stringify(approval)),
    });
    for (const selected of approval.scope.vendors) {
      if (hints.vendorId && selected.vendorId !== hints.vendorId) continue;
      const generation = `vendor-history:${root.id}:${selected.vendorId}`;
      const intent = await withTransaction(db, async (tx) => {
        // Serialize materialization against this same immutable authority.
        await tx
          .select({ id: run.id })
          .from(run)
          .where(eq(run.id, root.id))
          .for("update");
        const [existing] = await tx
          .select()
          .from(run)
          .where(eq(run.clientKey, generation));
        if (existing) return existing;
        return insertWithShortcode(tx, "run", {
          purpose: "mail_discovery",
          trigger: "backfill",
          status: "needs_review",
          clientKey: generation,
          parentRunId: root.id,
          vendorId: selected.vendorId,
          ledgerPartyId: root.ledgerPartyId,
          actorUserId: root.actorUserId,
          actorName: root.actorName,
          actorEmail: root.actorEmail,
          actorLedgerPartyShortcode: root.actorLedgerPartyShortcode,
          actorLedgerPartyName: root.actorLedgerPartyName,
          actorLedgerPartyKind: root.actorLedgerPartyKind,
          channel: root.channel,
          failureCode: WAITING_PREREQUISITE,
          input: {
            emailAuditVersion: 1,
            executionAuthorization: ref,
            executionPolicy: "import",
            mailboxId: approval.scope.mailboxId,
            scopedQueries: [],
            vendorHistory: { generation, resolvedAt: null },
          },
          progress: initialProgress,
        });
      });
      intents.push({ intentRunId: intent.id, expectedGeneration: generation });
    }
    const waiting = await getDb(db)
      .select({ id: run.id, clientKey: run.clientKey, vendorId: run.vendorId })
      .from(run)
      .where(
        and(
          eq(run.parentRunId, root.id),
          notDeleted(run),
          eq(run.status, "needs_review"),
          inArray(run.failureCode, [WAITING_PREREQUISITE, WAITING_MAILBOX]),
          hints.vendorId ? eq(run.vendorId, hints.vendorId) : undefined,
        ),
      );
    for (const continuation of waiting)
      if (
        continuation.clientKey &&
        approval.scope.vendors.some(
          (selected) => selected.vendorId === continuation.vendorId,
        )
      )
        intents.push({
          intentRunId: continuation.id,
          expectedGeneration: continuation.clientKey,
        });
  }
  return [
    ...new Map(intents.map((intent) => [intent.intentRunId, intent])).values(),
  ];
}

/** Wakes are hints. This writer rechecks scope and pause before freezing queries. */
export async function prepareAuthorizedVendorMail(
  db: Database,
  input: { intentRunId: RunId; expectedGeneration: string },
) {
  const [observed] = await getDb(db)
    .select()
    .from(run)
    .where(and(eq(run.id, input.intentRunId), notDeleted(run)));
  const parsed = mailboxDiscoveryInput.safeParse(observed?.input);
  if (
    !observed?.vendorId ||
    !parsed.success ||
    parsed.data.vendorHistory?.generation !== input.expectedGeneration
  )
    return { status: "refused" as const, reason: "stale_generation" };
  const ref = parsed.data.executionAuthorization;
  if (!ref || !observed.ledgerPartyId)
    return { status: "refused" as const, reason: "approval_missing" };
  try {
    const started = await withTransaction(db, async (tx) => {
      const database = databaseForTransaction(tx);
      const approval = await assertExecutionAuthorization(
        database,
        {
          ref,
          owner: {
            userId: observed.actorUserId,
            ledgerPartyId: observed.ledgerPartyId!,
          },
          requestedScope: {
            mailboxId: parsed.data.mailboxId,
            discovery: "vendor_history",
            vendorIds: [observed.vendorId!],
          },
        },
        { minimumBudgetMicroUSD: 1 },
      );
      if (approval.scope.kind !== "vendor_backfill")
        throw new Error("Vendor history requires its own approval.");
      const approvedScope = approval.scope;
      const evidence = await readExecutionAuthorizationEvidence(
        database,
        ref,
        approval.owner,
      );
      const candidates = new Set(
        evidence.receipts.flatMap((receipt) =>
          receipt.kind === "claim" && receipt.claim.kind === "candidate"
            ? [JSON.stringify(receipt.claim)]
            : [],
        ),
      );
      if (candidates.size >= approval.scope.candidateLimit)
        throw new Error("Vendor history candidate allowance is exhausted.");
      const [current] = await tx
        .select()
        .from(run)
        .where(and(eq(run.id, observed.id), notDeleted(run)))
        .for("update");
      if (
        !current ||
        current.clientKey !== input.expectedGeneration ||
        current.status !== "needs_review" ||
        ![WAITING_PREREQUISITE, WAITING_MAILBOX].includes(
          current.failureCode ?? "",
        )
      )
        return null;
      const currentInput = mailboxDiscoveryInput.parse(current.input);
      if (
        !currentInput.vendorHistory ||
        currentInput.vendorHistory.generation !== input.expectedGeneration
      )
        return null;
      if (
        current.vendorId !== observed.vendorId ||
        current.actorUserId !== observed.actorUserId ||
        current.ledgerPartyId !== observed.ledgerPartyId ||
        current.parentRunId !== ref.runId ||
        currentInput.mailboxId !== parsed.data.mailboxId ||
        currentInput.executionAuthorization?.runId !== ref.runId ||
        currentInput.executionAuthorization.approvalFingerprint !==
          ref.approvalFingerprint
      )
        return null;
      const [prerequisite] = await readVendorMailPrerequisites(database, [
        observed.vendorId!,
      ]);
      if (
        !currentInput.vendorHistory.resolvedAt &&
        (!prerequisite || prerequisite.blockers.length)
      )
        return null;
      const queries = currentInput.vendorHistory.resolvedAt
        ? currentInput.scopedQueries
        : prerequisite!.queries.map((query) =>
            windowedVendorQuery(query, approvedScope),
          );
      if (queries.length < 1 || queries.length > 20)
        throw new Error(
          "Vendor history requires between one and twenty verified sender queries.",
        );
      await tx
        .update(run)
        .set({
          status: "running",
          failureCode: null,
          dispatchError: null,
          endedAt: null,
          input: {
            ...currentInput,
            scopedQueries: queries,
            vendorHistory: {
              ...currentInput.vendorHistory,
              resolvedAt:
                currentInput.vendorHistory.resolvedAt ??
                new Date().toISOString(),
            },
          },
        })
        .where(eq(run.id, current.id));
      return current.id;
    });
    if (!started)
      return { status: "refused" as const, reason: "vendor_blocked" };
    return {
      status: "started" as const,
      runId: started,
      executionAuthorization: ref,
    };
  } catch (error) {
    const busy = isUniqueViolation(error, "Run_one_active_mail_discovery");
    await getDb(db)
      .update(run)
      .set({
        failureCode: busy ? WAITING_MAILBOX : "vendor_history_authorization",
        dispatchError: runFailureText(
          error instanceof Error ? error : String(error),
        ),
      })
      .where(and(eq(run.id, observed.id), eq(run.status, "needs_review")));
    return {
      status: "refused" as const,
      reason: busy ? "discovery_running" : "approval_revoked_or_expired",
    };
  }
}
