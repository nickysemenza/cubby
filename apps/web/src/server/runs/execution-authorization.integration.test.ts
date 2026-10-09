import {
  executionAuthorizationInput,
  executionAuthorizationReceipt,
  executionAuthorizationRef,
  type ExecutionAuthorizationInput,
  type ExecutionAuthorizationRequest,
} from "@cubby/schemas/execution-authorization";
import { userId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { ledgerParty, run, runOperation, user } from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertOperation } from "~/server/repo/run-operation";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  assertExecutionAuthorization,
  claimExecutionAuthorization,
  EXECUTION_AUTHORIZATION_RECEIPT_KIND,
  reserveExecutionAuthorization,
} from "./execution-authorization";

// Failure modes: concurrent cap overspend; replay retransmission; timeout
// refunds; claim replay consuming distinct slots; widened discovery scope;
// foreign/revoked/expired/deleted/changed approval; UTC month carry/reset loss.
// All approvals and receipts are real PG rows. No provider call or timer is mocked.
const SEPTEMBER = new Date("2026-09-30T23:59:59.000Z");
const OCTOBER = new Date("2026-10-01T00:00:00.000Z");
const mailboxId = "synthetic-authorization-mailbox";

describe("member-owned execution authorization receipts", () => {
  const ctx = withTestDb();

  async function fixture(
    options: {
      continuous?: boolean;
      budget?: number;
      candidateLimit?: number;
      productLimit?: number;
    } = {},
  ) {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic execution approver",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const accountId = crypto.randomUUID();
    await getDb(ctx.db).insert(account).values({
      id: accountId,
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: SEPTEMBER,
    });
    const approval = executionAuthorizationInput.parse({
      kind: "execution_authorization",
      version: 1,
      owner: { userId: ctx.actor.userId, ledgerPartyId: member.id },
      scope: options.continuous
        ? { kind: "continuous", mailboxId, discovery: "new_mail" }
        : {
            kind: "pilot",
            mailboxId,
            discovery: "targeted",
            candidateLimit: options.candidateLimit ?? 2,
            productLimit: options.productLimit ?? 2,
          },
      meteredBudget: {
        period: options.continuous ? "utc_calendar_month" : "lifetime",
        limitMicroUSD: options.budget ?? 200,
      },
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    // Direct typed storage isolates consumption from the unimplemented issuer.
    // A completed root has no coordinator, tasks, approval queue or mutable lease.
    const root = await insertWithShortcode(ctx.db, "run", {
      purpose: "background",
      status: "completed",
      trigger: "manual",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "approver@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      input: approval,
      endedAt: SEPTEMBER,
    });
    const ref = executionAuthorizationRef.parse({
      runId: root.id,
      approvalFingerprint: await sha256Hex(JSON.stringify(approval)),
    });
    const request: ExecutionAuthorizationRequest = {
      ref,
      owner: approval.owner,
      requestedScope: {
        mailboxId,
        discovery: approval.scope.discovery,
      },
    };
    const receipts = () =>
      getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, root.id),
            eq(runOperation.kind, EXECUTION_AUTHORIZATION_RECEIPT_KIND),
          ),
        )
        .orderBy(runOperation.operationId);
    const reserve = (
      reservationMicroUSD: number,
      physicalAttemptId = crypto.randomUUID(),
      now = SEPTEMBER,
    ) =>
      reserveExecutionAuthorization(
        ctx.db,
        { ...request, physicalAttemptId, reservationMicroUSD },
        { now },
      );
    return { member, accountId, approval, root, request, receipts, reserve };
  }

  it("admits only one of two concurrent reservations that cannot both fit the full conservative cap", async () => {
    const f = await fixture({ budget: 100 });
    const attempts = [crypto.randomUUID(), crypto.randomUUID()];
    const decisions = await Promise.all(
      attempts.map((attempt) => f.reserve(70, attempt)),
    );
    expect(
      decisions.filter((decision) => decision.status === "reserved"),
    ).toHaveLength(1);
    expect(
      decisions.filter((decision) => decision.status === "refused"),
    ).toEqual([{ status: "refused", reason: "budget_exhausted" }]);
    const receipts = await f.receipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ state: "completed" });
    expect(
      executionAuthorizationReceipt.parse(receipts[0]?.result),
    ).toMatchObject({
      kind: "metered_reservation",
      reservedMicroUSD: 70,
      periodKey: "lifetime",
    });
  });

  it("refuses a savepoint-bound reservation before a rolled-back caller can receive transmission permission", async () => {
    const f = await fixture();
    let transmissionAllowed = false;
    await expect(
      withTransaction(ctx.db, async (tx) => {
        const result = await reserveExecutionAuthorization(
          databaseForTransaction(tx),
          {
            ...f.request,
            physicalAttemptId: crypto.randomUUID(),
            reservationMicroUSD: 10,
          },
          { now: SEPTEMBER },
        );
        transmissionAllowed = result.status === "reserved";
        throw new Error(
          "Synthetic caller rollback after external transmission",
        );
      }),
    ).rejects.toThrow(/durable|transaction|savepoint/iu);
    expect(transmissionAllowed).toBe(false);
    expect(await f.receipts()).toEqual([]);
  });

  it.each(["malformed", "unknown", "noncompleted"] as const)(
    "refuses %s authorization receipts instead of ignoring an uncertain charge",
    async (condition) => {
      const f = await fixture();
      const receipt = executionAuthorizationReceipt.parse({
        kind: "metered_reservation",
        approvalFingerprint: f.request.ref.approvalFingerprint,
        physicalAttemptId: crypto.randomUUID(),
        requestedScope: f.request.requestedScope,
        periodKey: "lifetime",
        reservedMicroUSD: 199,
        reservedAt: SEPTEMBER.toISOString(),
      });
      await insertOperation(getDb(ctx.db), {
        runId: f.root.id,
        operationId: "synthetic-uncertain-receipt",
        kind: EXECUTION_AUTHORIZATION_RECEIPT_KIND,
        inputFingerprint: await sha256Hex(JSON.stringify(receipt)),
        state: condition === "noncompleted" ? "started" : "completed",
        result:
          condition === "malformed"
            ? "synthetic-invalid-receipt"
            : condition === "unknown"
              ? { kind: "unsupported_authorization_receipt" }
              : receipt,
      });
      const before = await f.receipts();
      await expect(f.reserve(1)).rejects.toThrow(/receipt/iu);
      expect(await f.receipts()).toEqual(before);
    },
  );

  it("charges a timeout retry as a new physical attempt and refuses duplicate transmission without refunding either receipt", async () => {
    const f = await fixture({ budget: 160 });
    const firstAttempt = crypto.randomUUID();
    expect(await f.reserve(70, firstAttempt)).toEqual({ status: "reserved" });
    const firstReceipt = await f.receipts();
    // No completion callback means the provider timed out or the host crashed.
    // A fresh physical attempt still consumes its whole conservative reservation.
    expect(await f.reserve(70)).toEqual({ status: "reserved" });
    expect(await f.reserve(70, firstAttempt)).toEqual({
      status: "refused",
      reason: "attempt_already_reserved",
    });
    expect(await f.reserve(1, firstAttempt)).toEqual({
      status: "refused",
      reason: "attempt_already_reserved",
    });
    expect(await f.reserve(21)).toEqual({
      status: "refused",
      reason: "budget_exhausted",
    });
    const after = await f.receipts();
    expect(after).toHaveLength(2);
    expect(after.find((receipt) => receipt.id === firstReceipt[0]?.id)).toEqual(
      firstReceipt[0],
    );
    expect(
      after.map((receipt) =>
        executionAuthorizationReceipt.parse(receipt.result),
      ),
    ).toMatchObject([
      { kind: "metered_reservation", reservedMicroUSD: 70 },
      { kind: "metered_reservation", reservedMicroUSD: 70 },
    ]);
  });

  it.each(["candidate", "product"] as const)(
    "caps distinct %s claims while concurrent and later replay preserve the same slot",
    async (kind) => {
      const f = await fixture({ candidateLimit: 1, productLimit: 1 });
      const first = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic first claimed item" }),
        ctx.actor,
      );
      const second = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic second claimed item" }),
        ctx.actor,
      );
      const claim =
        kind === "candidate"
          ? { kind, mailboxId, messageId: "synthetic-candidate-one" }
          : { kind, productId: first.entityId };
      const another =
        kind === "candidate"
          ? { kind, mailboxId, messageId: "synthetic-candidate-two" }
          : { kind, productId: second.entityId };
      const request = { ...f.request, claim };
      const decisions = await Promise.all([
        claimExecutionAuthorization(ctx.db, request, { now: SEPTEMBER }),
        claimExecutionAuthorization(ctx.db, request, { now: SEPTEMBER }),
      ]);
      expect(decisions).toEqual(
        expect.arrayContaining([
          { status: "claimed" },
          { status: "already_claimed" },
        ]),
      );
      const before = await f.receipts();
      expect(before).toHaveLength(1);
      expect(
        await claimExecutionAuthorization(
          ctx.db,
          { ...f.request, claim: another },
          { now: SEPTEMBER },
        ),
      ).toEqual({
        status: "refused",
        reason: kind === "candidate" ? "candidate_limit" : "product_limit",
      });
      expect(
        await claimExecutionAuthorization(ctx.db, request, { now: OCTOBER }),
      ).toEqual({ status: "already_claimed" });
      expect(await f.receipts()).toEqual(before);
    },
  );

  it.each([
    "foreign_owner",
    "revoked",
    "expired",
    "non_root",
    "wrong_purpose",
    "deleted_root",
    "retired_root",
    "unknown_snapshot",
    "changed_snapshot",
    "deleted_owner",
    "disconnected_mailbox",
  ] as const)(
    "refuses %s authority before accepting a charge or claim",
    async (condition) => {
      const f = await fixture();
      const request = { ...f.request };
      let now = SEPTEMBER;
      if (condition === "foreign_owner") {
        const foreignId = userId.parse(
          `synthetic-other-approver-${crypto.randomUUID()}`,
        );
        await getDb(ctx.db)
          .insert(user)
          .values({
            id: foreignId,
            name: "Synthetic other approver",
            email: `other-${crypto.randomUUID()}@example.test`,
          });
        const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
          name: "Synthetic other member",
          kind: "member",
          userId: foreignId,
        });
        request.owner = { userId: foreignId, ledgerPartyId: foreign.id };
      }
      if (condition === "revoked") {
        const receipt = executionAuthorizationReceipt.parse({
          kind: "revocation",
          approvalFingerprint: f.request.ref.approvalFingerprint,
          revokedAt: SEPTEMBER.toISOString(),
        });
        await insertOperation(getDb(ctx.db), {
          runId: f.root.id,
          operationId: "revocation",
          kind: EXECUTION_AUTHORIZATION_RECEIPT_KIND,
          inputFingerprint: await sha256Hex(JSON.stringify(receipt)),
          state: "completed",
          result: receipt,
        });
      }
      if (condition === "expired") now = new Date(f.approval.expiresAt);
      if (condition === "non_root") {
        const parent = await insertWithShortcode(ctx.db, "run", {
          purpose: "background",
          status: "completed",
          trigger: "manual",
          ledgerPartyId: f.member.id,
          actorUserId: ctx.actor.userId,
          actorName: f.member.name,
          actorEmail: "approver@example.test",
          actorLedgerPartyShortcode: f.member.shortcode,
          actorLedgerPartyName: f.member.name,
          actorLedgerPartyKind: "member",
          endedAt: SEPTEMBER,
        });
        await getDb(ctx.db)
          .update(run)
          .set({ parentRunId: parent.id })
          .where(eq(run.id, f.root.id));
      }
      if (condition === "wrong_purpose")
        await getDb(ctx.db)
          .update(run)
          .set({ purpose: "ai_suggest" })
          .where(eq(run.id, f.root.id));
      if (condition === "deleted_root")
        await getDb(ctx.db)
          .update(run)
          .set({ deletedAt: SEPTEMBER })
          .where(eq(run.id, f.root.id));
      if (condition === "retired_root")
        await getDb(ctx.db)
          .update(run)
          .set({ retiredAt: SEPTEMBER, retirementReason: "unrelated_source" })
          .where(eq(run.id, f.root.id));
      if (condition === "unknown_snapshot")
        await getDb(ctx.db)
          .update(run)
          .set({ input: null })
          .where(eq(run.id, f.root.id));
      if (condition === "changed_snapshot") {
        const input: ExecutionAuthorizationInput = {
          ...f.approval,
          meteredBudget: { ...f.approval.meteredBudget, limitMicroUSD: 900 },
        };
        await getDb(ctx.db)
          .update(run)
          .set({ input })
          .where(eq(run.id, f.root.id));
      }
      if (condition === "deleted_owner")
        await getDb(ctx.db)
          .update(ledgerParty)
          .set({ deletedAt: SEPTEMBER })
          .where(eq(ledgerParty.id, f.member.id));
      if (condition === "disconnected_mailbox")
        await getDb(ctx.db).delete(account).where(eq(account.id, f.accountId));
      const before = await f.receipts();
      await expect(
        assertExecutionAuthorization(ctx.db, request, { now }),
      ).rejects.toThrow(/authorization|approval|owner|mailbox/iu);
      await expect(
        reserveExecutionAuthorization(
          ctx.db,
          {
            ...request,
            physicalAttemptId: crypto.randomUUID(),
            reservationMicroUSD: 1,
          },
          { now },
        ),
      ).rejects.toThrow(/authorization|approval|owner|mailbox/iu);
      await expect(
        claimExecutionAuthorization(
          ctx.db,
          {
            ...request,
            claim: {
              kind: "candidate",
              mailboxId,
              messageId: "synthetic-refused-candidate",
            },
          },
          { now },
        ),
      ).rejects.toThrow(/authorization|approval|owner|mailbox/iu);
      expect(await f.receipts()).toEqual(before);
    },
  );

  it("opens only a fresh UTC month bucket without carrying unused allowance or deleting historical reservations", async () => {
    const f = await fixture({ continuous: true, budget: 100 });
    const septemberAttempt = crypto.randomUUID();
    expect(await f.reserve(70, septemberAttempt, SEPTEMBER)).toEqual({
      status: "reserved",
    });
    const september = await f.receipts();
    expect(await f.reserve(31, crypto.randomUUID(), SEPTEMBER)).toEqual({
      status: "refused",
      reason: "budget_exhausted",
    });
    expect(await f.reserve(80, crypto.randomUUID(), OCTOBER)).toEqual({
      status: "reserved",
    });
    expect(await f.reserve(21, crypto.randomUUID(), OCTOBER)).toEqual({
      status: "refused",
      reason: "budget_exhausted",
    });
    expect(await f.reserve(70, septemberAttempt, OCTOBER)).toEqual({
      status: "refused",
      reason: "attempt_already_reserved",
    });
    const after = await f.receipts();
    expect(after).toHaveLength(2);
    expect(after.find((receipt) => receipt.id === september[0]?.id)).toEqual(
      september[0],
    );
    const reservations = after.map((receipt) =>
      executionAuthorizationReceipt.parse(receipt.result),
    );
    expect(reservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ periodKey: "2026-09", reservedMicroUSD: 70 }),
        expect.objectContaining({ periodKey: "2026-10", reservedMicroUSD: 80 }),
      ]),
    );
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.root.id));
    expect(executionAuthorizationInput.parse(saved?.input)).toEqual(f.approval);
    expect(saved).toMatchObject({ status: "completed", parentRunId: null });
  });

  it.each([false, true])(
    "does not widen %s discovery approval to another mailbox or all-history scan",
    async (continuous) => {
      const f = await fixture({ continuous });
      expect(
        await assertExecutionAuthorization(ctx.db, f.request, {
          now: SEPTEMBER,
        }),
      ).toEqual(f.approval);
      await expect(
        assertExecutionAuthorization(
          ctx.db,
          {
            ...f.request,
            requestedScope: { mailboxId, discovery: "all_history" },
          },
          { now: SEPTEMBER },
        ),
      ).rejects.toThrow(/scope|approval/iu);
      await expect(
        claimExecutionAuthorization(
          ctx.db,
          {
            ...f.request,
            claim: {
              kind: "candidate",
              mailboxId: "synthetic-other-mailbox",
              messageId: "synthetic-other-message",
            },
          },
          { now: SEPTEMBER },
        ),
      ).rejects.toThrow(/scope|mailbox|approval/iu);
      expect(await f.receipts()).toEqual([]);
    },
  );
});
