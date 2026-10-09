import {
  executionAuthorizationRef,
  executionAuthorizationInput,
  type ExecutionAuthorizationRef,
  type ExecutionAuthorizationOwner,
  type ExecutionAuthorizationRequest,
  type ExecutionAuthorizationClaim,
  type ExecutionAuthorizationInput,
} from "@cubby/schemas/execution-authorization";
import type { RunId } from "@cubby/schemas/identifiers";
import type { RunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  run,
  orderMail,
  importSourceClaim,
  researchRetention,
} from "~/server/db/schema";
import {
  unwrapDb,
  notDeleted,
  databaseForTransaction,
} from "~/server/repo/database-helpers";

import {
  assertExecutionAuthorization,
  claimExecutionAuthorization,
} from "./execution-authorization";

const executionContext = z.object({
  executionAuthorization: executionAuthorizationRef.optional(),
});

export class ExecutionLimitError extends Error {
  constructor(readonly reason: "candidate_limit" | "product_limit") {
    super(`Execution allowance refused: ${reason}.`);
    this.name = "ExecutionLimitError";
  }
}

export async function pauseExecutionRun(
  db: Database,
  runId: RunId,
  message: string,
): Promise<void> {
  await unwrapDb(db)
    .update(run)
    .set({
      status: "needs_review",
      endedAt: new Date(),
      failureCode: "execution_limit",
      dispatchError: message,
    })
    .where(and(eq(run.id, runId), eq(run.status, "running"), notDeleted(run)));
}

/** Explicit pilot bounds apply to free research as well as metered decisions. */
export async function claimRunExecution(
  db: Database,
  runId: RunId,
  claim: ExecutionAuthorizationClaim,
): Promise<void> {
  const authority = await executionRequestForRun(db, runId, {
    requireRunning: true,
  });
  if (!authority) return;
  const result = await claimExecutionAuthorization(db, { ...authority, claim });
  if (result.status !== "refused") return;
  const error = new ExecutionLimitError(result.reason);
  await pauseExecutionRun(db, runId, error.message);
  throw error;
}

export function executionAuthorizationFromInput(
  input: unknown,
): ExecutionAuthorizationRef | undefined {
  return executionContext.nullish().parse(input)?.executionAuthorization;
}

/** Existing inherited authority wins; new mail-backed work shares its owned backfill bucket. */
export async function bindRetainedMailBackfill<T extends RunInput>(
  tx: DrizzleTransaction,
  input: T,
  owner: ExecutionAuthorizationOwner,
  sourceGroups: readonly (readonly Pick<
    typeof importSourceClaim.$inferSelect,
    "externalKey" | "checksum"
  >[])[],
): Promise<T> {
  if (
    executionAuthorizationFromInput(input) ||
    !sourceGroups.length ||
    sourceGroups.some((group) => !group.length)
  )
    return input;
  const mailboxes = await tx
    .selectDistinct({ id: account.accountId })
    .from(account)
    .where(
      and(eq(account.userId, owner.userId), eq(account.providerId, "google")),
    );
  const [mailbox] = mailboxes;
  if (mailboxes.length !== 1 || !mailbox) return input;
  const sourceKeys = sourceGroups.flatMap((group) =>
    group.map((source) => source.externalKey),
  );
  const historicalMessages = new Map(
    sourceKeys.flatMap((key) => {
      const messageId = /^gmail:([^:]+):order:.+$/u.exec(key)?.[1];
      return messageId ? [[key, messageId] as const] : [];
    }),
  );
  const originals = await tx
    .select({
      messageId: orderMail.messageId,
      checksum: orderMail.rawChecksum,
    })
    .from(orderMail)
    .leftJoin(
      researchRetention,
      and(
        eq(researchRetention.ledgerPartyId, orderMail.ledgerPartyId),
        eq(researchRetention.orderMailId, orderMail.id),
        eq(researchRetention.checksum, orderMail.rawChecksum),
      ),
    )
    .where(
      and(
        eq(orderMail.ledgerPartyId, owner.ledgerPartyId),
        eq(orderMail.mailboxId, mailbox.id),
        isNull(researchRetention.id),
        // Cleanup preserves identity/checksum tombstones; only readable content
        // outside a retirement fence can establish a retained original.
        sql`COALESCE(
          NULLIF(BTRIM(${orderMail.content}->>'bodyText'), ''),
          NULLIF(BTRIM(${orderMail.content}->>'bodyHtml'), ''),
          NULLIF(BTRIM(${orderMail.content}->>'snippet'), '')
        ) IS NOT NULL`,
        or(
          inArray(
            sql<string>`'gmail:' || ${orderMail.mailboxId} || ':' || ${orderMail.messageId}`,
            sourceKeys,
          ),
          historicalMessages.size
            ? inArray(orderMail.messageId, [...historicalMessages.values()])
            : undefined,
        ),
      ),
    );
  if (
    !sourceGroups.every((group) =>
      group.some((source) =>
        originals.some((original) => {
          // Old per-order claims hash derived order data, not raw mail. This
          // proves budget ownership only; it never revalidates their claims
          // or makes their historical source identity writable.
          if (historicalMessages.get(source.externalKey) === original.messageId)
            return !!original.checksum;
          return (
            source.externalKey ===
              `gmail:${mailbox.id}:${original.messageId}` &&
            source.checksum === original.checksum
          );
        }),
      ),
    )
  )
    return input;
  const authorization = await latestExecutionAuthorization(
    databaseForTransaction(tx),
    owner,
    mailbox.id,
    "backfill",
  );
  return authorization
    ? { ...input, executionAuthorization: authorization }
    : input;
}

