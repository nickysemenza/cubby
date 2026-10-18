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
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb } from "~/server/db/helpers";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { labelStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";

import {
  getStatementRowSummary,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "./statement-row";
import { listStatementSuggestions } from "./statement-suggestion-read";
import {
  generateStatementSuggestionPage,
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

const suggestions = async (ctx: Ctx) =>
  (
    await listStatementSuggestions(ctx.db, {
      filters: {},
      limit: 50,
      offset: 0,
    })
  ).data;

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

describe("statement Transaction suggestions", () => {
  const ctx = withTestDb();

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
    expect(
      queue.items.filter((row) => row.source === "statement_suggestion"),
    ).toEqual([
      expect.objectContaining({
        entity: "financialAccount",
        reason: "2 transaction suggestions (2 ready to accept)",
      }),
    ]);
    const [first] = (await suggestions(ctx)).filter(
      (row) => row.merchant === "Example Cafe",
    );
    expect(first).toMatchObject({ recommended: "create", clean: true });
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
    // The trigger retired the coffee suggestion.
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
    const firstChoice: DecisionPort = async (input) => {
      const keys = Object.keys(input.questions.selection.criteria);
      return {
        answers: {
          selection: {
            type: "choice",
            choice: keys[0]!,
            confidence: 0.97,
            probabilities: Object.fromEntries(
              keys.map((key, index) => [key, index === 0 ? 0.97 : 0.01]),
            ),
          },
        },
      };
    };
    expect(
      await labelStatementSuggestions(ctx.db, {
        port: firstChoice,
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
});
