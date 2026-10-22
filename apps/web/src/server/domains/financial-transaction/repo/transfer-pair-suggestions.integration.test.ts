import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import type { FinancialAccountIdentity } from "@cubby/schemas/financial-account-fields";
import {
  parseShortcodeFor,
  type FinancialAccountShortcode,
} from "@cubby/schemas/identifiers";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import {
  transferPairJudgment,
  type TransferPairJudgment,
  type TransferPairMovementLabel,
} from "@cubby/schemas/transfer-pair-suggestion";
import { eq, isNull, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AiWorkDeferredError } from "~/server/ai/cooperative-work";
import type { DecisionPort } from "~/server/ai/decision-model";
import type { DecisionQuestionsInput } from "~/server/ai/decision-request-batch";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import * as cfEnv from "~/server/cf-env";
import { unwrapDb } from "~/server/db/helpers";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  ledgerTransfer,
  run,
  sourceTransactionRecord,
} from "~/server/db/schema";
import { labelTransferPairSuggestions } from "~/server/domains/financial-transaction/service/transfer-pair-labels";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";
import {
  isWorkflowInterrupted,
  withWorkflowExecution,
} from "~/server/workflows/runs/execution";

import {
  applyTransferPair,
  countTransferPairsNeedingLabels,
  currentTransferPair,
  discoverTransferPairs,
  findTransferPairForCharge,
  fingerprintTransferPair,
  generateTransferPairSuggestionsPage,
  generateTransferPairSuggestions,
  transferPairGenerationCursor,
  transferPairEvidenceFingerprint,
} from "./transfer-pair-suggestions";

/*
 * Failure modes this file guards (#2827):
 * - A provider Transfer category or recorded transfer kind alone pairs clean:
 *   a cashed check filed under Transfer meets a payment-app repayment.
 * - A high-confidence movement label overrides structure: a cross-owner,
 *   competing, distant or unowned pair becomes clean, or a non-clean pair
 *   applies without review.
 * - Uniqueness counts only strong candidates, so a weak competitor hides.
 * - An ATM withdrawal invents a clean virtual cash leg, splits the fee off,
 *   or pairs when the owner has several cash accounts.
 * - Overlapping exports pair one charge twice, or an apply creates a second
 *   transaction for money another export already recorded.
 * - A replayed, stale or concurrent apply pairs a leg twice or leaves a
 *   created leg behind when the pair writer refuses.
 * - Pending, allocated, already-paired or soft-deleted records (or records
 *   on a deleted account or owner) become legs.
 * - A created statement leg carries only one of its charge's refs.
 * - Two provider accounts sharing a descriptor resolve to the same account.
 * - A discovery page misses a competing leg outside its seeds, publishes a
 *   pair twice, or retires a live pair before all discovery pages finish.
 * - Replaying a discovery cursor duplicates publications, or retirement
 *   treats an unvisited or newly restored candidate as absent.
 * - Model publication leaves the label queue before its dependent statement
 *   publications commit, so a crash loses the statement regeneration.
 * - A cancelled Workflow publishes a model result after computation returns,
 *   or hides its control interruption as a per-pair failure.
 * - One publication failure blocks independent pairs, or replay repeats
 *   already committed successes instead of retrying only unfinished effects.
 */
