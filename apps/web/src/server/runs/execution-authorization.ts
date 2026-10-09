import type { ActorContext } from "@cubby/schemas/context";
import {
  executionAuthorizationClaimRequest,
  executionAuthorizationInput,
  executionAuthorizationReceipt,
  executionAuthorizationRef,
  executionAuthorizationRequest,
  executionAuthorizationReservation,
  type ExecutionAuthorizationClaimRequest,
  type ExecutionAuthorizationInput,
  type ExecutionAuthorizationOwner,
  type ExecutionAuthorizationReceipt,
  type ExecutionAuthorizationRef,
  type ExecutionAuthorizationRequest,
  type ExecutionAuthorizationReservation,
} from "@cubby/schemas/execution-authorization";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  ledgerParty,
  product,
  run,
  runOperation,
  user,
} from "~/server/db/schema";
import {
  getDb,
  isTransaction,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertOperation } from "~/server/repo/run-operation";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/** Every receipt is completed and immutable; no leased job authorizes transport. */
export const EXECUTION_AUTHORIZATION_RECEIPT_KIND = "execution_authorization";

type Clock = { now?: Date };
type ReservationDecision =
  | { status: "reserved" }
  | {
      status: "refused";
      reason: "budget_exhausted" | "attempt_already_reserved";
    };
type ClaimDecision =
  | { status: "claimed" | "already_claimed" }
  | {
      status: "refused";
      reason: "candidate_limit" | "product_limit";
    };

function durableConnection(db: Database) {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Execution authorization requires its own durable transaction, not a savepoint-bound handle.",
    );
}

function instant(clock: Clock) {
  const now = clock.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new Error("Execution authorization clock is unavailable.");
  return now;
}

async function liveOwner(
  tx: DrizzleTransaction,
  owner: ExecutionAuthorizationOwner,
) {
  const [member] = await tx
    .select({
      id: ledgerParty.id,
      name: ledgerParty.name,
      shortcode: ledgerParty.shortcode,
      userName: user.name,
      email: user.email,
    })
    .from(ledgerParty)
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(
      and(
        eq(ledgerParty.id, owner.ledgerPartyId),
        eq(ledgerParty.userId, owner.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    );
  if (!member)
    throw new Error("Execution authorization owner is not a live member.");
  return member;
}

async function liveMailbox(
  tx: DrizzleTransaction,
  approval: ExecutionAuthorizationInput,
) {
  const [mailbox] = await tx
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, approval.owner.userId),
        eq(account.providerId, "google"),
        eq(account.accountId, approval.scope.mailboxId),
      ),
    )
    .limit(1);
  if (!mailbox)
    throw new Error(
      "Execution approval mailbox is no longer connected to its owner.",
    );
}

const snapshotFingerprint = (input: ExecutionAuthorizationInput) =>
  sha256Hex(JSON.stringify(executionAuthorizationInput.parse(input)));

async function lockApproval(
  tx: DrizzleTransaction,
  ref: ExecutionAuthorizationRef,
  owner: ExecutionAuthorizationOwner,
) {
  const [root] = await tx
    .select()
    .from(run)
    .where(eq(run.id, ref.runId))
    .for("update");
  if (
    !root ||
    root.deletedAt ||
    root.retiredAt ||
    root.status !== "completed" ||
    root.purpose !== "background" ||
    root.parentRunId ||
    root.predecessorRunId
  )
    throw new Error(
      "Execution authorization must name a live completed approval root.",
    );
  const parsed = executionAuthorizationInput.safeParse(root.input);
  if (!parsed.success)
    throw new Error(
      `Execution approval snapshot is unknown: ${parsed.error.message}`,
    );
  const approval = parsed.data;
  if (
    root.actorUserId !== owner.userId ||
    root.ledgerPartyId !== owner.ledgerPartyId ||
    approval.owner.userId !== owner.userId ||
    approval.owner.ledgerPartyId !== owner.ledgerPartyId
  )
    throw new Error("Execution authorization does not belong to this owner.");
  if ((await snapshotFingerprint(approval)) !== ref.approvalFingerprint)
    throw new Error(
      "Execution approval snapshot changed; a fresh explicit approval is required.",
    );
  await liveOwner(tx, owner);
  return approval;
}

/** Operational allowance buckets deliberately follow the UTC calendar. */
const periodKey = (approval: ExecutionAuthorizationInput, now: Date) =>
  approval.meteredBudget.period === "lifetime"
    ? "lifetime"
    : now.toISOString().slice(0, 7);

