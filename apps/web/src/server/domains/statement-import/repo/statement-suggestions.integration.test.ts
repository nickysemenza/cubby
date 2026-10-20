import type { FinancialTransactionKind } from "@cubby/schemas/financial-transaction";
import {
  recordStatementRowsInput,
  type StatementImportInput,
  type StatementRowInput,
} from "@cubby/schemas/statement-row";
import type {
  StatementSuggestionOut,
  StatementTransactionApplication,
} from "@cubby/schemas/statement-suggestion";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb } from "~/server/db/helpers";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { answering } from "~/server/domains/statement-import/repo/statement-decision-port.fixtures";
import * as statementSuggestionsRepo from "~/server/domains/statement-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
} from "~/server/generic/assessment/repo/suggestion-list";
import { processStatementRetirementPage } from "~/server/generic/derived-refresh/repo/statement-retirement";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import {
  getStatementRowSummary,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "./statement-row";
import {
  buildChargeProposals,
  generateStatementSuggestionPage,
  labelledProposal,
  publishChargeProposal,
  pendingPostedMatch,
} from "./statement-suggestions";

const importInput = (
  overrides: Partial<StatementImportInput> = {},
): StatementImportInput => ({
  source: "monarch",
  label: "synthetic-export.csv",
  fingerprint: "fp-suggest-1",
  dateKind: "posted" as const,
  rowCountDeclared: null,
  notes: null,
  ...overrides,
});

let position = 0;
const rowInput = (
  overrides: Partial<StatementRowInput> = {},
): StatementRowInput => ({
  accountDescriptor: "Synthetic Card (...4242)",
  statementDate: "2026-05-04",
  providerAmount: -42.5,
  merchant: "Example Grocer",
  rawDescription: "EXAMPLE GROCER 0001",
  sourceCategory: "Groceries",
  providerStatus: "posted" as const,
  providerNotes: null,
  rowPosition: ++position,
  ...overrides,
});

type Ctx = ReturnType<typeof withTestDb>;

const record = (
  ctx: Ctx,
  rows: StatementRowInput[],
  importOverrides: Partial<StatementImportInput> = {},
) =>
  recordStatementRows(
    ctx.db,
    recordStatementRowsInput.parse({
      import: importInput(importOverrides),
      rows,
    }),
    ctx.actor,
  );

const card = (ctx: Ctx) =>
  createRepoEntity(ctx, "financialAccount", {
    name: "Synthetic Card",
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [
      {
        source: "monarch",
        alias: "Synthetic Card (...4242)",
        externalAccountId: null,
      },
    ],
  });

const generate = async (ctx: Ctx) => {
  let after = null as Parameters<
    typeof generateStatementSuggestionPage
  >[1]["after"];
  let published = 0;
  for (;;) {
    const page = await generateStatementSuggestionPage(ctx.db, {
      after,
      runId: null,
    });
    published += page.published;
    if (!page.next) return published;
    after = page.next;
  }
};

/** Pending statement rows of the cross-family list, newest charge first. */
const suggestions = async (ctx: Ctx) =>
  (
    await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      limit: 200,
    })
  ).items
    .flatMap((row) =>
      row.family === "statement_transaction" ? [row.evidence] : [],
    )
    .sort(
      (a, b) =>
        b.statementDate.localeCompare(a.statementDate) ||
        a.assessmentId.localeCompare(b.assessmentId),
    );

const accept = (
  ctx: Ctx,
  suggestion: StatementSuggestionOut,
  overrides: Partial<StatementTransactionApplication> = {},
  corrected = false,
) => {
  const application = {
    kind: "statement_transaction" as const,
    action: suggestion.recommended,
    fields: [],
    rejectedCandidateIds: [],
    ...overrides,
  };
  return reviewAssessment(ctx.db, kernelCtx(ctx), {
    assessmentId: suggestion.assessmentId,
    operationId: crypto.randomUUID(),
    verdict: corrected ? "wrong" : "correct",
    correction: corrected
      ? { present: true, value: application }
      : { present: false },
    intent: "apply",
    expectedFingerprint: suggestion.fingerprint,
    application,
  });
};

const stateOf = async (ctx: Ctx, assessmentId: string) =>
  (
    await getDb(ctx.db).execute<{ status: string; active: boolean }>(
      sql`SELECT status, active FROM "AssessmentState" WHERE id = ${assessmentId}::uuid`,
    )
  ).rows[0];

const label = async (ctx: Ctx, port: DecisionPort) =>
  labelStatementSuggestions(ctx.db, {
    port,
    runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
  });