/** The latest approval in this scope is authoritative, including invalid dispositions. */
export async function latestExecutionAuthorization(
  db: Database,
  owner: ExecutionAuthorizationOwner,
  mailboxId: string,
  scopeKind: ExecutionAuthorizationInput["scope"]["kind"],
): Promise<ExecutionAuthorizationRef | undefined> {
  const [root] = await unwrapDb(db)
    .select()
    .from(run)
    .where(
      and(
        eq(run.actorUserId, owner.userId),
        eq(run.ledgerPartyId, owner.ledgerPartyId),
        // includes-deleted: the newest revoked, deleted or invalid approval
        // must block its own scope instead of reviving an older allowance.
        sql`${run.input}->>'kind' = 'execution_authorization'`,
        sql`${run.input}->'scope'->>'mailboxId' = ${mailboxId}`,
        sql`${run.input}->'scope'->>'kind' = ${scopeKind}`,
      ),
    )
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(1);
  if (!root) return undefined;
  const parsed = executionAuthorizationInput.safeParse(root.input);
  if (!parsed.success)
    throw new Error(
      `Execution approval snapshot is unknown: ${parsed.error.message}`,
    );
  const ref: ExecutionAuthorizationRef = {
    runId: root.id,
    approvalFingerprint: await sha256Hex(JSON.stringify(parsed.data)),
  };
  await assertExecutionAuthorization(db, {
    ref,
    owner,
    requestedScope: { mailboxId, discovery: parsed.data.scope.discovery },
  });
  return ref;
}

/** The host binds paid work to its own Run, owner and immutable approval scope. */
export async function executionRequestForRun(
  db: Database,
  runId: RunId,
  options: { requireRunning?: boolean } = {},
): Promise<ExecutionAuthorizationRequest | undefined> {
  const [scope] = await unwrapDb(db)
    .select()
    .from(run)
    .where(and(eq(run.id, runId), notDeleted(run)))
    .limit(1);
  if (!scope || scope.retiredAt)
    throw new Error("Execution authorization Run is no longer available.");
  if (options.requireRunning && scope.status !== "running")
    throw new Error("Execution authorization Run is no longer executable.");
  const ref = executionAuthorizationFromInput(scope.input);
  if (!ref) return undefined;
  if (!scope.ledgerPartyId)
    throw new Error("Execution authorization Run has no member owner.");
  const [root] = await unwrapDb(db)
    .select({ input: run.input })
    .from(run)
    .where(eq(run.id, ref.runId))
    .limit(1);
  const approval = executionAuthorizationInput.parse(root?.input);
  return {
    ref,
    owner: { userId: scope.actorUserId, ledgerPartyId: scope.ledgerPartyId },
    requestedScope: {
      mailboxId: approval.scope.mailboxId,
      discovery: approval.scope.discovery,
    },
  };
}

/** A scheduled retry cannot reset a stopped lifetime or current-month allowance. */
export async function executionAuthorizationPaused(
  db: Database,
  ref: ExecutionAuthorizationRef,
  purpose: typeof run.$inferSelect.purpose,
  now = new Date(),
): Promise<boolean> {
  const [root] = await unwrapDb(db)
    .select({ input: run.input })
    .from(run)
    .where(eq(run.id, ref.runId))
    .limit(1);
  const approval = executionAuthorizationInput.parse(root?.input);
  const [stopped] = await unwrapDb(db)
    .select({ endedAt: run.endedAt })
    .from(run)
    .where(
      and(
        eq(run.actorUserId, approval.owner.userId),
        eq(run.ledgerPartyId, approval.owner.ledgerPartyId),
        eq(run.purpose, purpose),
        eq(run.status, "needs_review"),
        eq(run.failureCode, "execution_limit"),
        notDeleted(run),
        sql`${run.input}->'executionAuthorization'->>'runId' = ${ref.runId}`,
        sql`${run.input}->'executionAuthorization'->>'approvalFingerprint' = ${ref.approvalFingerprint}`,
      ),
    )
    .orderBy(desc(run.endedAt), desc(run.id))
    .limit(1);
  if (!stopped) return false;
  if (approval.meteredBudget.period === "lifetime" || !stopped.endedAt)
    return true;
  return (
    stopped.endedAt.toISOString().slice(0, 7) === now.toISOString().slice(0, 7)
  );
}

/** Copy authority separately from causal lineage; a retry cannot mint a new allowance. */
export async function inheritExecutionAuthorization(
  db: Database | DrizzleTransaction,
  input: RunInput | undefined,
  lineage: { parentRunId?: RunId | null; predecessorRunId?: RunId | null },
): Promise<RunInput | undefined> {
  let authorization = executionAuthorizationFromInput(input);
  for (const id of [lineage.predecessorRunId, lineage.parentRunId]) {
    if (!id) continue;
    const [source] = await unwrapDb(db)
      .select({ input: run.input })
      .from(run)
      .where(and(eq(run.id, id), notDeleted(run)))
      .limit(1);
    const inherited = executionAuthorizationFromInput(source?.input);
    if (!inherited) continue;
    if (
      authorization &&
      (authorization.runId !== inherited.runId ||
        authorization.approvalFingerprint !== inherited.approvalFingerprint)
    )
      throw new Error(
        "Research lineage cannot change its execution authorization.",
      );
    authorization = inherited;
  }
  if (!authorization) return input;
  if (!input || ("kind" in input && input.kind === "execution_authorization"))
    throw new Error("Execution authorization requires a typed research input.");
  return { ...input, executionAuthorization: authorization };
}