async function receiptsFor(
  tx: DrizzleTransaction,
  ref: ExecutionAuthorizationRef,
  approval: ExecutionAuthorizationInput,
) {
  const rows = await tx
    .select()
    .from(runOperation)
    .where(eq(runOperation.runId, ref.runId));
  const receipts: ExecutionAuthorizationReceipt[] = [];
  for (const row of rows) {
    const parsed = executionAuthorizationReceipt.safeParse(row.result);
    if (
      row.kind !== EXECUTION_AUTHORIZATION_RECEIPT_KIND ||
      row.state !== "completed" ||
      !row.completedAt ||
      !parsed.success
    )
      throw new Error(
        "Execution authorization receipt is malformed, unknown or not completed.",
      );
    const receipt = parsed.data;
    if (
      receipt.approvalFingerprint !== ref.approvalFingerprint ||
      row.inputFingerprint !== (await sha256Hex(JSON.stringify(receipt)))
    )
      throw new Error(
        "Execution authorization receipt does not match its immutable snapshot.",
      );
    if (
      receipt.kind === "metered_reservation" &&
      (receipt.requestedScope.mailboxId !== approval.scope.mailboxId ||
        receipt.requestedScope.discovery !== approval.scope.discovery ||
        receipt.periodKey !== periodKey(approval, new Date(receipt.reservedAt)))
    )
      throw new Error(
        "Execution authorization receipt has an invalid scope or allowance bucket.",
      );
    if (
      receipt.kind === "claim" &&
      receipt.claim.kind === "candidate" &&
      receipt.claim.mailboxId !== approval.scope.mailboxId
    )
      throw new Error(
        "Execution authorization candidate receipt belongs to another mailbox.",
      );
    receipts.push(receipt);
  }
  return receipts;
}

async function writeReceipt(
  tx: DrizzleTransaction,
  ref: ExecutionAuthorizationRef,
  operationId: string,
  receipt: ExecutionAuthorizationReceipt,
) {
  await insertOperation(tx, {
    runId: ref.runId,
    operationId,
    kind: EXECUTION_AUTHORIZATION_RECEIPT_KIND,
    state: "completed",
    inputFingerprint: await sha256Hex(JSON.stringify(receipt)),
    result: receipt,
  });
}

async function authorized<T>(
  db: Database,
  request: ExecutionAuthorizationRequest,
  now: Date,
  use: (
    tx: DrizzleTransaction,
    approval: ExecutionAuthorizationInput,
    receipts: ExecutionAuthorizationReceipt[],
  ) => Promise<T>,
) {
  return withTransaction(db, async (tx) => {
    const approval = await lockApproval(tx, request.ref, request.owner);
    if (now.getTime() >= new Date(approval.expiresAt).getTime())
      throw new Error("Execution approval has expired.");
    if (
      request.requestedScope.mailboxId !== approval.scope.mailboxId ||
      request.requestedScope.discovery !== approval.scope.discovery
    )
      throw new Error(
        "Requested discovery scope is outside this execution approval.",
      );
    await liveMailbox(tx, approval);
    const receipts = await receiptsFor(tx, request.ref, approval);
    if (receipts.some((receipt) => receipt.kind === "revocation"))
      throw new Error("Execution authorization has been revoked.");
    return use(tx, approval, receipts);
  });
}

export async function issueExecutionAuthorization(
  db: Database,
  actor: ActorContext,
  rawInput: ExecutionAuthorizationInput,
  clock: Clock = {},
): Promise<ExecutionAuthorizationRef> {
  durableConnection(db);
  const input = executionAuthorizationInput.parse(rawInput);
  const now = instant(clock);
  if (actor.userId !== input.owner.userId)
    throw new Error("Only the execution approval owner may issue it.");
  if (now.getTime() >= new Date(input.expiresAt).getTime())
    throw new Error("Execution approval must expire in the future.");
  return withTransaction(db, async (tx) => {
    const member = await liveOwner(tx, input.owner);
    await liveMailbox(tx, input);
    const root = await insertWithShortcode(tx, "run", {
      purpose: "background",
      trigger: "manual",
      status: "completed",
      ledgerPartyId: member.id,
      actorUserId: actor.userId,
      actorName: member.userName,
      actorEmail: member.email,
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      channel: actor.channel,
      input,
      endedAt: now,
    });
    return executionAuthorizationRef.parse({
      runId: root.id,
      approvalFingerprint: await snapshotFingerprint(input),
    });
  });
}

export async function assertExecutionAuthorization(
  db: Database,
  rawInput: ExecutionAuthorizationRequest,
  clock: Clock = {},
): Promise<ExecutionAuthorizationInput> {
  const input = executionAuthorizationRequest.parse(rawInput);
  return authorized(
    db,
    input,
    instant(clock),
    async (_tx, approval) => approval,
  );
}