describe("transfer-pair suggestions", () => {
  const ctx = withTestDb();

  type Choice = TransferPairMovementLabel["choice"];
  /** Model stand-in: answers each leg's movement question by its descriptor. */
  const movementPort =
    (answer: (descriptor: string) => Choice, confidence = 0.97): DecisionPort =>
    async (input) => {
      const criteria = input.questions.selection.criteria;
      const keys = Object.keys(criteria);
      const subject = z
        .object({ descriptor: z.string().nullable() })
        .parse(JSON.parse(input.state));
      const wanted = answer(subject.descriptor ?? "");
      const choice = keys.find((key) => criteria[key] === wanted)!;
      return {
        answers: {
          selection: {
            type: "choice",
            choice,
            confidence,
            probabilities: Object.fromEntries(
              keys.map((key) => [
                key,
                key === choice
                  ? confidence
                  : (1 - confidence) / (keys.length - 1),
              ]),
            ),
          },
        },
      };
    };
  const byDescriptor = (descriptor: string): Choice =>
    /TRANSFER|ATM|CARD PAYMENT|PAYMENT RECEIVED/i.test(descriptor)
      ? "account_move"
      : /^CHECK\b/i.test(descriptor)
        ? "insufficient_evidence"
        : "payment";

  const owner = async (name: string) =>
    (await createRepoEntity(ctx, "ledgerParty", { name, kind: "member" }))
      .output!.id;

  const checking: FinancialAccountIdentity = {
    kind: "bank_account",
    institution: "Example Bank",
    accountType: "checking",
  };
  const savings: FinancialAccountIdentity = {
    kind: "bank_account",
    institution: "Example Bank",
    accountType: "savings",
  };
  const account = async (
    name: string,
    ledgerPartyId: Awaited<ReturnType<typeof owner>> | null,
    identity: FinancialAccountIdentity = checking,
    providerAccountId: string | null = null,
  ) =>
    (
      await createRepoEntity(ctx, "financialAccount", {
        name,
        identity,
        ledgerPartyId,
        sourceAliases: ["monarch", "copilot"].map((source) => ({
          source,
          alias: name,
          externalAccountId: providerAccountId,
        })),
      })
    ).output!.id;

  let position = 0;
  type Row = {
    account: string;
    date: string;
    /** Cubby convention: positive is money out of the account. */
    amount: number;
    description: string;
    category?: string | null;
    status?: "posted" | "pending" | null;
    providerTransactionId?: string;
    providerAccountId?: string;
  };
  const statement = (
    rows: Row[],
    options: { source?: string; fingerprint?: string } = {},
  ) =>
    recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: options.source ?? "monarch",
          label: "Synthetic export.csv",
          fingerprint: options.fingerprint ?? `synthetic-pairs-${++position}`,
          dateKind: "posted",
          rowCountDeclared: null,
          notes: null,
        },
        rows: rows.map((row) => ({
          accountDescriptor: row.account,
          statementDate: row.date,
          providerAmount: -row.amount,
          merchant: null,
          rawDescription: row.description,
          sourceCategory:
            row.category === undefined ? "Transfer" : row.category,
          providerStatus: row.status === undefined ? "posted" : row.status,
          providerNotes: null,
          providerTransactionId: row.providerTransactionId ?? null,
          providerAccountId: row.providerAccountId ?? null,
          rowPosition: ++position,
        })),
      }),
      ctx.actor,
    );

  const transaction = async (
    accountId: FinancialAccountShortcode,
    amount: number,
    date: string,
    extra: Parameters<typeof createRepoEntity<"financialTransaction">>[2] = {},
  ) =>
    (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId,
        amount,
        kind: "account_transfer",
        status: "posted",
        postedDate: date,
        transactionDate: date,
        merchant: null,
        rawDescription: "ONLINE TRANSFER",
        sourceCategory: "Transfer",
        purchaseId: null,
        allocations: [],
        sourceRefs: [],
        notes: null,
        ...extra,
      })
    ).output!;

  const refresh = async (
    answer: (descriptor: string) => Choice = byDescriptor,
    confidence = 0.97,
  ) => {
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    await labelTransferPairSuggestions(ctx.db, {
      port: movementPort(answer, confidence),
    });
  };

  /** Pending, active publications with their labelled judgments. */
  const pending = async () => {
    const { rows } = await unwrapDb(ctx.db).execute<{
      judgment: unknown;
      fingerprint: string;
    }>(sql`
      SELECT a.judgment, s.fingerprint FROM "AssessmentState" s
      JOIN "Assessment" a ON a.id = s.id
      WHERE s.family = ${assessmentFamily.enum.transfer_pair} AND s.active
        AND s.status = ${suggestionStatus.enum.pending}
    `);
    return rows.map((row) => ({
      judgment: transferPairJudgment.parse(row.judgment),
      fingerprint: String(row.fingerprint),
    }));
  };
  const pendingOn = async (accountId: string) =>
    (await pending()).filter(
      ({ judgment }) =>
        judgment.outflow.accountId === accountId ||
        judgment.inflow.accountId === accountId,
    );

  it("filters ordinary spending seeds in one page without per-record hydration", async () => {
    const member = await owner("Synthetic batch member");
    const checking = await account("Synthetic batch checking", member);
    await transaction(checking, 10, "2026-05-04", {
      kind: "purchase",
      sourceCategory: "Shopping",
    });
    await statement(
      [20, 30, 40].map((amount) => ({
        account: "Synthetic batch checking",
        date: "2026-05-04",
        amount,
        description: "SYNTHETIC SHOP",
        category: "Shopping",
      })),
    );
    const single = await countTestDbQueries(() =>
      generateTransferPairSuggestionsPage(ctx.db, { runId: null, limit: 1 }),
    );
    const batch = await countTestDbQueries(() =>
      generateTransferPairSuggestionsPage(ctx.db, { runId: null, limit: 4 }),
    );
    expect(single.result.processed).toBe(1);
    expect(batch.result.processed).toBe(4);
    expect(batch.result.found).toBe(0);
    expect(batch.result.failed).toEqual([]);
    expect(batch.queryCount).toBe(single.queryCount);
    expect(await pending()).toEqual([]);
  });

  it("resumes bounded discovery with complete competitors and verifies absence only after coverage", async () => {
    const member = await owner("Synthetic paging member");
    const checking = await account("Synthetic paging checking", member);
    const savings = await account("Synthetic paging savings", member);
    const other = await account("Synthetic paging other", member);
    for (const amount of [100, 200, 300]) {
      await transaction(checking, amount, "2026-05-04");
      await transaction(savings, -amount, "2026-05-04");
    }
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    const original = await pendingOn(checking);
    const absent = original.find(({ judgment }) => judgment.amount === 300)!;
    await unwrapDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(
        eq(
          financialTransaction.shortcode,
          absent.judgment.inflow.transactionId!,
        ),
      );
    await transaction(other, -100, "2026-05-04");

    const first = await generateTransferPairSuggestionsPage(ctx.db, {
      runId: null,
      limit: 1,
      maxBytes: 1,
    });
    expect(first.found).toBeLessThanOrEqual(1);
    expect(first.next?.kind).toBe("discover");
    expect(
      (await pendingOn(checking)).some(
        ({ judgment }) => judgment.key === absent.judgment.key,
      ),
    ).toBe(true);

    // Replaying the same persisted cursor after a lost acknowledgement must
    // reuse committed publications and reach exactly the same continuation.
    const replay = await generateTransferPairSuggestionsPage(ctx.db, {
      runId: null,
      limit: 1,
      maxBytes: 1,
    });
    expect(replay.published).toBe(0);
    expect(replay.next).toEqual(first.next);
    expect(replay.found).toBe(first.found);
    expect(replay.processed).toBe(first.processed);
    expect(replay.bytes).toBe(first.bytes);
    let cursor = first.next;
    let found = first.found;
    for (let page = 0; cursor?.kind === "discover" && page < 30; page++) {
      const result = await generateTransferPairSuggestionsPage(ctx.db, {
        runId: null,
        limit: 1,
        maxBytes: 1,
        after: transferPairGenerationCursor.parse(
          JSON.parse(JSON.stringify(cursor)),
        ),
      });
      expect(result.found).toBeLessThanOrEqual(1);
      expect(result.retired).toBe(0);
      found += result.found;
      cursor = result.next;
    }
    expect(cursor?.kind).toBe("retire");
    expect(found).toBe(3);
    const discovered = await pendingOn(checking);
    const competing = discovered.filter(
      ({ judgment }) => judgment.amount === 100,
    );
    expect(competing).toHaveLength(2);
    expect(
      competing.every(
        ({ judgment }) => judgment.competitors.length === 1 && !judgment.clean,
      ),
    ).toBe(true);
    expect(
      discovered.some(({ judgment }) => judgment.key === absent.judgment.key),
    ).toBe(true);

    // Restore one candidate after discovery. Fresh retirement verification
    // must retain it even though this pass never discovered it.
    await unwrapDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: null })
      .where(
        eq(
          financialTransaction.shortcode,
          absent.judgment.inflow.transactionId!,
        ),
      );
    for (let page = 0; cursor && page < 30; page++) {
      const result = await generateTransferPairSuggestionsPage(ctx.db, {
        runId: null,
        limit: 1,
        after: cursor,
      });
      cursor = result.next;
    }
    expect(cursor).toBeNull();
    expect(
      (await pendingOn(checking)).map(({ judgment }) => judgment.key),
    ).toContain(absent.judgment.key);

    await unwrapDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(
        eq(
          financialTransaction.shortcode,
          absent.judgment.inflow.transactionId!,
        ),
      );
    const secondAbsent = original.find(
      ({ judgment }) => judgment.amount === 200,
    )!;
    await unwrapDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(
        eq(
          financialTransaction.shortcode,
          secondAbsent.judgment.inflow.transactionId!,
        ),
      );
    let removalCursor: z.infer<typeof transferPairGenerationCursor> | null =
      null;
    let retired = 0;
    type GenerationPage = Awaited<
      ReturnType<typeof generateTransferPairSuggestionsPage>
    >;
    const retirementReplays: {
      result: GenerationPage;
      replay: GenerationPage;
    }[] = [];
    for (let page = 0; page < 40; page++) {
      const input = { runId: null, limit: 16, after: removalCursor };
      const result = await generateTransferPairSuggestionsPage(ctx.db, input);
      retired += result.retired;
      if (result.retired) {
        const replay = await generateTransferPairSuggestionsPage(ctx.db, input);
        retirementReplays.push({ result, replay });
      }
      removalCursor = result.next;
      if (!removalCursor) break;
    }
    expect(removalCursor).toBeNull();
    expect(retired).toBe(2);
    for (const { result, replay } of retirementReplays) {
      expect(replay.retired).toBe(0);
      expect(replay.processed).toBe(result.processed);
      expect(replay.bytes).toBe(result.bytes);
      expect(replay.next).toEqual(result.next);
    }
    expect(await pendingOn(checking)).toHaveLength(2);
  });

  const liveTransactions = () =>
    unwrapDb(ctx.db)
      .select()
      .from(financialTransaction)
      .where(isNull(financialTransaction.deletedAt));
  const transfers = () =>
    unwrapDb(ctx.db)
      .select()
      .from(ledgerTransfer)
      .where(isNull(ledgerTransfer.deletedAt));
  const partyUuid = async (code: string) =>
    (
      await unwrapDb(ctx.db)
        .select({ id: ledgerParty.id })
        .from(ledgerParty)
        .where(eq(ledgerParty.shortcode, code))
    )[0]!.id;

  const apply = (
    pair: { judgment: TransferPairJudgment; fingerprint: string },
    reviewed?: boolean,
  ) =>
    applyTransferPair(ctx.db, kernelCtx(ctx), {
      key: pair.judgment.key,
      expectedFingerprint: pair.fingerprint,
      ...(reviewed === undefined ? {} : { reviewed }),
    });

  it("retains independent generation successes while a failed pair remains retryable", async () => {
    const member = await owner("Synthetic retry member");
    const checking = await account("Synthetic retry checking", member);
    const savings = await account("Synthetic retry savings", member);
    for (const amount of [80, 90]) {
      await transaction(checking, amount, "2026-05-04");
      await transaction(savings, -amount, "2026-05-04");
    }
    await unwrapDb(ctx.db).execute(sql`
      CREATE FUNCTION synthetic_transfer_publication_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.family = '${sql.raw(assessmentFamily.enum.transfer_pair)}' AND (NEW.data->>'amount')::numeric = 80 THEN
          RAISE EXCEPTION 'synthetic independent transfer publication failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await unwrapDb(ctx.db).execute(sql`
      CREATE TRIGGER synthetic_transfer_publication_failure
      BEFORE INSERT ON "AssessmentState"
      FOR EACH ROW EXECUTE FUNCTION synthetic_transfer_publication_failure()
    `);
    try {
      const failed = await generateTransferPairSuggestionsPage(ctx.db, {
        runId: null,
        limit: 16,
      });
      expect(failed.published).toBe(1);
      expect(failed.failed).toHaveLength(1);
      expect(failed.failed[0]?.message).toContain(
        "synthetic independent transfer publication failure",
      );
      expect(
        (await pendingOn(checking)).map(({ judgment }) => judgment.amount),
      ).toEqual([90]);
    } finally {
      await unwrapDb(ctx.db).execute(
        sql`DROP TRIGGER synthetic_transfer_publication_failure ON "AssessmentState"`,
      );
      await unwrapDb(ctx.db).execute(
        sql`DROP FUNCTION synthetic_transfer_publication_failure()`,
      );
    }
    const replay = await generateTransferPairSuggestionsPage(ctx.db, {
      runId: null,
      limit: 16,
    });
    expect(replay).toMatchObject({ published: 1, unchanged: 1, failed: [] });
    expect(await pendingOn(checking)).toHaveLength(2);
  });

  it("discards completed movement computation after cancellation and preserves the replayable rule state", async () => {
    const member = await owner("Synthetic cancellation member");
    const checking = await account("Synthetic cancellation checking", member);
    const savings = await account("Synthetic cancellation savings", member);
    await transaction(checking, 64, "2026-05-04");
    await transaction(savings, -64, "2026-05-04");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "manual",
      status: "running",
      progress: {
        attempt: 1,
        total: 0,
        done: 0,
        applied: 0,
        queued: 0,
        failed: 0,
        diagnostics: [],
      },
    });
    await generateTransferPairSuggestions(ctx.db, { runId });
    const answer = movementPort(byDescriptor);
    let interrupted: unknown;
    let computations = 0;
    try {
      await withWorkflowExecution({ runId, attempt: 1 }, () =>
        labelTransferPairSuggestions(ctx.db, {
          runId,
          port: async (input) => {
            computations++;
            await unwrapDb(ctx.db)
              .update(run)
              .set({ status: "failed", failureCode: "user_cancelled" })
              .where(eq(run.id, runId));
            return answer(input);
          },
        }),
      );
    } catch (error) {
      interrupted = error;
    }
    expect(computations).toBeGreaterThan(0);
    expect(isWorkflowInterrupted(interrupted)).toBe(true);
    expect(await countTransferPairsNeedingLabels(ctx.db, { runId })).toBe(1);
    expect(
      (await pendingOn(checking))[0]?.judgment.outflow.movementLabel,
    ).toBeNull();
  });

  it("retains movement labels and retries dependent statement publication without another model call", async () => {
    const member = await owner("Synthetic atomic member");
    await account("Synthetic atomic checking", member);
    await account("Synthetic atomic savings", member, savings);
    await statement([
      {
        account: "Synthetic atomic checking",
        amount: 54,
        date: "2026-05-04",
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic atomic savings",
        amount: -54,
        date: "2026-05-04",
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    await unwrapDb(ctx.db).execute(sql`
      CREATE FUNCTION synthetic_transfer_refresh_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.family = '${sql.raw(assessmentFamily.enum.statement_transaction)}' THEN
          RAISE EXCEPTION 'synthetic dependent statement publication failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await unwrapDb(ctx.db).execute(sql`
      CREATE TRIGGER synthetic_transfer_refresh_failure
      BEFORE INSERT OR UPDATE ON "AssessmentState"
      FOR EACH ROW EXECUTE FUNCTION synthetic_transfer_refresh_failure()
    `);
    try {
      const failed = await labelTransferPairSuggestions(ctx.db, {
        port: movementPort(byDescriptor),
      });
      expect(failed.labelled).toBe(1);
      expect(failed.completed).toBe(0);
      expect(
        failed.failed.map((failure) => failure.message).join(" "),
      ).toContain("synthetic dependent statement publication failure");
      expect(await countTransferPairsNeedingLabels(ctx.db)).toBe(1);
      expect((await pending())[0]?.judgment.outflow.movementLabel?.choice).toBe(
        "account_move",
      );
    } finally {
      await unwrapDb(ctx.db).execute(
        sql`DROP TRIGGER synthetic_transfer_refresh_failure ON "AssessmentState"`,
      );
      await unwrapDb(ctx.db).execute(
        sql`DROP FUNCTION synthetic_transfer_refresh_failure()`,
      );
    }
    const retried = await labelTransferPairSuggestions(ctx.db, {
      port: async () => {
        throw new Error("Completed movement labels must not run again");
      },
    });
    expect(retried).toMatchObject({
      labelled: 0,
      completed: 1,
      failed: [],
      next: null,
    });
    expect(await countTransferPairsNeedingLabels(ctx.db)).toBe(0);
    const statements = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
    });
    expect(statements.items).toHaveLength(2);
  });

  // A wide Workflow page must checkpoint accepted pairs and yield on the
  // first admission refusal instead of polling inside the page invocation.
  it("retains completed pairs when another pair waits for shared capacity", async () => {
    const member = await owner("Synthetic Member");
    const from = await account("Synthetic Checking", member, checking);
    const to = await account("Synthetic Savings", member, savings);
    for (const amount of [100, 200]) {
      const rawDescription =
        amount === 100 ? "ONLINE TRANSFER" : "BLOCKED TRANSFER";
      await transaction(from, -amount, "2026-05-04", { rawDescription });
      await transaction(to, amount, "2026-05-04", { rawDescription });
    }
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    const answer = movementPort(byDescriptor);
    const until = Date.now() + 60_000;
    const outcome = await labelTransferPairSuggestions(ctx.db, {
      cooperative: true,
      port: async (input) => {
        if (input.state.includes("BLOCKED TRANSFER"))
          throw new AiWorkDeferredError(until);
        return answer(input);
      },
    });
    expect(outcome).toMatchObject({
      labelled: 1,
      failed: [],
      waitingUntil: until,
    });
    const resumed = await labelTransferPairSuggestions(ctx.db, {
      cooperative: true,
      after: outcome.next,
      port: answer,
    });
    expect(resumed).toMatchObject({
      labelled: 1,
      failed: [],
      next: null,
      waitingUntil: null,
    });
  });

  // Per-pair settlement prevents the transport runner from combining a page.
  it("submits both legs of the whole page to one settled decision runner", async () => {
    const member = await owner("Synthetic Member");
    const from = await account("Synthetic Checking", member, checking);
    const to = await account("Synthetic Savings", member, savings);
    for (const amount of [110, 220, 330]) {
      await transaction(from, -amount, "2026-05-04");
      await transaction(to, amount, "2026-05-04");
    }
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    await generateTransferPairSuggestions(ctx.db, { runId });
    await activateAiRefresh(ctx.db, "synthetic-batch", {
      enabled: true,
      manifest: {},
    });
    const requests: DecisionQuestionsInput[] = [];
    const gateway = vi.spyOn(cfEnv, "getTestAiGateway").mockReturnValue({
      fetch: async (_url, init) => {
        const input: DecisionQuestionsInput = JSON.parse(String(init?.body));
        requests.push(input);
        return Response.json({
          result: {
            answers: Object.fromEntries(
              Object.entries(input.questions).map(([id, question]) => {
                const choice = Object.keys(question.criteria).find(
                  (key) => question.criteria[key] === "account_move",
                )!;
                return [
                  id,
                  {
                    type: "choice",
                    choice,
                    confidence: 0.97,
                    probabilities: Object.fromEntries(
                      Object.keys(question.criteria).map((key) => [
                        key,
                        key === choice ? 0.97 : 0.01,
                      ]),
                    ),
                  },
                ];
              }),
            ),
          },
        });
      },
    });
    try {
      const outcome = await labelTransferPairSuggestions(ctx.db, { runId });
      expect(outcome).toMatchObject({ labelled: 3, failed: [], next: null });
      expect(
        requests.flatMap((request) => Object.keys(request.questions)),
      ).toHaveLength(6);
      expect(requests.length).toBeLessThanOrEqual(2);
      expect(
        requests.some((request) => Object.keys(request.questions).length > 2),
      ).toBe(true);
    } finally {
      gateway.mockRestore();
    }
  });

  // Pending model calls must not occupy the four-slot DB publication lane.
  it("fans out movement labels across every pair on the page", async () => {
    const member = await owner("Synthetic Member");
    const from = await account("Synthetic Checking", member, checking);
    const to = await account("Synthetic Savings", member, savings);
    for (let index = 0; index < 8; index++) {
      await transaction(from, -100 - index, "2026-05-04");
      await transaction(to, 100 + index, "2026-05-04");
    }
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const answer = movementPort(byDescriptor);
    let active = 0;
    let peak = 0;
    const pending = labelTransferPairSuggestions(ctx.db, {
      port: async (input) => {
        peak = Math.max(peak, ++active);
        started.resolve();
        await release.promise;
        try {
          return await answer(input);
        } finally {
          active--;
        }
      },
    });
    try {
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      release.resolve();
      expect((await pending).labelled).toBe(8);
      expect(peak).toBeGreaterThan(8);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("pairs two same-owner statement legs clean only after both are labelled, then applies once", async () => {
    const member = await owner("Synthetic member");
    await account(
      "Synthetic checking",
      member,
      checking,
      "synthetic-account-a",
    );
    const to = await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 180,
        description: "ONLINE TRANSFER TO SAVINGS",
        providerAccountId: "synthetic-account-b",
        status: null,
      },
      {
        account: "Synthetic savings",
        date: "2026-05-05",
        amount: -180,
        description: "ONLINE TRANSFER FROM CHECKING",
        status: "pending",
      },
    ]);

    expect(await discoverTransferPairs(ctx.db)).toEqual([]);
    const from = await account(
      "Synthetic checking",
      member,
      checking,
      "synthetic-account-b",
    );
    const [raw] = await discoverTransferPairs(ctx.db);
    expect(raw).toMatchObject({
      outflow: {
        accountId: from,
        origin: "statement",
        amount: 180,
        movement: "weak",
        movementLabel: null,
      },
      inflow: { accountId: to, origin: "statement", amount: -180 },
      amount: 180,
      date: "2026-05-04",
      dateGapDays: 1,
      move: "internal",
      clean: false,
      blockers: ["weak_movement"],
    });

    await refresh();
    const [published] = await pending();
    expect(published!.judgment).toMatchObject({
      key: raw!.key,
      clean: true,
      blockers: [],
      outflow: {
        movement: "explicit",
        movementLabel: { choice: "account_move", confidence: "high" },
      },
      inflow: { movement: "explicit" },
    });
    expect(published!.fingerprint).toBe(
      await fingerprintTransferPair(published!.judgment),
    );
    // Labels ride on top of the rule evidence rather than replacing it.
    expect(await transferPairEvidenceFingerprint(published!.judgment)).toBe(
      await transferPairEvidenceFingerprint(raw!),
    );
    expect(
      await findTransferPairForCharge(
        ctx.db,
        published!.judgment.outflow.charge!,
      ),
    ).toEqual({
      key: raw!.key,
      fingerprint: published!.fingerprint,
      clean: true,
    });

    const result = await apply(published!);
    const legs = await liveTransactions();
    expect(legs.map((leg) => Number(leg.amount)).sort((a, b) => a - b)).toEqual(
      [-180, 180],
    );
    expect(new Set(legs.map((leg) => leg.ledgerTransferId)).size).toBe(1);
    expect(
      legs
        .map((leg) => ({
          amount: leg.amount,
          status: leg.status,
          postedDate: leg.postedDate,
        }))
        .sort((a, b) => a.amount - b.amount),
    ).toEqual([
      { amount: -180, status: "pending", postedDate: null },
      { amount: 180, status: "observed", postedDate: null },
    ]);
    const claimed = await unwrapDb(ctx.db)
      .select({ account: financialAccount.shortcode })
      .from(financialTransaction)
      .leftJoin(
        financialAccount,
        eq(financialAccount.id, financialTransaction.accountId),
      )
      .where(eq(financialTransaction.shortcode, result.outflowTransactionId));
    expect(claimed).toEqual([{ account: from }]);
    const [move] = await transfers();
    expect(move!.fromPartyId).toBe(move!.toPartyId);
    expect(result.transferId).toMatch(/^LTR-/);

    // Replay of the same accept: the legs are paired, so nothing pairs again.
    await expect(apply(published!)).rejects.toThrow(/no longer a candidate/);
    expect(await transfers()).toHaveLength(1);
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    expect(await pending()).toEqual([]);
    expect(await discoverTransferPairs(ctx.db)).toEqual([]);
    expect(await currentTransferPair(ctx.db, raw!.key)).toBeNull();
  });

  it("never pairs a check filed under Transfer clean, while a labelled real transfer is", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const wallet = await account("Synthetic wallet", member, {
      kind: "stored_value",
      provider: "Example Pay",
    });
    const reserve = await account("Synthetic savings", member, savings);
    // The check is recorded as a transfer and its category says Transfer.
    await transaction(bank, 75, "2026-05-10", { rawDescription: "CHECK 1042" });
    await statement([
      {
        account: "Synthetic wallet",
        date: "2026-05-11",
        amount: -75,
        description: "Synthetic Friend repayment",
      },
      {
        account: "Synthetic checking",
        date: "2026-05-12",
        amount: 300,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-12",
        amount: -300,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const [check] = await pendingOn(wallet);
    expect(check!.judgment).toMatchObject({
      clean: false,
      outflow: {
        origin: "transaction",
        signals: { kind: "account_transfer", providerCategory: "Transfer" },
        movement: "weak",
      },
      inflow: { movement: "weak" },
    });
    expect(check!.judgment.blockers).toContain("weak_movement");
    await expect(apply(check!)).rejects.toThrow(/review/i);
    expect(await transfers()).toEqual([]);
    expect(await liveTransactions()).toHaveLength(1);

    const [real] = await pendingOn(reserve);
    expect(real!.judgment.clean).toBe(true);
  });

  it("keeps a confidently labelled cross-owner pair out of clean and applies it only on review", async () => {
    const payer = await owner("Synthetic member A");
    const payee = await owner("Synthetic member B");
    await account("Synthetic checking", payer);
    await account("Synthetic brokerage", payee, {
      kind: "other",
      institution: "Example Brokerage",
    });
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-06-01",
        amount: 900,
        description: "ONLINE TRANSFER TO BROKERAGE",
      },
      {
        account: "Synthetic brokerage",
        date: "2026-06-02",
        amount: -900,
        description: "TRANSFER RECEIVED",
      },
    ]);
    await refresh();
    const [pair] = await pending();
    expect(pair!.judgment).toMatchObject({
      move: "between_owners",
      clean: false,
      outflow: { movement: "explicit" },
      inflow: { movement: "explicit" },
      apply: { available: true },
    });
    expect(pair!.judgment.blockers).toEqual(["owners_differ"]);
    await expect(apply(pair!)).rejects.toThrow(/review/i);
    expect(await liveTransactions()).toEqual([]);

    await apply(pair!, true);
    const [move] = await transfers();
    expect(move!.fromPartyId).toBe(await partyUuid(payer));
    expect(move!.toPartyId).toBe(await partyUuid(payee));
    expect(Number(move!.amount)).toBe(900);
  });

  it("treats medium-confidence movement labels as weak", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 40,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -40,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh(byDescriptor, 0.6);
    const [pair] = await pending();
    expect(pair!.judgment.clean).toBe(false);
    expect(pair!.judgment.blockers).toEqual(["weak_movement"]);
  });

  it("requires mutual uniqueness, counting weak competitors, and a date gap of three days or less", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const second = await account("Synthetic second checking", member);
    const reserve = await account("Synthetic savings", member, savings);
    await account("Synthetic card", member, {
      kind: "credit_card",
      issuer: null,
      network: "visa",
    });
    await statement([
      // A weak refund on another account competes for the savings inflow.
      {
        account: "Synthetic checking",
        date: "2026-06-01",
        amount: 250,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-06-02",
        amount: -250,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic card",
        date: "2026-06-03",
        amount: -250,
        description: "EXAMPLE STORE RETURN",
        category: "Shopping",
      },
      // Four days apart: still a candidate, never clean. Six: no candidate.
      {
        account: "Synthetic checking",
        date: "2026-06-10",
        amount: 90,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-06-14",
        amount: -90,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic checking",
        date: "2026-06-20",
        amount: 60,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-06-26",
        amount: -60,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      // Two outflows from different accounts compete for one inflow.
      {
        account: "Synthetic checking",
        date: "2026-07-01",
        amount: 120,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic second checking",
        date: "2026-07-01",
        amount: 120,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-07-02",
        amount: -120,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const pairs = await pendingOn(reserve);
    const of = (amount: number) =>
      pairs.filter(({ judgment }) => judgment.amount === amount);

    const [competed] = of(250).filter(
      ({ judgment }) => judgment.outflow.accountId === bank,
    );
    expect(competed!.judgment.clean).toBe(false);
    expect(competed!.judgment.blockers).toContain("competing_candidates");
    expect(competed!.judgment.competitors).toMatchObject([
      {
        against: "outflow",
        leg: { amount: -250, movement: "weak" },
        dateGapDays: 2,
      },
    ]);

    const [distant] = of(90);
    expect(distant!.judgment).toMatchObject({ dateGapDays: 4, clean: false });
    expect(distant!.judgment.blockers).toEqual(["date_gap"]);
    expect(of(60)).toEqual([]);

    const shared = of(120);
    expect(
      shared.map(({ judgment }) => judgment.outflow.accountId).sort(),
    ).toEqual([bank, second].sort());
    for (const { judgment } of shared) {
      expect(judgment.clean).toBe(false);
      expect(judgment.competitors).toMatchObject([{ against: "inflow" }]);
    }
  });

  it("reviews an unowned pair but refuses to apply it", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", null, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 55,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -55,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const [pair] = await pending();
    expect(pair!.judgment).toMatchObject({
      move: "unowned",
      clean: false,
      inflow: { owner: null },
      apply: { available: false },
    });
    expect(pair!.judgment.blockers).toContain("owner_missing");
    await expect(apply(pair!, true)).rejects.toThrow(/owner/i);
    expect(await liveTransactions()).toEqual([]);
  });

  it("offers a review-only full-amount cash leg on the owner's one cash account", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const cash = await account("Synthetic cash", member, { kind: "cash" });
    const crowded = await owner("Synthetic member with two wallets");
    await account("Synthetic crowded checking", crowded);
    await account("Synthetic cash one", crowded, { kind: "cash" });
    await account("Synthetic cash two", crowded, { kind: "cash" });
    await statement([
      // The bank amount includes the ATM fee.
      {
        account: "Synthetic checking",
        date: "2026-07-01",
        amount: 203,
        description: "ATM WITHDRAWAL 0001",
        category: "Cash & ATM",
      },
      {
        account: "Synthetic crowded checking",
        date: "2026-07-01",
        amount: 103,
        description: "ATM WITHDRAWAL 0002",
        category: "Cash & ATM",
      },
    ]);
    await refresh();
    const pairs = await pending();
    expect(pairs).toHaveLength(1);
    const [pair] = pairs;
    expect(pair!.judgment).toMatchObject({
      outflow: { accountId: bank, origin: "statement", amount: 203 },
      inflow: {
        accountId: cash,
        origin: "cash",
        accountKind: "cash",
        amount: -203,
        transactionId: null,
        refs: [],
      },
      amount: 203,
      move: "internal",
      clean: false,
      apply: { available: true },
    });
    expect(pair!.judgment.blockers).toContain("cash_leg_missing");
    await expect(apply(pair!)).rejects.toThrow(/review/i);

    await apply(pair!, true);
    const legs = await liveTransactions();
    // One cash leg for the full amount; the fee is never inferred.
    expect(legs.map((leg) => Number(leg.amount)).sort((a, b) => a - b)).toEqual(
      [-203, 203],
    );
    expect(legs.find((leg) => Number(leg.amount) === -203)!.kind).toBe(
      "account_transfer",
    );
    expect(new Set(legs.map((leg) => leg.ledgerTransferId)).size).toBe(1);
  });

  it("pairs a hand-entered cash leg as a recorded transaction instead of offering another", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const cash = await account("Synthetic cash", member, { kind: "cash" });
    await transaction(bank, 100, "2026-07-03", {
      rawDescription: "ATM WITHDRAWAL 0003",
      sourceCategory: "Cash & ATM",
    });
    await transaction(cash, -100, "2026-07-03", {
      rawDescription: "Cash from the ATM",
      sourceCategory: null,
    });
    const pairs = await discoverTransferPairs(ctx.db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      outflow: { accountId: bank, origin: "transaction" },
      inflow: { accountId: cash, origin: "transaction" },
    });
  });

  it("blocks clean and creation on an overlapping export until observations converge on one transaction", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const reserve = await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-08-03",
        amount: 400,
        description: "ONLINE TRANSFER TO SAVINGS 7788",
      },
      {
        account: "Synthetic savings",
        date: "2026-08-04",
        amount: -400,
        description: "ONLINE TRANSFER FROM CHECKING 7788",
      },
    ]);
    // The same checking outflow, exported again by another source.
    await statement(
      [
        {
          account: "Synthetic checking",
          date: "2026-08-04",
          amount: 400,
          description: "Online Transfer to Savings",
        },
      ],
      { source: "copilot" },
    );
    await refresh();
    const pairs = await pendingOn(reserve);
    expect(pairs).toHaveLength(2);
    for (const pair of pairs) {
      expect(pair.judgment.clean).toBe(false);
      expect(pair.judgment.blockers).toEqual(
        expect.arrayContaining(["unresolved_overlap", "competing_candidates"]),
      );
      expect(pair.judgment.outflow.overlaps).toHaveLength(1);
      expect(pair.judgment.apply.available).toBe(false);
      await expect(apply(pair, true)).rejects.toThrow(/overlap|statement/i);
    }
    expect(await liveTransactions()).toEqual([]);

    // Statement review converged both observations on one transaction.
    const observed = await unwrapDb(ctx.db)
      .select({
        source: sourceTransactionRecord.source,
        externalId: sourceTransactionRecord.externalId,
      })
      .from(sourceTransactionRecord)
      .where(
        eq(sourceTransactionRecord.accountDescriptor, "Synthetic checking"),
      );
    await transaction(bank, 400, "2026-08-03", {
      rawDescription: "ONLINE TRANSFER TO SAVINGS 7788",
      sourceRefs: observed,
    });
    await refresh();
    const [converged, ...rest] = await pendingOn(reserve);
    expect(rest).toEqual([]);
    expect(converged!.judgment).toMatchObject({
      outflow: { origin: "transaction", overlaps: [] },
      inflow: { origin: "statement", overlaps: [] },
      competitors: [],
      clean: true,
    });
  });

  // A changed amount with the same provider identity must reconcile with the
  // recorded leg before a pair can create another transaction for it.
  it("holds amount corrections with existing provider identity for reconciliation", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-08-03",
        amount: 175,
        description: "ONLINE TRANSFER TO SAVINGS",
        providerTransactionId: "synthetic-provider-move",
      },
    ]);
    const [observed] = await unwrapDb(ctx.db)
      .select({
        source: sourceTransactionRecord.source,
        externalId: sourceTransactionRecord.externalId,
      })
      .from(sourceTransactionRecord);
    const recorded = await transaction(bank, 175, "2026-08-03", {
      sourceRefs: [observed!],
      rawDescription: "ONLINE TRANSFER TO SAVINGS",
    });
    const revision = await statement([
      {
        account: "Synthetic checking",
        date: "2026-08-04",
        amount: 180,
        description: "ONLINE TRANSFER TO SAVINGS",
        providerTransactionId: "synthetic-provider-move",
      },
      {
        account: "Synthetic savings",
        date: "2026-08-04",
        amount: -180,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    expect(await discoverTransferPairs(ctx.db)).toEqual([]);
    expect(revision.correctionReviews).toMatchObject([
      { transactionId: recorded.id, reason: expect.any(String) },
    ]);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const review = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      limit: 50,
    });
    expect(
      review.items.flatMap((item) =>
        item.family === "statement_transaction" && item.evidence.reviewReason
          ? [item.evidence.reviewReason]
          : [],
      ),
    ).toEqual([expect.stringContaining("amount changed")]);
    expect(await liveTransactions()).toMatchObject([
      { amount: 175, status: "posted" },
    ]);
    expect(await transfers()).toEqual([]);
  });

  it("refuses a stale accept and leaves no created leg behind", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 70,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-05",
        amount: -70,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const [pair] = await pending();
    expect(pair!.judgment.clean).toBe(true);
    // A new competitor arrives after publication.
    await transaction(
      await account("Synthetic second checking", member),
      70,
      "2026-05-05",
    );
    await expect(apply(pair!)).rejects.toThrow(/changed|refresh/i);
    expect(await liveTransactions()).toHaveLength(1);
    expect(await transfers()).toEqual([]);
  });

  it("pairs a shared leg once when two reviewed accepts race", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await account("Synthetic brokerage", member, {
      kind: "other",
      institution: "Example Brokerage",
    });
    await transaction(bank, 500, "2026-09-01");
    await statement([
      {
        account: "Synthetic savings",
        date: "2026-09-02",
        amount: -500,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic brokerage",
        date: "2026-09-02",
        amount: -500,
        description: "TRANSFER RECEIVED",
      },
    ]);
    await refresh();
    const pairs = await pendingOn(bank);
    expect(pairs).toHaveLength(2);
    const rows = (await listSuggestionPage(ctx.db, { family: "transfer_pair" }))
      .items;
    const results = await Promise.allSettled(
      rows.map((row) =>
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: row.assessmentId,
          operationId: crypto.randomUUID(),
          expectedFingerprint: row.fingerprint!,
          verdict: "correct",
          intent: "apply",
          application: { kind: "transfer_pair" },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" ? String(loser.reason) : "").toMatch(
      /stale|no longer|candidate|changed/i,
    );
    expect(await transfers()).toHaveLength(1);
    // The checking leg plus exactly one created inflow; the loser rolled back.
    expect(await liveTransactions()).toHaveLength(2);
  });

  it("excludes expected transactions, allocated, already-paired and soft-deleted legs and deleted accounts or owners", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const reserve = await account("Synthetic savings", member, savings);
    const gone = await owner("Synthetic departed member");
    const orphaned = await account("Synthetic orphaned checking", gone);
    const closed = await account("Synthetic closed checking", member);
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic vendor",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output!.id,
    });
    const paired = await transaction(bank, 11, "2026-05-01");
    await transaction(reserve, -11, "2026-05-01");
    await transaction(bank, 12, "2026-05-02", {
      status: "expected",
      postedDate: null,
    });
    await transaction(bank, 13, "2026-05-03", {
      kind: "purchase",
      purchaseId: purchase.output!.id,
    });
    const deleted = await transaction(bank, 14, "2026-05-04");
    await transaction(orphaned, 15, "2026-05-05");
    await transaction(closed, 16, "2026-05-06");
    await statement([
      {
        account: "Synthetic savings",
        date: "2026-05-02",
        amount: -12,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-03",
        amount: -13,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -14,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-05",
        amount: -15,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-06",
        amount: -16,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    // Soft deletes, set directly: the exclusions are the read's, not the writer's.
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "deletedAt" = now() WHERE shortcode = ${deleted.id}`,
    );
    await unwrapDb(ctx.db)
      .update(ledgerParty)
      .set({ deletedAt: new Date() })
      .where(eq(ledgerParty.shortcode, gone));
    await unwrapDb(ctx.db)
      .update(financialAccount)
      .set({ deletedAt: new Date() })
      .where(eq(financialAccount.shortcode, closed));
    const found = await discoverTransferPairs(ctx.db);
    expect(found.map((pair) => pair.amount)).toEqual([11]);
    const result = await applyTransferPair(ctx.db, kernelCtx(ctx), {
      key: found[0]!.key,
      expectedFingerprint: await fingerprintTransferPair(found[0]!),
      reviewed: true,
    });
    expect(result.outflowTransactionId).toBe(paired.id);
    expect(await discoverTransferPairs(ctx.db)).toEqual([]);
  });

  it("creates a statement leg with every observation's settlement ref", async () => {
    const member = await owner("Synthetic member");
    const checking = await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    const rows: Row[] = [
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 33,
        description: "ONLINE TRANSFER TO SAVINGS",
        providerTransactionId: "synthetic-reexport-transfer",
      },
    ];
    // One charge, exported twice by the same source.
    await statement(rows, { fingerprint: "synthetic-first-export" });
    await statement(
      rows.map((row) => ({
        ...row,
        description: "ONLINE TRANSFER TO SAVINGS UPDATED",
      })),
      { fingerprint: "synthetic-second-export" },
    );
    await statement([
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -33,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    const [pair] = await discoverTransferPairs(ctx.db);
    const observed = await unwrapDb(ctx.db)
      .select({
        externalId: sourceTransactionRecord.externalId,
        legacy: sourceTransactionRecord.legacyReference,
      })
      .from(sourceTransactionRecord)
      .where(
        eq(sourceTransactionRecord.accountDescriptor, "Synthetic checking"),
      );
    expect(observed).toHaveLength(2);
    expect(pair!.outflow.refs.map((ref) => ref.externalId).sort()).toEqual(
      [
        ...new Set([
          ...observed.map((row) => row.externalId),
          ...observed.flatMap((row) => (row.legacy ? [row.legacy] : [])),
        ]),
      ].sort(),
    );
    const result = await applyTransferPair(ctx.db, kernelCtx(ctx), {
      key: pair!.key,
      expectedFingerprint: await fingerprintTransferPair(pair!),
      reviewed: true,
    });
    const outflowId = (
      await unwrapDb(ctx.db)
        .select({ id: financialTransaction.id })
        .from(financialTransaction)
        .where(eq(financialTransaction.shortcode, result.outflowTransactionId))
    )[0]!.id;
    const refs =
      (await settlementRefsFor(ctx.db, [outflowId])).get(outflowId) ?? [];
    expect(refs.map((ref) => ref.externalId).sort()).toEqual(
      pair!.outflow.refs.map((ref) => ref.externalId).sort(),
    );
    // Settlement must also claim every observation's account, as a statement create does.
    const claimed = await unwrapDb(ctx.db)
      .select({ account: financialAccount.shortcode })
      .from(sourceTransactionRecord)
      .leftJoin(
        financialAccount,
        eq(financialAccount.id, sourceTransactionRecord.accountId),
      )
      .where(
        eq(sourceTransactionRecord.accountDescriptor, "Synthetic checking"),
      );
    expect(claimed.map((row) => row.account)).toEqual(
      observed.map(() => checking),
    );
    expect(
      parseShortcodeFor("financialTransaction", result.inflowTransactionId),
    ).toBeTruthy();
  });

  it("republishes unchanged evidence without dropping its labels", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 21,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -21,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const before = await pending();
    const again = await generateTransferPairSuggestions(ctx.db, {
      runId: null,
    });
    expect(again.published).toBe(0);
    expect(await pending()).toEqual(before);
    expect(before[0]!.judgment.clean).toBe(true);
  });

  it("labels a pair a later Run rediscovers unchanged, after an earlier Run left it unlabelled", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 44,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -44,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    // The first Run publishes with automatic AI work off: no label pass.
    const first = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    await generateTransferPairSuggestions(ctx.db, { runId: first });
    const second = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const again = await generateTransferPairSuggestions(ctx.db, {
      runId: second,
    });
    expect(again.published).toBe(0);
    expect(
      await countTransferPairsNeedingLabels(ctx.db, { runId: first }),
    ).toBe(0);
    expect(
      await countTransferPairsNeedingLabels(ctx.db, { runId: second }),
    ).toBe(1);
    const labelled = await labelTransferPairSuggestions(ctx.db, {
      runId: second,
      port: movementPort(byDescriptor),
    });
    expect(labelled.labelled).toBe(1);
    const [pair] = await pending();
    expect(pair!.judgment.clean).toBe(true);
  });

  it("labels structurally blocked pairs for review but never pairs whose apply is unavailable", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", null, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 66,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -66,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    expect(await countTransferPairsNeedingLabels(ctx.db)).toBe(0);
    const [pair] = await pending();
    expect(pair!.judgment.outflow.movementLabel).toBeNull();
  });
});