describe("statement Transaction suggestions", () => {
  const ctx = withTestDb();

  // Failure mode: pages build many charges at once while accept rebuilds one,
  // so any batch-dependent evidence (unordered holds, another account's rows)
  // makes every bulk-built suggestion fail as stale.
  it("builds a page of charges exactly as it builds each one alone", async () => {
    const account = (await card(ctx)).output;
    await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic Debit",
      identity: {
        kind: "bank_account",
        institution: "Synthetic Bank",
        accountType: "checking",
      },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic Debit (...1111)",
          externalAccountId: null,
        },
      ],
    });
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceRefs: [],
    });
    for (const day of ["2026-04-28", "2026-04-29", "2026-04-30"])
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "pending",
        amount: 15,
        transactionDate: day,
        merchant: "Example Bistro",
        rawDescription: "EXAMPLE BISTRO PENDING",
        sourceRefs: [],
      });
    await record(ctx, [
      rowInput(),
      rowInput({
        providerAmount: -15,
        statementDate: "2026-05-01",
        merchant: "Example Bistro",
        rawDescription: "EXAMPLE BISTRO",
        sourceCategory: "Restaurants & Bars",
      }),
      rowInput({
        providerAmount: -15,
        statementDate: "2026-05-02",
        merchant: "Example Bistro",
        rawDescription: "EXAMPLE BISTRO",
        sourceCategory: "Restaurants & Bars",
      }),
      rowInput({
        accountDescriptor: "Synthetic Debit (...1111)",
        providerAmount: -6.25,
        merchant: "Example Cafe",
        rawDescription: "EXAMPLE CAFE",
        sourceCategory: "Coffee Shops",
      }),
    ]);
    const { rows } = await getDb(ctx.db).execute<{
      source: string;
      chargeKey: string;
    }>(
      sql`SELECT source, COALESCE("legacyExternalId", "externalId") AS "chargeKey" FROM "StatementRow" WHERE "deletedAt" IS NULL`,
    );
    const charges = rows.map(({ source, chargeKey }) => ({
      source,
      chargeKey,
    }));
    const batch = await buildChargeProposals(ctx.db, charges);
    const single = await Promise.all(
      charges.map(
        async (charge) => (await buildChargeProposals(ctx.db, [charge]))[0]!,
      ),
    );
    const view = (proposals: typeof batch) =>
      Object.fromEntries(
        proposals.map((proposal) => [
          proposal.charge.chargeKey,
          [proposal.fingerprint, proposal.evidenceFingerprint],
        ]),
      );
    expect(batch).toHaveLength(4);
    expect(view(batch)).toEqual(view(single));
  });

  // Failure modes: a re-export doubles the suggestion; an ignore recorded on
  // one observation leaves the other on the worklist; re-generation republishes
  // unchanged evidence.
  it("publishes one suggestion per charge and inherits decisions across observations", async () => {
    await card(ctx);
    const grocery = rowInput();
    const coffee = rowInput({
      providerAmount: -6.25,
      merchant: "Example Cafe",
      rawDescription: "EXAMPLE CAFE",
      sourceCategory: "Coffee Shops",
    });
    await record(ctx, [grocery, coffee]);
    // The full-history re-export observes both charges again.
    await record(
      ctx,
      [
        { ...grocery, rowPosition: 10 },
        { ...coffee, rowPosition: 11 },
      ],
      { fingerprint: "fp-suggest-2" },
    );
    expect(
      await getStatementRowSummary(ctx.db, { matchState: "unmatched" }),
    ).toMatchObject({ unmatched: 4, unmatchedCharges: 2 });

    expect(await generate(ctx)).toBe(2);
    expect(await generate(ctx)).toBe(0);
    const queue = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({ pageSize: 100 }),
      false,
    );
    // The household's Work has one row for the family, opening the
    // Suggestions page; the account's own Work counts its own.
    expect(
      queue.items.filter(
        (row) => row.suggestionFamily === "statement_transaction",
      ),
    ).toEqual([
      expect.objectContaining({
        entity: null,
        id: null,
        // A category rule is one vote: nothing is clean before a label.
        reason: "2 transaction suggestions (0 ready to accept)",
      }),
    ]);
    const [first] = (await suggestions(ctx)).filter(
      (row) => row.merchant === "Example Cafe",
    );
    expect(first).toMatchObject({ recommended: "create", clean: false });
    expect(first?.create?.kind).toBe("purchase");

    const rows = await listStatementRows(ctx.db, { search: "EXAMPLE CAFE" });
    await updateStatementRows(
      ctx.db,
      {
        selector: {
          source: "monarch",
          externalIds: [rows.data[0]!.externalId],
        },
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Synthetic coffee is not modeled.",
        },
      },
      ctx.actor,
    );
    expect(
      (await listStatementRows(ctx.db, { search: "EXAMPLE CAFE" })).data.map(
        (row) => row.matchState,
      ),
    ).toEqual(["ignored", "ignored"]);
    // Retirement follows the authoritative ignore through the background cursor.
    await processStatementRetirementPage(ctx.db);
    expect(await stateOf(ctx, first!.assessmentId)).toMatchObject({
      status: "superseded",
      active: false,
    });
    expect((await suggestions(ctx)).map((row) => row.merchant)).toEqual([
      "Example Grocer",
    ]);
  });

  // Failure modes: the settlement-ref trigger supersedes the suggestion being
  // applied; a second accept creates a twin; the row stays unmatched.
  it("creates the transaction, ends applied, and refuses a replay", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    const outcome = await accept(ctx, suggestion!);
    expect(outcome).toMatchObject({ status: "applied", applied: true });
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "applied",
      active: true,
    });
    const [row] = (await listStatementRows(ctx.db, {})).data;
    expect(row).toMatchObject({ matchState: "matched" });
    expect(row?.accountId).toMatch(/^FAC-/);
    await expect(accept(ctx, suggestion!)).rejects.toThrow(
      /already resolved|no longer pending/,
    );
    expect(await suggestions(ctx)).toEqual([]);
  });

  // Failure modes: a differently described transaction on the same day and
  // amount is missed and a twin is offered; a create is accepted while a
  // candidate is live.
  it("offers an attach across descriptors and only creates after the candidate is rejected", async () => {
    const account = (await card(ctx)).output;
    const existing = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        postedDate: "2026-05-05",
        merchant: "Older import label",
        rawDescription: "EXMPL GRCR #1 SYNTHETIC",
        sourceRefs: [],
      })
    ).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    expect(suggestion).toMatchObject({
      recommended: "attach",
      clean: false,
      candidates: [{ transactionId: existing.id, diff: ["postedDate"] }],
    });
    await expect(
      accept(ctx, suggestion!, { action: "create" }, true),
    ).rejects.toThrow(/must be rejected before creating/);
    await accept(ctx, suggestion!, {
      transactionId: existing.id,
      fields: ["postedDate"],
    });
    const [row] = (await listStatementRows(ctx.db, {})).data;
    expect(row).toMatchObject({
      matchState: "matched",
      transactionId: existing.id,
    });
  });

  // Failure modes: two reviews racing on evidence that changed both succeed.
  it("refuses an accept after the evidence changed", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    // A new transaction appears nearby without the ref: the proposal is stale.
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceRefs: [],
    });
    await expect(accept(ctx, suggestion!)).rejects.toThrow(/evidence changed/);
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "pending",
    });
  });

  // Failure modes: a dismissed charge returns on the next pass.
  it("keeps a dismissed charge dismissed", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: suggestion!.assessmentId,
      operationId: crypto.randomUUID(),
      verdict: "dismissed",
      correction: { present: false },
      intent: "history",
      suppression: {
        scope: "statement_transaction",
        candidateKey: `${suggestion!.source}:${suggestion!.chargeKey}`,
        fingerprint: suggestion!.fingerprint,
      },
    });
    expect(await suggestions(ctx)).toEqual([]);
    expect(await generate(ctx)).toBe(0);
  });

  // Failure modes: a hold's posted twin (tip added, later date) becomes a
  // second transaction; the pending row stays on the worklist.
  it("supersedes a recorded hold with its posted row", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        providerStatus: "pending",
        providerAmount: -40,
        statementDate: "2026-05-01",
        rawDescription: "EXAMPLE BISTRO PENDING",
        sourceCategory: "Restaurants & Bars",
      }),
    ]);
    await generate(ctx);
    const [hold] = await suggestions(ctx);
    expect(hold).toMatchObject({
      recommended: "create",
      providerStatus: "pending",
    });
    expect(hold?.create).toMatchObject({ status: "pending", postedDate: null });
    await accept(ctx, hold!);

    await record(
      ctx,
      [
        rowInput({
          providerAmount: -48,
          statementDate: "2026-05-03",
          rawDescription: "EXAMPLE BISTRO",
          sourceCategory: "Restaurants & Bars",
        }),
      ],
      { fingerprint: "fp-suggest-posted" },
    );
    await generate(ctx);
    const [posted] = await suggestions(ctx);
    expect(posted).toMatchObject({
      recommended: "supersede",
      clean: false,
      supersedeTransactionId: expect.stringMatching(/^FTX-/),
      // The hold's own pending refs never read as another charge's claim.
      candidates: [expect.objectContaining({ claimed: false })],
    });
    await accept(ctx, posted!);
    const states = Object.fromEntries(
      (await listStatementRows(ctx.db, {})).data.map((row) => [
        row.rawDescription,
        row.matchState,
      ]),
    );
    expect(states).toEqual({
      "EXAMPLE BISTRO": "matched",
      "EXAMPLE BISTRO PENDING": "superseded",
    });
  });

  it("bounds the pending-to-posted tolerance", () => {
    const hold = { amount: 40, date: "2026-05-01" };
    expect(pendingPostedMatch(hold, { amount: 60, date: "2026-05-03" })).toBe(
      true,
    );
    expect(
      pendingPostedMatch(hold, { amount: 60.01, date: "2026-05-03" }),
    ).toBe(false);
    expect(
      pendingPostedMatch(hold, { amount: 39.99, date: "2026-05-03" }),
    ).toBe(false);
    expect(pendingPostedMatch(hold, { amount: 40, date: "2026-05-09" })).toBe(
      false,
    );
  });

  // Failure modes: a hold that vanished keeps its pending transaction forever;
  // a void is offered before a covering export exists.
  it("proposes voiding a hold a later export no longer contains", async () => {
    await card(ctx);
    await record(
      ctx,
      [
        rowInput({
          providerStatus: "pending",
          providerAmount: -300,
          statementDate: "2026-05-01",
          rawDescription: "EXAMPLE HOTEL HOLD",
          sourceCategory: "Travel & Vacation",
        }),
      ],
      { fingerprint: "fp-hold" },
    );
    await generate(ctx);
    const [hold] = await suggestions(ctx);
    await accept(ctx, hold!);
    await generate(ctx);
    expect(await suggestions(ctx)).toEqual([]);

    await record(
      ctx,
      [
        rowInput({
          statementDate: "2026-05-12",
          rawDescription: "EXAMPLE GROCER 0002",
        }),
      ],
      { fingerprint: "fp-later" },
    );
    await generate(ctx);
    const voids = (await suggestions(ctx)).filter(
      (row) => row.recommended === "void",
    );
    expect(voids).toHaveLength(1);
    await processStatementRetirementPage(ctx.db);
    expect(await stateOf(ctx, voids[0]!.assessmentId)).toMatchObject({
      status: "pending",
      active: true,
    });
    await accept(ctx, voids[0]!);
    const transaction = await getDb(ctx.db).execute<{ status: string }>(
      sql`SELECT status FROM "FinancialTransaction" WHERE shortcode = ${voids[0]!.voidTransactionId}`,
    );
    expect(transaction.rows[0]?.status).toBe("void");
  });

  // Failure modes: a firmed-up descriptor from another export is two clean
  // creates, and bulk acceptance records the money twice.
  it("marks same-amount charges from another export as siblings, never clean", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE MKTPLACE PMTS" })]);
    await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE MKTPL*AB12CD34" })],
      { fingerprint: "fp-firmed" },
    );
    await generate(ctx);
    const rows = await suggestions(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.clean && row.siblings === 1)).toBe(true);
  });

  // Failure modes: a model "same" leaves a descriptor-different attach
  // unreviewable in bulk; a label silently changes the evidence fingerprint
  // the apply step checks.
  it("labels attach candidates and lets a confident same-charge attach go in bulk", async () => {
    const account = (await card(ctx)).output;
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Older import label",
      rawDescription: "EXMPL GRCR #1 SYNTHETIC",
      sourceRefs: [],
    });
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [rule] = await suggestions(ctx);
    expect(rule).toMatchObject({ recommended: "attach", clean: false });
    expect(
      await labelStatementSuggestions(ctx.db, {
        port: answering({ kind: "purchase", counterparty: "business" }),
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      }),
    ).toMatchObject({ labelled: 1 });
    const [labelled] = await suggestions(ctx);
    expect(labelled).toMatchObject({
      recommended: "attach",
      clean: true,
      candidates: [{ label: { same: "same", confidence: "high" } }],
    });
    expect(labelled!.model).not.toBeNull();
    expect(await stateOf(ctx, rule!.assessmentId)).toMatchObject({
      active: false,
    });
    // A rule pass over unchanged evidence keeps the labels.
    expect(await generate(ctx)).toBe(0);
    await accept(ctx, labelled!);
    expect((await listStatementRows(ctx.db, {})).data[0]).toMatchObject({
      matchState: "matched",
    });
  });

  // A page cap must preserve every candidate and every completed decision,
  // including a partial charge whose remaining labels need another page.
  it.each([false, true])(
    "checkpoints high-fanout work across a changed candidate roster: %s",
    async (addCandidate) => {
      const queue = captureBackgroundQueue();
      try {
        const account = (await card(ctx)).output;
        for (let index = 0; index < 5; index++)
          await createRepoEntity(ctx, "financialTransaction", {
            accountId: account.id,
            kind: "purchase",
            status: "posted",
            amount: 42.5,
            postedDate: "2026-05-05",
            rawDescription: `SYNTHETIC FANOUT CANDIDATE ${index}`,
            sourceRefs: [],
          });
        const observed = rowInput();
        await record(ctx, [observed]);
        await generate(ctx);
        const runId = await ensureRun(ctx.db, ctx.actor, {
          purpose: "background",
        });
        const seen: string[] = [];
        const answer = answering({
          kind: "purchase",
          counterparty: "business",
        });
        let pageCalls = 0;
        const port: DecisionPort = async (input) => {
          pageCalls++;
          seen.push(JSON.stringify(input));
          return answer(input);
        };
        let outcome = await labelStatementSuggestions(ctx.db, {
          runId,
          port,
          decisionLimit: 3,
        });
        expect(pageCalls).toBeLessThanOrEqual(3);
        expect(outcome.next).not.toBeNull();
        expect(outcome.labelled).toBe(0);
        if (addCandidate)
          await createRepoEntity(ctx, "financialTransaction", {
            accountId: account.id,
            kind: "purchase",
            status: "posted",
            amount: 42.5,
            postedDate: "2026-05-05",
            rawDescription: "SYNTHETIC LATER CANDIDATE",
            sourceRefs: [],
          });
        await record(
          ctx,
          [
            {
              ...observed,
              rowPosition: 20,
              providerNotes: "Synthetic checkpoint memo",
            },
          ],
          { fingerprint: "synthetic-checkpoint-reexport" },
        );
        await generate(ctx);
        for (let page = 0; page < 10 && outcome.next !== null; page++) {
          pageCalls = 0;
          outcome = await labelStatementSuggestions(ctx.db, {
            runId,
            port,
            after: outcome.next,
            decisionLimit: 3,
          });
          expect(pageCalls).toBeLessThanOrEqual(3);
          expect(outcome.failed).toEqual([]);
        }
        expect(outcome.next).toBeNull();
        const candidates = addCandidate ? 6 : 5;
        expect(seen).toHaveLength(candidates + 2);
        expect(new Set(seen).size).toBe(candidates + 2);
        const [complete] = await suggestions(ctx);
        expect(complete!.candidates).toHaveLength(candidates);
        expect(
          complete!.candidates.every((candidate) => candidate.label !== null),
        ).toBe(true);
        expect(complete!.create).toMatchObject({
          votes: { label: "purchase" },
          counterparty: { label: "business" },
        });
      } finally {
        queue.restore();
      }
    },
  );

  // Observation-only evidence churn must not discard paid labels or ask the
  // model again; the rebuilt judgment still uses the current evidence fence.
  it("keeps labels across a re-Sweep with unchanged model inputs", async () => {
    await card(ctx);
    const observed = rowInput();
    await record(ctx, [observed]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [before] = await suggestions(ctx);
    expect(before).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
      },
    });
    await record(
      ctx,
      [{ ...observed, rowPosition: 10, providerNotes: "Synthetic memo" }],
      {
        fingerprint: "synthetic-reexport",
      },
    );
    const regenerated = await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
    });
    expect(regenerated).toMatchObject({ processed: 1, labelsReused: 2 });
    let calls = 0;
    const outcome = await label(ctx, async () => {
      calls++;
      throw new Error("Unchanged model inputs must not be labelled again");
    });
    expect(calls).toBe(0);
    expect(outcome).toMatchObject({ labelled: 0, failed: [] });
    const [after] = await suggestions(ctx);
    expect(after).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
        notes: "Synthetic memo",
      },
      model: before!.model,
    });
    await accept(ctx, after!);
    expect(
      (await listStatementRows(ctx.db, {})).data.every(
        (row) => row.matchState === "matched",
      ),
    ).toBe(true);
  });

  // Prompt instructions are model inputs too; an obsolete producer revision
  // cannot be kept merely because the charge's evidence fingerprint matches.
  it("relabels an obsolete prompt revision even when evidence is unchanged", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [existing] = await suggestions(ctx);
    const [proposal] = await buildChargeProposals(ctx.db, [
      { source: existing!.source, chargeKey: existing!.chargeKey },
    ]);
    const judgment = structuredClone(proposal!.judgment);
    judgment.create!.votes.label = "purchase";
    judgment.create!.counterparty.label = "business";
    judgment.clean = true;
    await publishChargeProposal(
      ctx.db,
      await labelledProposal(proposal!, judgment),
      {
        kind: "model",
        model: "synthetic-decision-model",
        revision: "synthetic-obsolete-prompt",
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
        evaluationId: null,
      },
    );
    await generate(ctx);
    const [rebuilt] = await suggestions(ctx);
    expect(rebuilt).toMatchObject({
      model: null,
      clean: false,
      create: { votes: { label: null }, counterparty: { label: null } },
    });
    expect(
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      ),
    ).toMatchObject({ labelled: 1 });
  });

  // Both statement inputs and the candidate identity set participate in label
  // validity; retaining a previous clean result would permit stale bulk advice.
  it.each(["statement", "candidates"] as const)(
    "retires labels when %s model inputs change",
    async (changed) => {
      const account = (await card(ctx)).output;
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        postedDate: "2026-05-05",
        rawDescription: "SYNTHETIC PREVIOUS CANDIDATE",
        sourceRefs: [],
      });
      const observed = rowInput();
      await record(ctx, [observed]);
      await generate(ctx);
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      );
      if (changed === "statement") {
        await record(
          ctx,
          [
            {
              ...observed,
              rowPosition: 10,
              merchant: "Example Changed Merchant",
            },
          ],
          { fingerprint: "synthetic-changed-subject" },
        );
      } else {
        await createRepoEntity(ctx, "financialTransaction", {
          accountId: account.id,
          kind: "purchase",
          status: "posted",
          amount: 42.5,
          postedDate: "2026-05-05",
          rawDescription: "SYNTHETIC ADDITIONAL CANDIDATE",
          sourceRefs: [],
        });
      }
      await generate(ctx);
      const [rebuilt] = await suggestions(ctx);
      expect(rebuilt).toMatchObject({
        model: null,
        clean: false,
        create: { votes: { label: null }, counterparty: { label: null } },
      });
      expect(
        rebuilt!.candidates.every((candidate) => candidate.label === null),
      ).toBe(true);
      expect(
        await label(
          ctx,
          answering({ kind: "purchase", counterparty: "business" }),
        ),
      ).toMatchObject({ labelled: 1 });
    },
  );

  // A single charge's identity shortlist must not keep its own four-call cap.
  it("fans out every candidate identity decision in one charge", async () => {
    const account = (await card(ctx)).output;
    for (let index = 0; index < 8; index++)
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        postedDate: "2026-05-05",
        merchant: `Example Candidate ${index}`,
        rawDescription: `SYNTHETIC CANDIDATE ${index}`,
        sourceRefs: [],
      });
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let active = 0;
    let peak = 0;
    const pending = labelStatementSuggestions(ctx.db, {
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
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
    });
    try {
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      release.resolve();
      expect((await pending).failed).toEqual([]);
      expect(peak).toBeGreaterThan(4);
    } finally {
      release.resolve();
      await pending;
    }
  });

  // Model fan-out must fill the gateway independently of pooled publishing.
  // An unresolved model answer must not hold a transaction, and a burst of
  // returned answers must still open at most four publish transactions.
  it("fans out a label page while bounding DB publication independently", async () => {
    await card(ctx);
    await record(
      ctx,
      Array.from({ length: 40 }, (_, index) =>
        rowInput({
          merchant: `Example Merchant ${index}`,
          rawDescription: `SYNTHETIC CHARGE ${index}`,
          providerAmount: -100 - index,
        }),
      ),
    );
    await generate(ctx);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let modelActive = 0;
    let modelPeak = 0;
    let publishActive = 0;
    let publishPeak = 0;
    const publish = statementSuggestionsRepo.publishChargeProposal;
    const spy = vi
      .spyOn(statementSuggestionsRepo, "publishChargeProposal")
      .mockImplementation(async (...args) => {
        publishPeak = Math.max(publishPeak, ++publishActive);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await publish(...args);
        } finally {
          publishActive--;
        }
      });
    const pending = labelStatementSuggestions(ctx.db, {
      port: async (input) => {
        modelPeak = Math.max(modelPeak, ++modelActive);
        started.resolve();
        await release.promise;
        try {
          return await answer(input);
        } finally {
          modelActive--;
        }
      },
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
    });
    try {
      await started.promise;
      // Model answers remain outstanding while the complete page fans out.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(publishActive).toBe(0);
      release.resolve();
      const outcome = await pending;
      expect(modelPeak).toBeGreaterThanOrEqual(30);
      expect(outcome).toMatchObject({
        labelled: 40,
        labels: { generated: 80 },
      });
      expect(publishPeak).toBeGreaterThan(1);
      expect(publishPeak).toBeLessThanOrEqual(4);
    } finally {
      release.resolve();
      await pending;
      spy.mockRestore();
    }
  });

  it("returns committed label counts when a cooperative page pauses mid-page", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput(),
      rowInput({
        rawDescription: "SYNTHETIC SECOND CHARGE",
        merchant: "Example Cafe",
        providerAmount: -12,
      }),
    ]);
    await generate(ctx);
    const paused = new AiBudgetExhaustedError(
      {
        windowStart: "2026-05-04T00:00:00Z",
        windowEnd: "2026-05-04T06:00:00Z",
        credit: { limitUsd: 1, spentUsd: 0 },
        plan: { limitUsd: 1, spentUsd: 0 },
        paid: { limitUsd: 1, spentUsd: 1 },
      },
      "Synthetic pause",
    );
    const answer = answering({ kind: "purchase", counterparty: "business" });
    expect(
      await labelStatementSuggestions(ctx.db, {
        cooperative: true,
        port: async (input) => {
          if (input.state.includes("SYNTHETIC SECOND CHARGE")) throw paused;
          return answer(input);
        },
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      }),
    ).toMatchObject({
      labelled: 1,
      paused: { reason: paused.message, until: paused.resumeAt },
    });
  });

  // A member resolving listed work is a successful competing outcome, not a label failure.
  it("skips a charge accepted by the member while its labels are in flight", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [pending] = await suggestions(ctx);
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let accepted = false;
    const result = await label(ctx, async (input) => {
      if (!accepted) {
        accepted = true;
        await accept(ctx, pending!);
      }
      return answer(input);
    });
    expect(result.failed).toEqual([]);
    expect(result.labelled).toBe(0);
    expect(await suggestions(ctx)).toEqual([]);
  });

  // Publication failure must not discard a completely paid judgment before retry.
  it("retains completed decisions when model publication fails", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let calls = 0;
    const port: DecisionPort = async (input) => {
      calls++;
      return answer(input);
    };
    const publish = vi
      .spyOn(statementSuggestionsRepo, "publishChargeProposal")
      .mockRejectedValueOnce(new Error("Synthetic publication failure"));
    try {
      const first = await label(ctx, port);
      expect(first.failed).toHaveLength(1);
      expect(first.labels).toEqual({ reused: 0, generated: 2 });
      const resumed = await label(ctx, port);
      expect(resumed.labelled).toBe(1);
      expect(resumed.labels).toEqual({ reused: 2, generated: 0 });
      expect(calls).toBe(2);
    } finally {
      publish.mockRestore();
    }
  });

  // A pause after generation must preserve earlier paid labels while new
  // charges remain unlabelled; retrying asks only for those unfinished charges.
  it("keeps existing labels when a re-Sweep is interrupted mid-label", async () => {
    await card(ctx);
    const original = rowInput();
    await record(ctx, [original]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [before] = await suggestions(ctx);
    await record(
      ctx,
      [
        { ...original, rowPosition: 10, providerNotes: "Synthetic new memo" },
        rowInput({
          rawDescription: "EXAMPLE NEW CHARGE",
          merchant: "Example Cafe",
          providerAmount: -12,
        }),
      ],
      { fingerprint: "synthetic-interrupted-export" },
    );
    await generate(ctx);
    const paused = new AiBudgetExhaustedError(
      {
        windowStart: "2026-05-04T00:00:00Z",
        windowEnd: "2026-05-04T06:00:00Z",
        credit: { limitUsd: 1, spentUsd: 0 },
        plan: { limitUsd: 1, spentUsd: 0 },
        paid: { limitUsd: 1, spentUsd: 1 },
      },
      "Synthetic interruption",
    );
    await expect(
      label(ctx, async () => {
        throw paused;
      }),
    ).rejects.toBe(paused);
    const retained = (await suggestions(ctx)).find(
      (row) => row.chargeKey === before!.chargeKey,
    );
    expect(retained).toMatchObject({
      clean: true,
      create: {
        votes: { label: "purchase" },
        counterparty: { label: "business" },
      },
    });
    const seen: string[] = [];
    const answer = answering({ kind: "purchase", counterparty: "business" });
    await label(ctx, async (input) => {
      seen.push(input.state);
      return answer(input);
    });
    expect(
      seen.every((subject) => subject.includes("EXAMPLE NEW CHARGE")),
    ).toBe(true);
    expect((await suggestions(ctx)).every((row) => row.clean)).toBe(true);
  });

  // Failure mode: the model picks `interest` for interest earned, which the
  // settlement sign rule refuses, so the accept could never apply.
  it("ignores a model kind the transaction could not be created as", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        providerAmount: 8.66,
        merchant: "Example Bank",
        rawDescription: "EXAMPLE INTEREST PAID",
        sourceCategory: null,
      }),
    ]);
    await generate(ctx);
    await label(ctx, answering({ kind: "interest", counterparty: "business" }));
    const [suggestion] = await suggestions(ctx);
    expect(suggestion!.create).toMatchObject({
      amount: -8.66,
      kind: "refund",
      kindSource: "sign",
      votes: { label: "interest" },
    });
    expect(suggestion!.clean).toBe(false);
  });

  // Failure mode: every recorded chunk regenerates the whole ledger.
  it("limits an import's pass to the charges it observed", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE OLDER CHARGE" })]);
    const later = await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE NEWER CHARGE" })],
      { fingerprint: "fp-later-import" },
    );
    const page = await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
      scope: { importId: later.batchId },
    });
    expect(page).toMatchObject({ published: 1, next: null });
    expect((await suggestions(ctx)).map((row) => row.rawDescription)).toEqual([
      "EXAMPLE NEWER CHARGE",
    ]);
  });

  // Failure modes: a ref attached on another path (the import page, an
  // agent's entity.update) leaves the suggestion live, and accepting it
  // records the charge twice.
  it("defers retirement but refuses stale evidence when its charge is attached elsewhere", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    const [row] = (await listStatementRows(ctx.db, {})).data;
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Example Grocer",
      rawDescription: "EXAMPLE GROCER 0001",
      sourceRefs: [{ source: "monarch", externalId: row!.externalId }],
    });
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "pending",
      active: true,
    });
    await expect(accept(ctx, suggestion!)).rejects.toThrow(
      /evidence changed|stale/,
    );
    await processStatementRetirementPage(ctx.db);
    expect(await stateOf(ctx, suggestion!.assessmentId)).toMatchObject({
      status: "superseded",
      active: false,
    });
    expect(await generate(ctx)).toBe(0);
  });

  // Failure mode: two members (or an agent and a member) accepting the same
  // suggestion at once create two transactions for one charge.
  it("applies concurrent accepts of one suggestion once", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const [suggestion] = await suggestions(ctx);
    const outcomes = await Promise.allSettled([
      accept(ctx, suggestion!),
      accept(ctx, suggestion!),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const created = await getDb(ctx.db).execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM "FinancialTransaction" WHERE "deletedAt" IS NULL`,
    );
    expect(created.rows[0]?.count).toBe(1);
  });

  // Failure mode: accepting one of two firmed-up twins leaves the other's
  // suggestion stale until a whole-ledger refresh.
  it("refreshes a sibling's suggestion after its twin is applied", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE MKTPLACE PMTS" })]);
    await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE MKTPL*AB12CD34" })],
      { fingerprint: "fp-firmed" },
    );
    await generate(ctx);
    const [first] = await suggestions(ctx);
    await accept(ctx, first!);
    const [twin] = await suggestions(ctx);
    expect(twin).toMatchObject({
      recommended: "attach",
      siblings: 0,
      candidates: [
        expect.objectContaining({
          transactionId: expect.stringMatching(/^FTX-/),
        }),
      ],
    });
    expect(twin!.rawDescription).not.toBe(first!.rawDescription);
  });

  // Failure mode: once one of two same-amount charges is attached, the other
  // has no unmatched sibling left, so a model "same" alone would bulk-attach a
  // second real charge onto the transaction that already settles the first.
  it("never cleans an attach to a transaction another charge already settles", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE CAFE 0001" })]);
    await record(
      ctx,
      [
        rowInput({
          rawDescription: "EXAMPLE CAFE 0002",
          statementDate: "2026-05-05",
        }),
      ],
      { fingerprint: "fp-second-visit" },
    );
    await generate(ctx);
    const older = (await suggestions(ctx)).find(
      (row) => row.rawDescription === "EXAMPLE CAFE 0001",
    );
    await accept(ctx, older!);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [second] = await suggestions(ctx);
    expect(second).toMatchObject({
      rawDescription: "EXAMPLE CAFE 0002",
      recommended: "attach",
      siblings: 0,
      clean: false,
      candidates: [
        expect.objectContaining({
          claimed: true,
          label: expect.objectContaining({ same: "same", confidence: "high" }),
        }),
      ],
    });
  });

  // Failure mode: a charge the member set aside (ignored, or superseded by the
  // row under review) still claims the transaction holding its ref, so the
  // canonical row can never go clean. The decision sits on another
  // observation of the set-aside charge, which still settles it.
  it.each(["superseded", "ignored"] as const)(
    "lets a %s charge's transaction go to the charge under review",
    async (decision) => {
      await card(ctx);
      await record(ctx, [rowInput({ rawDescription: "EXAMPLE CAFE 0001" })]);
      await record(
        ctx,
        [
          rowInput({
            rawDescription: "EXAMPLE CAFE 0002",
            statementDate: "2026-05-05",
          }),
        ],
        { fingerprint: "fp-firmed-up" },
      );
      await generate(ctx);
      const older = (await suggestions(ctx)).find(
        (row) => row.rawDescription === "EXAMPLE CAFE 0001",
      );
      await accept(ctx, older!);
      await record(ctx, [rowInput({ rawDescription: "EXAMPLE CAFE 0001" })], {
        fingerprint: "fp-older-again",
      });
      const rowsOf = async (search: string) =>
        (await listStatementRows(ctx.db, { search })).data;
      const olderRows = await rowsOf("EXAMPLE CAFE 0001");
      expect(olderRows).toHaveLength(2);
      const [canonical] = await rowsOf("EXAMPLE CAFE 0002");
      const original = olderRows.find(
        (row) => row.importFingerprint === "fp-suggest-1",
      )!;
      const reobserved = olderRows.find(
        (row) => row.importFingerprint === "fp-older-again",
      )!;
      // Another observation of the same charge, not the one the ref names.
      expect(reobserved.externalId).not.toBe(original.externalId);
      expect(reobserved.legacyExternalId ?? reobserved.externalId).toBe(
        original.legacyExternalId ?? original.externalId,
      );
      await updateStatementRows(
        ctx.db,
        {
          selector: {
            source: "monarch",
            externalIds: [reobserved.externalId],
          },
          data:
            decision === "superseded"
              ? { supersededByExternalId: canonical!.externalId }
              : {
                  disposition: "ignored",
                  dispositionReason: "not_modeled",
                  dispositionNote: "Synthetic duplicate.",
                },
        },
        ctx.actor,
      );
      await generate(ctx);
      await label(
        ctx,
        answering({ kind: "purchase", counterparty: "business" }),
      );
      const second = (await suggestions(ctx)).find(
        (row) => row.rawDescription === "EXAMPLE CAFE 0002",
      );
      expect(second).toMatchObject({
        recommended: "attach",
        clean: true,
        candidates: [expect.objectContaining({ claimed: false })],
      });
    },
  );

  // Failure modes: a category rule alone makes a create bulk-acceptable; a
  // label that disagrees with the rule still leaves it clean.
  it("cleans a create only when a label agrees with the category rule", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        merchant: "Example Cafe",
        rawDescription: "EXAMPLE CAFE",
        sourceCategory: "Coffee Shops",
        providerAmount: -6.25,
      }),
      rowInput({
        merchant: "Example Market",
        rawDescription: "EXAMPLE MARKET",
        sourceCategory: "Shopping",
        providerAmount: -8.5,
      }),
    ]);
    await generate(ctx);
    expect((await suggestions(ctx)).every((row) => !row.clean)).toBe(true);

    await label(
      ctx,
      answering({
        kind: (subject) => (subject.includes("CAFE") ? "purchase" : "fee"),
        counterparty: "business",
      }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.merchant === "Example Cafe")).toMatchObject({
      clean: true,
      create: {
        kind: "purchase",
        kindSource: "rule",
        votes: { rule: "purchase", label: "purchase", history: null },
        counterparty: { label: "business", history: null },
      },
    });
    expect(rows.find((row) => row.merchant === "Example Market")).toMatchObject(
      {
        clean: false,
        create: {
          kind: "purchase",
          votes: { rule: "purchase", label: "fee", history: null },
        },
      },
    );
  });

  // Failure modes: a payment-app credit from a friend under Paychecks becomes
  // clean income; a payment to a person is offered as a transfer or in bulk.
  it("never cleans a payment with a person, in either direction", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({
        merchant: "Sample Friend",
        rawDescription: "PAYFRIEND FROM SAMPLE FRIEND",
        sourceCategory: "Paychecks",
        providerAmount: 40,
      }),
      rowInput({
        merchant: "Sample Friend",
        rawDescription: "PAYFRIEND *SAMPLE FRIEND",
        sourceCategory: "Shopping",
        providerAmount: -25,
      }),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({ kind: "account_transfer", counterparty: "person" }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.amount < 0)).toMatchObject({
      clean: false,
      create: { kind: "income", counterparty: { label: "person" } },
    });
    expect(rows.find((row) => row.amount > 0)).toMatchObject({
      clean: false,
      create: { kind: "purchase", counterparty: { label: "person" } },
    });
  });

  // Failure mode: a card payment labelled clean under the earlier rule keeps
  // its evidence fingerprint (labels ride on top of it), so "Accept clean"
  // would still create it with no opposite leg.
  it("leaves a money move labelled clean by an earlier rule out of Accept clean", async () => {
    const account = (await card(ctx)).output;
    // A clean attach beside it: its create alternative never decides it.
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-05",
      merchant: "Older import label",
      rawDescription: "EXMPL GRCR #1 SYNTHETIC",
      sourceRefs: [],
    });
    await record(ctx, [
      rowInput(),
      rowInput({
        providerAmount: 900,
        merchant: "Synthetic Card Services",
        rawDescription: "PAYMENT THANK YOU",
        sourceCategory: "Credit Card Payment",
      }),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({ kind: "credit_card_payment", counterparty: "business" }),
    );
    const listed = await suggestions(ctx);
    const payment = listed.find((row) => row.recommended === "create");
    const attach = listed.find((row) => row.recommended === "attach");
    expect(payment).toMatchObject({
      clean: false,
      create: { kind: "credit_card_payment" },
    });
    expect(attach).toMatchObject({ clean: true });
    // The stored flag the earlier rule left; Accept clean selects by it.
    await getDb(ctx.db).execute(
      sql`UPDATE "AssessmentState" SET data = jsonb_set(data, '{clean}', 'true') WHERE id = ${payment!.assessmentId}::uuid`,
    );
    // Refused with a reason, so the page skips it instead of stopping.
    expect(
      await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
        filters: { family: "statement_transaction" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assessmentId: payment!.assessmentId,
          ok: false,
          error: expect.stringContaining("No longer clean"),
        }),
        expect.objectContaining({
          assessmentId: attach!.assessmentId,
          ok: true,
          applied: true,
        }),
      ]),
    );
    expect(await stateOf(ctx, payment!.assessmentId)).toMatchObject({
      status: "pending",
    });
  });

  // Failure modes: a cash-out from the member's own balance account is read
  // as income from its provider category; a move between two owners is bulk
  // accepted without its LedgerTransfer; a named own account makes a move
  // clean before its opposite leg is seen.
  it("reads a cash-out naming an own balance account as a transfer", async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Avery Example",
      kind: "member",
    });
    const partner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Blake Example",
      kind: "member",
    });
    await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic Checking",
      identity: {
        kind: "bank_account",
        institution: "Example Bank",
        accountType: "checking",
      },
      ledgerPartyId: member.output.id,
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic Checking (...1111)",
          externalAccountId: null,
        },
      ],
    });
    const wallet = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic PayFriend",
      identity: { kind: "stored_value", provider: "PayFriend" },
      ledgerPartyId: member.output.id,
    });
    const partnerWallet = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic SplitPay",
      identity: { kind: "stored_value", provider: "SplitPay" },
      ledgerPartyId: partner.output.id,
    });
    await record(ctx, [
      rowInput({
        accountDescriptor: "Synthetic Checking (...1111)",
        merchant: "PayFriend",
        rawDescription: "PAYFRIEND CASHOUT 8812",
        sourceCategory: "Other Income",
        providerAmount: 150,
      }),
      rowInput({
        accountDescriptor: "Synthetic Checking (...1111)",
        merchant: "SplitPay",
        rawDescription: "SPLITPAY TRANSFER 7731",
        sourceCategory: "Transfer",
        providerAmount: 60,
      }),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({ kind: "account_transfer", counterparty: "business" }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.merchant === "PayFriend")).toMatchObject({
      clean: false,
      create: {
        kind: "account_transfer",
        votes: { rule: "account_transfer", label: "account_transfer" },
      },
      transfer: { accountId: wallet.output.id, ledgerTransfer: false },
    });
    expect(rows.find((row) => row.merchant === "SplitPay")).toMatchObject({
      clean: false,
      create: { kind: "account_transfer" },
      transfer: { accountId: partnerWallet.output.id, ledgerTransfer: true },
    });
  });

  // Failure mode: a payment-app payee whose note reads like a merchant is
  // labelled a business and bulk-accepted.
  it("holds a payment-app payment back on the label alone", async () => {
    await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic PayFriend",
      identity: { kind: "stored_value", provider: "PayFriend" },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Personal Profile",
          externalAccountId: null,
        },
      ],
    });
    await record(ctx, [
      rowInput({
        accountDescriptor: "Personal Profile",
        merchant: "Sample Friend",
        rawDescription: 'Sample Friend "Noodles"',
        sourceCategory: "Restaurants & Bars",
        providerAmount: -42,
      }),
    ]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    const [row] = await suggestions(ctx);
    expect(row).toMatchObject({
      clean: false,
      create: {
        kind: "purchase",
        votes: { rule: "purchase", label: "purchase", history: null },
        counterparty: { label: "business", history: null, storedValue: true },
      },
    });
  });

  // Failure modes: a card benefit credit naming the same merchant as the
  // subscription it offsets reads that merchant's purchases as `mixed`
  // history, or is proposed as a refund.
  it("keys merchant history on direction for a benefit credit", async () => {
    const account = (await card(ctx)).output;
    const prior = (amount: number, postedDate: string) =>
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: amount > 0 ? "purchase" : "adjustment",
        status: "posted",
        amount,
        postedDate,
        merchant: "Example Rides",
        rawDescription:
          amount > 0 ? "EXAMPLE RIDES PASS" : "EXAMPLE RIDES BENEFIT CREDIT",
        sourceRefs: [],
      });
    for (const postedDate of ["2026-02-03", "2026-03-03"]) {
      await prior(9.99, postedDate);
      await prior(-9.99, postedDate);
    }
    const rides = (providerAmount: number, rawDescription: string) =>
      rowInput({
        merchant: "Example Rides",
        rawDescription,
        sourceCategory: "Taxi & Ride Shares",
        providerAmount,
      });
    await record(ctx, [
      rides(-9.99, "EXAMPLE RIDES PASS"),
      rides(9.99, "SYNTHETIC CARD EXAMPLE RIDES BENEFIT CREDIT"),
    ]);
    await generate(ctx);
    await label(
      ctx,
      answering({
        kind: (subject) =>
          subject.includes("BENEFIT") ? "adjustment" : "purchase",
        counterparty: "business",
      }),
    );
    const rows = await suggestions(ctx);
    expect(rows.find((row) => row.amount > 0)).toMatchObject({
      clean: true,
      create: {
        kind: "purchase",
        votes: { rule: "purchase", label: "purchase", history: "purchase" },
      },
    });
    expect(rows.find((row) => row.amount < 0)).toMatchObject({
      clean: true,
      create: {
        kind: "adjustment",
        votes: { rule: null, label: "adjustment", history: "adjustment" },
      },
    });
  });

  // Failure modes: a rule votes for itself through the transactions its own
  // bulk acceptance created; mixed history reads as agreement.
  it("counts member-made merchant history and excludes rule bulk-accepts", async () => {
    const account = (await card(ctx)).output;
    const prior = (
      merchant: string,
      kind: FinancialTransactionKind,
      postedDate: string,
    ) =>
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind,
        status: "posted",
        amount: 9.5,
        postedDate,
        merchant,
        rawDescription: merchant.toUpperCase(),
        sourceRefs: [],
      });
    await prior("Example Bakery", "purchase", "2026-03-02");
    await prior("example  bakery", "purchase", "2026-03-09");
    await prior("Example Deli", "purchase", "2026-03-03");
    await prior("Example Deli", "fee", "2026-03-10");
    const cafe = (statementDate: string, providerAmount: number) =>
      rowInput({
        statementDate,
        merchant: "Example Cafe",
        rawDescription: `EXAMPLE CAFE ${statementDate}`,
        sourceCategory: "Coffee Shops",
        providerAmount,
      });
    // By the third accept two earlier cafe transactions exist: were they
    // counted, its history vote would move and its evidence check refuse it.
    await record(ctx, [
      cafe("2026-04-01", -3.25),
      cafe("2026-04-08", -4.75),
      cafe("2026-04-15", -2.5),
    ]);
    await generate(ctx);
    await label(ctx, answering({ kind: "purchase", counterparty: "business" }));
    for (const suggestion of await suggestions(ctx)) {
      expect(suggestion.clean).toBe(true);
      await accept(ctx, suggestion);
    }

    await record(
      ctx,
      [
        cafe("2026-05-01", -5.5),
        rowInput({
          merchant: "Example Bakery",
          rawDescription: "EXAMPLE BAKERY",
          sourceCategory: "Restaurants",
          providerAmount: -11,
        }),
        rowInput({
          merchant: "Example Deli",
          rawDescription: "EXAMPLE DELI",
          sourceCategory: "Restaurants",
          providerAmount: -13,
        }),
      ],
      { fingerprint: "fp-history-2" },
    );
    await generate(ctx);
    // A low-confidence kind abstains, so rule and history decide.
    await label(
      ctx,
      answering({
        kind: "purchase",
        counterparty: "business",
        kindConfidence: 0.4,
      }),
    );
    const rows = await suggestions(ctx);
    const by = (merchant: string) =>
      rows.find((row) => row.merchant === merchant);
    expect(by("Example Cafe")).toMatchObject({
      clean: false,
      create: { votes: { rule: "purchase", label: null, history: null } },
    });
    expect(by("Example Bakery")).toMatchObject({
      clean: true,
      create: { votes: { rule: "purchase", label: null, history: "purchase" } },
    });
    expect(by("Example Deli")).toMatchObject({
      clean: false,
      create: { votes: { history: "mixed" } },
    });
  });
});