/** A repeated physical attempt receipt must refuse another transmission. */
export async function reserveExecutionAuthorization(
  db: Database,
  rawInput: ExecutionAuthorizationReservation,
  clock: Clock = {},
): Promise<ReservationDecision> {
  durableConnection(db);
  const input = executionAuthorizationReservation.parse(rawInput);
  const now = instant(clock);
  return authorized<ReservationDecision>(
    db,
    input,
    now,
    async (tx, approval, receipts) => {
      const reservations = receipts.filter(
        (receipt) => receipt.kind === "metered_reservation",
      );
      if (
        reservations.some(
          (receipt) => receipt.physicalAttemptId === input.physicalAttemptId,
        )
      )
        return { status: "refused", reason: "attempt_already_reserved" };
      const bucket = periodKey(approval, now);
      let reserved = 0;
      for (const receipt of reservations) {
        if (receipt.periodKey !== bucket) continue;
        if (receipt.reservedMicroUSD > Number.MAX_SAFE_INTEGER - reserved)
          throw new Error(
            "Execution authorization receipt total exceeds safe integer accounting.",
          );
        reserved += receipt.reservedMicroUSD;
      }
      if (
        input.reservationMicroUSD >
        approval.meteredBudget.limitMicroUSD - reserved
      )
        return { status: "refused", reason: "budget_exhausted" };
      await writeReceipt(tx, input.ref, `metered:${input.physicalAttemptId}`, {
        kind: "metered_reservation",
        approvalFingerprint: input.ref.approvalFingerprint,
        physicalAttemptId: input.physicalAttemptId,
        requestedScope: input.requestedScope,
        periodKey: bucket,
        reservedMicroUSD: input.reservationMicroUSD,
        reservedAt: now.toISOString(),
      });
      return { status: "reserved" };
    },
  );
}

export async function claimExecutionAuthorization(
  db: Database,
  rawInput: ExecutionAuthorizationClaimRequest,
  clock: Clock = {},
): Promise<ClaimDecision> {
  const input = executionAuthorizationClaimRequest.parse(rawInput);
  const now = instant(clock);
  return authorized<ClaimDecision>(
    db,
    input,
    now,
    async (tx, approval, receipts) => {
      if (
        input.claim.kind === "candidate" &&
        input.claim.mailboxId !== approval.scope.mailboxId
      )
        throw new Error(
          "Candidate claim mailbox is outside this execution approval.",
        );
      if (input.claim.kind === "product") {
        const [item] = await tx
          .select({ id: product.id })
          .from(product)
          .where(
            and(eq(product.id, input.claim.productId), notDeleted(product)),
          );
        if (!item)
          throw new Error(
            "Execution approval Product claim is not a live Product.",
          );
      }
      const identity = JSON.stringify(input.claim);
      const claims = receipts.filter((receipt) => receipt.kind === "claim");
      if (claims.some((receipt) => JSON.stringify(receipt.claim) === identity))
        return { status: "already_claimed" };
      if (approval.scope.kind === "pilot") {
        const distinct = new Set(
          claims
            .filter((receipt) => receipt.claim.kind === input.claim.kind)
            .map((receipt) => JSON.stringify(receipt.claim)),
        );
        const limit =
          input.claim.kind === "candidate"
            ? approval.scope.candidateLimit
            : approval.scope.productLimit;
        if (distinct.size >= limit)
          return {
            status: "refused",
            reason:
              input.claim.kind === "candidate"
                ? "candidate_limit"
                : "product_limit",
          };
      }
      await writeReceipt(tx, input.ref, `claim:${await sha256Hex(identity)}`, {
        kind: "claim",
        approvalFingerprint: input.ref.approvalFingerprint,
        claim: input.claim,
        claimedAt: now.toISOString(),
      });
      return { status: "claimed" };
    },
  );
}

export async function revokeExecutionAuthorization(
  db: Database,
  actor: ActorContext,
  rawRef: ExecutionAuthorizationRef,
  clock: Clock = {},
): Promise<void> {
  durableConnection(db);
  const ref = executionAuthorizationRef.parse(rawRef);
  const now = instant(clock);
  await withTransaction(db, async (tx) => {
    const [root] = await tx
      .select({ ledgerPartyId: run.ledgerPartyId })
      .from(run)
      .where(eq(run.id, ref.runId))
      .for("update");
    if (!root?.ledgerPartyId)
      throw new Error("Execution authorization approval root has no owner.");
    const approval = await lockApproval(tx, ref, {
      userId: actor.userId,
      ledgerPartyId: root.ledgerPartyId,
    });
    const receipts = await receiptsFor(tx, ref, approval);
    if (receipts.some((receipt) => receipt.kind === "revocation")) return;
    // Expiry or disconnect never prevents the owner from permanently revoking.
    await writeReceipt(tx, ref, "revocation", {
      kind: "revocation",
      approvalFingerprint: ref.approvalFingerprint,
      revokedAt: now.toISOString(),
    });
  });
}
