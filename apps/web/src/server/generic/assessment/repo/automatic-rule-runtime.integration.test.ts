import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily, feedbackAuthority } from "@cubby/schemas/assessment";
import type { AutomaticRuleKey } from "@cubby/schemas/automatic-rule";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { and, desc, eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { AiWorkDeferredError } from "~/server/ai/cooperative-work";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import {
  assessmentState,
  automaticRule,
  expense,
  spendingCategory,
} from "~/server/db/schema";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import {
  categoryPorts,
  kernelCtx,
  productFixture,
  seedPending,
  productCategoryId,
  startSuggestionSweep,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { answering } from "~/server/domains/statement-import/repo/statement-decision-port.fixtures";
import {
  listStatementRows,
  recordStatementRows,
} from "~/server/domains/statement-import/repo/statement-row";
import {
  buildChargeProposals,
  generateStatementSuggestionPage,
  suggestionsNeedingLabels,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { labelStatementSuggestions as runStatementLabels } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import {
  applyAutomaticRules,
  listAutomaticRules,
  setAutomaticRule,
} from "~/server/generic/assessment/repo/automatic-rule-runtime";
import * as automaticRuleRuntime from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { ruleBase } from "~/server/generic/assessment/repo/automatic-rules";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import {
  canAutomaticallyFillField,
  acceptSuggestion,
} from "~/server/generic/assessment/repo/suggestion-review";
import { createSystemUserFixture } from "~/server/testing/repo.fixtures";

type Ctx = ReturnType<typeof withTestDb>;

const labelStatementSuggestions: typeof runStatementLabels = async (
  db,
  input,
) => {
  const category = await getDb(db).query.spendingCategory.findFirst({
    where: eq(spendingCategory.name, "Synthetic automatic spending"),
  });
  return runStatementLabels(db, {
    ...input,
    spendingAdvice: async ({ judgment }) =>
      financialSpendingAdvice.parse({
        spendingCategoryId: category?.shortcode,
        categoryConfidence: "high",
        vendorName: judgment.create?.merchant ?? "Synthetic automatic merchant",
        vendorConfidence: "high",
        counterparty: "business",
      }),
  });
};

const ATTACH: AutomaticRuleKey = "statement_transaction.attach";
const BOOK_SPENDING: AutomaticRuleKey = "statement_transaction.book_spending";

const ruleOf = async (ctx: Ctx, key: AutomaticRuleKey) =>
  (await listAutomaticRules(ctx.db)).rules.find(
    (rule) => rule.ruleKey === key,
  )!;

/** Judgments and application receipts; projection maintenance events are not decisions. */
const feedbackFor = async (ctx: Ctx, assessmentId: string) =>
  (
    await getDb(ctx.db).execute<{
      authority: string;
      verdict: string;
      metadata: { kind?: string; rule?: { key: string; stamp: string } };
    }>(
      sql`SELECT authority, verdict, metadata FROM "Feedback" WHERE "assessmentId" = ${assessmentId}::uuid AND authority <> ${feedbackAuthority.enum.system} ORDER BY "createdAt"`,
    )
  ).rows;

const stateOf = async (ctx: Ctx, assessmentId: string) =>
  (
    await getDb(ctx.db).execute<{
      status: string;
      data: { matchedRules?: string[] };
    }>(
      sql`SELECT status, data FROM "AssessmentState" WHERE id = ${assessmentId}::uuid`,
    )
  ).rows[0]!;

// --- statement fixtures: one charge whose only candidate is the same money ---

const card = async (ctx: Ctx) => {
  const owner = await createRepoEntity(ctx, "ledgerParty", {
    name: "Synthetic automatic member",
    kind: "member",
  });
  await createEntity(
    buildKernelContext(ctx.db, ctx.actor.userId),
    "spendingCategory",
    {
      name: "Synthetic automatic spending",
    },
  );
  return createRepoEntity(ctx, "financialAccount", {
    name: "Synthetic Card",
    ledgerPartyId: owner.output.id,
    provisional: false,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [
      {
        source: "monarch",
        alias: "Synthetic Card (...4242)",
        externalAccountId: null,
      },
    ],
  });
};

async function soleCandidateCharge(ctx: Ctx) {
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
  await recordStatementRows(
    ctx.db,
    recordStatementRowsInput.parse({
      import: {
        source: "monarch",
        label: "synthetic-export.csv",
        fingerprint: "fp-automatic-rule-1",
        dateKind: "posted",
        rowCountDeclared: null,
        notes: null,
      },
      rows: [
        {
          accountDescriptor: "Synthetic Card (...4242)",
          statementDate: "2026-05-04",
          providerAmount: -42.5,
          merchant: "Example Grocer",
          rawDescription: "EXAMPLE GROCER 0001",
          sourceCategory: "Groceries",
          providerStatus: "posted",
          providerNotes: null,
          rowPosition: 1,
        },
      ],
    }),
    ctx.actor,
  );
  await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
  return { account, existing };
}

/** A second charge of the same money, a day after the sole candidate's. */
const competingCharge = (ctx: Ctx) =>
  recordStatementRows(
    ctx.db,
    recordStatementRowsInput.parse({
      import: {
        source: "monarch",
        label: "synthetic-export.csv",
        fingerprint: "fp-automatic-rule-1",
        dateKind: "posted",
        rowCountDeclared: null,
        notes: null,
      },
      rows: [
        {
          accountDescriptor: "Synthetic Card (...4242)",
          statementDate: "2026-05-06",
          providerAmount: -42.5,
          merchant: "Example Grocer",
          rawDescription: "EXAMPLE GROCER 0002",
          sourceCategory: "Groceries",
          providerStatus: "posted",
          providerNotes: null,
          rowPosition: 2,
        },
      ],
    }),
    ctx.actor,
  );

/** Every pending statement suggestion still matches its charge's evidence. */
async function expectCurrentPending(ctx: Ctx, count: number) {
  const { rows: pending } = await getDb(ctx.db).execute<{
    source: string;
    chargeKey: string;
    evidenceFingerprint: string;
  }>(
    sql`SELECT data->>${"source"} AS source, data->>${"chargeKey"} AS "chargeKey",
        data->>${"evidenceFingerprint"} AS "evidenceFingerprint"
      FROM "AssessmentState"
      WHERE family = ${assessmentFamily.enum.statement_transaction} AND active
        AND status = ${suggestionStatus.enum.pending} AND data ? ${"chargeKey"}`,
  );
  expect(pending).toHaveLength(count);
  // Every pending suggestion still matches its charge's current evidence.
  for (const row of pending) {
    const [current] = await buildChargeProposals(ctx.db, [row]);
    expect(current?.evidenceFingerprint).toBe(row.evidenceFingerprint);
  }
}

const exhausted = () =>
  new AiBudgetExhaustedError(
    {
      windowStart: "2026-05-10T00:00:00.000Z",
      windowEnd: "2026-05-10T06:00:00.000Z",
      credit: { limitUsd: 1, spentUsd: 0 },
      plan: { limitUsd: 1, spentUsd: 0 },
      paid: { limitUsd: 1, spentUsd: 1 },
    },
    "AI budget reached: synthetic",
  );

// The candidate is the same charge; a create, if any, is a business purchase.
const sameCharge = answering({ kind: "purchase", counterparty: "business" });

const label = async (ctx: Ctx) =>
  labelStatementSuggestions(ctx.db, {
    port: sameCharge,
    runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
  });

/** The charge's current suggestion, in any status. */
const chargeSuggestion = async (ctx: Ctx) =>
  (
    await getDb(ctx.db)
      .select({
        id: assessmentState.id,
        fingerprint: assessmentState.fingerprint,
      })
      .from(assessmentState)
      .where(
        and(
          eq(assessmentState.family, "statement_transaction"),
          eq(assessmentState.active, true),
        ),
      )
      .orderBy(desc(assessmentState.createdAt))
      .limit(1)
  )[0]!;

// Failure modes: clean booking is invisible or cannot be paused; a measured
// attach bypasses its pause; stale automatic commands ignore the persisted
// switch; feedback retries reapply rejected or already-booked evidence.
describe("clean import booking controls", () => {
  const ctx = withTestDb();

  it("defaults on and lets a member pause and resume", async () => {
    expect(await ruleOf(ctx, BOOK_SPENDING)).toMatchObject({
      enabled: true,
    });
    expect(
      await setAutomaticRule(ctx.db, ctx.actor, {
        ruleKey: BOOK_SPENDING,
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });
    // A new code revision must not silently discard a member's pause.
    await getDb(ctx.db)
      .update(automaticRule)
      .set({ revision: "synthetic-previous-revision" })
      .where(eq(automaticRule.ruleKey, BOOK_SPENDING));
    expect((await ruleOf(ctx, BOOK_SPENDING)).enabled).toBe(false);
    expect(
      await setAutomaticRule(ctx.db, ctx.actor, {
        ruleKey: BOOK_SPENDING,
        enabled: true,
      }),
    ).toMatchObject({ enabled: true });
    await expect(
      setAutomaticRule(ctx.db, systemActor(), {
        ruleKey: BOOK_SPENDING,
        enabled: false,
      }),
    ).rejects.toThrow(/Only a member/);
  });

  it("holds clean spending while paused even when measured attach is on, then resumes once", async () => {
    await createSystemUserFixture(ctx.db);
    const { existing } = await soleCandidateCharge(ctx);
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: BOOK_SPENDING,
      enabled: false,
    });
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("pending");
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(
      await applyAutomaticRules(ctx.db, [suggestion.id], { importClean: true }),
    ).toEqual({ applied: [], refused: [] });
    const attachStamp = (
      await stateOf(ctx, suggestion.id)
    ).data.matchedRules!.find((stamp) => stamp === ruleBase(ATTACH))!;
    await expect(
      reviewAssessment(
        ctx.db,
        kernelCtx(ctx),
        {
          assessmentId: suggestion.id,
          operationId: "automatic:synthetic-paused-attach",
          verdict: "correct",
          intent: "apply",
          expectedFingerprint: suggestion.fingerprint,
          application: {
            kind: "statement_transaction",
            action: "attach",
            transactionId: existing.id,
            fields: [],
            rejectedCandidateIds: [],
          },
        },
        {
          authority: "automatic",
          rule: {
            key: ATTACH,
            revision: ruleBase(ATTACH).slice(ATTACH.length + 1),
            stamp: attachStamp,
          },
        },
      ),
    ).rejects.toThrow(/is off; review the suggestion/);
    expect(await feedbackFor(ctx, suggestion.id)).toEqual([]);
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: BOOK_SPENDING,
      enabled: true,
    });
    expect(
      (
        await applyAutomaticRules(ctx.db, [suggestion.id], {
          importClean: true,
        })
      ).applied,
    ).toEqual([suggestion.id]);
    const booked = await getDb(ctx.db).select().from(expense);
    expect(booked).toHaveLength(1);
    const history = await feedbackFor(ctx, suggestion.id);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: suggestion.id,
      operationId: "synthetic-booked-wrong",
      verdict: "wrong",
      intent: "history",
    });
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    expect(
      (
        await applyAutomaticRules(ctx.db, [suggestion.id], {
          importClean: true,
        })
      ).applied,
    ).toEqual([]);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("applied");
    expect(await getDb(ctx.db).select().from(expense)).toEqual(booked);
    expect(await feedbackFor(ctx, suggestion.id)).toEqual([
      ...history,
      expect.objectContaining({
        authority: "member",
        verdict: "wrong",
      }),
    ]);
  });

  it("does not automatically reapply an unchanged pending suggestion marked Wrong", async () => {
    await soleCandidateCharge(ctx);
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: suggestion.id,
      operationId: "synthetic-pending-wrong",
      verdict: "wrong",
      intent: "history",
    });
    const history = await feedbackFor(ctx, suggestion.id);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    await label(ctx);
    expect(
      (
        await applyAutomaticRules(ctx.db, [suggestion.id], {
          importClean: true,
        })
      ).applied,
    ).toEqual([]);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("rejected");
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await feedbackFor(ctx, suggestion.id)).toEqual(history);
  });
});

describe("Automatic rules", () => {
  const ctx = withTestDb();

  // Failure mode: a label page built up front publishes a charge with
  // evidence an automatic rule earlier in the page already changed, so its
  // suggestion fails as stale on accept.
  // Failure mode: a budget pause after an automatic attach left a competing
  // charge's suggestion on evidence the attach changed, so the resumed label
  // pass skipped it as stale.
  it("republishes evidence an automatic attach moved before a budget pause", async () => {
    await createSystemUserFixture(ctx.db);
    await soleCandidateCharge(ctx);
    await competingCharge(ctx);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    await expect(
      labelStatementSuggestions(ctx.db, {
        port: async (request) => {
          if (request.state.includes("EXAMPLE GROCER 0002")) throw exhausted();
          return sameCharge(request);
        },
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      }),
    ).rejects.toThrow("AI budget reached: synthetic");
    await expectCurrentPending(ctx, 1);
  });

  // Decision and capacity yields need the same evidence refresh as a funding pause.
  it.each(["decisions", "capacity"])(
    "republishes evidence moved by a rule before a %s yield",
    async (reason) => {
      await createSystemUserFixture(ctx.db);
      await soleCandidateCharge(ctx);
      await competingCharge(ctx);
      await generateStatementSuggestionPage(ctx.db, {
        after: null,
        runId: null,
      });
      await setAutomaticRule(ctx.db, ctx.actor, {
        ruleKey: ATTACH,
        enabled: true,
      });
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "background",
      });
      const outcome = await labelStatementSuggestions(ctx.db, {
        runId,
        cooperative: true,
        ...(reason === "decisions" && { decisionLimit: 4 }),
        port: async (request) => {
          if (
            reason === "capacity" &&
            request.state.includes("EXAMPLE GROCER 0002")
          )
            throw new AiWorkDeferredError(Date.now() + 60_000);
          return sameCharge(request);
        },
      });
      expect(outcome.next).not.toBeNull();
      await expectCurrentPending(ctx, 1);
      const resumed = await labelStatementSuggestions(ctx.db, {
        runId,
        after: outcome.next,
        port: sameCharge,
      });
      expect(resumed.stale).toBe(0);
    },
  );

  // A later round can exhaust its budget after an earlier rule changed evidence.
  it("keeps moved later-round work queued across a decision-cap yield", async () => {
    await createSystemUserFixture(ctx.db);
    const { account } = await soleCandidateCharge(ctx);
    await competingCharge(ctx);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    const original = automaticRuleRuntime.applyAutomaticRulesForCharge;
    let inserted = false;
    const rules = vi
      .spyOn(automaticRuleRuntime, "applyAutomaticRulesForCharge")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        // Concurrent imported evidence arrives after the first rule commits.
        if (!inserted && result.applied.length) {
          inserted = true;
          await createRepoEntity(ctx, "financialTransaction", {
            accountId: account.id,
            kind: "purchase",
            status: "posted",
            amount: 42.5,
            postedDate: "2026-05-05",
            rawDescription: "SYNTHETIC LATER RULE CANDIDATE",
            sourceRefs: [],
          });
        }
        return result;
      });
    try {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "background",
      });
      const page = await labelStatementSuggestions(ctx.db, {
        runId,
        port: sameCharge,
        decisionLimit: 8,
      });
      expect(page.next).not.toBeNull();
      expect(
        await suggestionsNeedingLabels(ctx.db, 10, page.next),
      ).toHaveLength(1);
      const resumed = await labelStatementSuggestions(ctx.db, {
        runId,
        port: sameCharge,
        after: page.next,
      });
      expect(resumed.failed).toEqual([]);
      expect(resumed.stale).toBe(0);
      expect(await suggestionsNeedingLabels(ctx.db, 10)).toEqual([]);
    } finally {
      rules.mockRestore();
    }
  });

  it("leaves no stale suggestion after an automatic attach mid-page", async () => {
    await createSystemUserFixture(ctx.db);
    const { existing } = await soleCandidateCharge(ctx);
    await competingCharge(ctx);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    await label(ctx);
    const rows = (await listStatementRows(ctx.db, {})).data;
    expect(rows.filter((row) => row.matchState === "matched")).toEqual([
      expect.objectContaining({ transactionId: existing.id }),
    ]);
    await expectCurrentPending(ctx, 1);
  });

  // Failure mode: a budget pause on one charge skipped the automatic rules
  // of a charge already published on the same page; published labels leave
  // the label queue, so that attach stayed pending for good.
  it("applies automatic rules to published charges before a budget pause", async () => {
    await createSystemUserFixture(ctx.db);
    const { existing } = await soleCandidateCharge(ctx);
    await recordStatementRows(
      ctx.db,
      recordStatementRowsInput.parse({
        import: {
          source: "monarch",
          label: "synthetic-export.csv",
          fingerprint: "fp-automatic-rule-1",
          dateKind: "posted",
          rowCountDeclared: null,
          notes: null,
        },
        rows: [
          {
            accountDescriptor: "Synthetic Card (...4242)",
            statementDate: "2026-05-10",
            providerAmount: -17.25,
            merchant: "Example Hardware",
            rawDescription: "EXAMPLE HARDWARE 0003",
            sourceCategory: "Shopping",
            providerStatus: "posted",
            providerNotes: null,
            rowPosition: 3,
          },
        ],
      }),
      ctx.actor,
    );
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    await expect(
      labelStatementSuggestions(ctx.db, {
        port: async (request) => {
          if (request.state.includes("EXAMPLE HARDWARE")) throw exhausted();
          return sameCharge(request);
        },
        runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
      }),
    ).rejects.toThrow("AI budget reached: synthetic");
    const matched = (await listStatementRows(ctx.db, {})).data.filter(
      (row) => row.matchState === "matched",
    );
    expect(matched).toEqual([
      expect.objectContaining({ transactionId: existing.id }),
    ]);
  });

  // Failure modes: an automatic attach ticks diff fields, bypasses the
  // family apply path, records member Feedback, or applies twice on replay.
  it("attaches a sole same-charge candidate through the review path, once", async () => {
    await createSystemUserFixture(ctx.db);
    const { existing } = await soleCandidateCharge(ctx);
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    const state = await stateOf(ctx, suggestion.id);
    expect(state.status).toBe("applied");
    // Automatic applications stay available to historical grading reads.
    const history = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      status: "applied",
    });
    expect(history.items.map((item) => item.assessmentId)).toContain(
      suggestion.id,
    );
    const audited = (
      await listAutomaticDecisions(ctx.db, {
        family: "statement_transaction",
        recordIds: [existing.id],
      })
    ).items.find((item) => item.id === suggestion.id);
    expect(audited?.records).toEqual(
      expect.arrayContaining([
        { entity: "financialTransaction", id: existing.id },
        expect.objectContaining({ entity: "financialAccount" }),
      ]),
    );
    const [stamp] = state.data.matchedRules!;
    expect(stamp).toBe(ruleBase(ATTACH));
    const events = await feedbackFor(ctx, suggestion.id);
    expect(events).toEqual([
      expect.objectContaining({
        authority: "automatic",
        verdict: "correct",
        metadata: expect.objectContaining({
          rule: expect.objectContaining({ key: ATTACH, stamp }),
        }),
      }),
      expect.objectContaining({
        authority: "automatic",
        verdict: "ungraded",
        metadata: expect.objectContaining({ kind: "assessment_application" }),
      }),
    ]);
    const [row] = (await listStatementRows(ctx.db, {})).data;
    expect(row).toMatchObject({
      matchState: "matched",
      transactionId: existing.id,
    });
    // The candidate's posted date differs from the statement's; untouched.
    const [transaction] = (
      await getDb(ctx.db).execute<{ postedDate: string }>(
        sql`SELECT "postedDate"::text AS "postedDate" FROM "FinancialTransaction" WHERE shortcode = ${existing.id}`,
      )
    ).rows;
    expect(transaction?.postedDate).toBe("2026-05-05");

    const view = await listAutomaticDecisions(ctx.db, {
      family: "statement_transaction",
    });
    expect(view.items).toEqual([
      expect.objectContaining({
        id: suggestion.id,
        automaticRule: `${ruleBase(ATTACH)}`,
      }),
    ]);

    expect(await applyAutomaticRules(ctx.db, [suggestion.id])).toMatchObject({
      applied: [],
      refused: [],
    });
    const replayed = await reviewAssessment(
      ctx.db,
      { ...kernelCtx(ctx), actorContext: systemActor() },
      {
        assessmentId: suggestion.id,
        operationId: `automatic:${ruleBase(ATTACH)}:${suggestion.id}`,
        verdict: "correct",
        correction: { present: false },
        intent: "apply",
        expectedFingerprint: suggestion.fingerprint,
        application: {
          kind: "statement_transaction",
          action: "attach",
          transactionId: existing.id,
          fields: [],
          rejectedCandidateIds: [],
        },
      },
      {
        authority: "automatic",
        rule: {
          key: ATTACH,
          revision: ruleBase(ATTACH).slice(ATTACH.length + 1),
          stamp: stamp!,
        },
      },
    );
    expect(replayed).toMatchObject({ status: "applied", applied: true });
    expect(await feedbackFor(ctx, suggestion.id)).toHaveLength(2);
  });

  // Failure mode (#2722 review): a rule turned off after the application
  // snapshot still applied, because the transaction never rechecked it.
  it("refuses an automatic application once the rule is off", async () => {
    await createSystemUserFixture(ctx.db);
    const { existing } = await soleCandidateCharge(ctx);
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("pending");
    await expect(
      reviewAssessment(
        ctx.db,
        { ...kernelCtx(ctx), actorContext: systemActor() },
        {
          assessmentId: suggestion.id,
          operationId: `automatic:${ruleBase(ATTACH)}:${suggestion.id}`,
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          expectedFingerprint: suggestion.fingerprint,
          application: {
            kind: "statement_transaction",
            action: "attach",
            transactionId: existing.id,
            fields: [],
            rejectedCandidateIds: [],
          },
        },
        {
          authority: "automatic",
          rule: {
            key: ATTACH,
            revision: ruleBase(ATTACH).slice(ATTACH.length + 1),
            stamp: ruleBase(ATTACH),
          },
        },
      ),
    ).rejects.toThrow(/is off; review the suggestion/);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("pending");
    expect(await feedbackFor(ctx, suggestion.id)).toEqual([]);
  });

  // Failure modes: a rule applies while off; evidence that drifted after
  // publication is applied anyway.
  it("applies nothing while off or for drifted evidence", async () => {
    await createSystemUserFixture(ctx.db);
    const { account } = await soleCandidateCharge(ctx);
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    expect(await applyAutomaticRules(ctx.db, [suggestion.id])).toEqual({
      applied: [],
      refused: [],
    });
    expect((await stateOf(ctx, suggestion.id)).status).toBe("pending");

    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    // A second transaction appears nearby: the published evidence is stale.
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
    const outcome = await applyAutomaticRules(ctx.db, [suggestion.id]);
    expect(outcome.applied).toEqual([]);
    expect(outcome.refused).toEqual([
      expect.objectContaining({
        assessmentId: suggestion.id,
        message: expect.stringMatching(/evidence changed/),
      }),
    ]);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("pending");
    expect(await feedbackFor(ctx, suggestion.id)).toEqual([]);
    expect((await listStatementRows(ctx.db, {})).data[0]).toMatchObject({
      matchState: "unmatched",
    });
  });
});

// Failure: automatic policy overwrites a populated member field.
describe("automatic field assignments", () => {
  const ctx = withTestDb();
  // Failure: stored NULL hides a populated effective value derived from order evidence.
  it("preserves Vendor itemization inherited from online order evidence", async () => {
    const merchant = (
      await createRepoEntity(ctx, "vendor", {
        name: "Synthetic online merchant",
        orderEvidence: "online_account",
        itemizationExpectation: null,
      })
    ).output;
    const [stored] = (
      await getDb(ctx.db).execute<{
        id: string;
        itemizationExpectation: string | null;
      }>(
        sql`SELECT id, "itemizationExpectation" FROM "Vendor" WHERE shortcode = ${merchant.id}`,
      )
    ).rows;
    expect(stored?.itemizationExpectation).toBeNull();
    const effective = await executeEntity(kernelCtx(ctx), {
      action: "get",
      entity: "vendor",
      id: merchant.id,
      missing: "error",
    });
    expect(effective).toMatchObject({
      item: {
        fieldResolutions: { itemizationExpectation: { value: "required" } },
      },
    });
    const pending = await seedPending(ctx, {
      entity: "vendor",
      recordId: stored!.id,
      field: "itemizationExpectation",
      currentValue: null,
      suggestedValue: "not_expected",
      kind: "addition",
    });
    await getDb(ctx.db)
      .update(assessmentState)
      .set({
        confidence: 0.97,
        provenance: {
          dependencies: dependencyStamps(
            await producingAiManifest(ctx.db),
            fieldDependencyKeys("vendor", "itemizationExpectation"),
          ),
          inputFingerprint: "synthetic",
          optionFingerprint: "synthetic",
          model: "typesafe/jev",
        },
      })
      .where(eq(assessmentState.id, pending.id));
    expect(
      await canAutomaticallyFillField(ctx.db, kernelCtx(ctx), pending.id),
    ).toBe(false);
    await expect(
      acceptSuggestion(
        ctx.db,
        kernelCtx(ctx),
        { id: pending.id },
        { mode: "automatic", confidence: 0.97 },
      ),
    ).rejects.toThrow(/populated effective values/);
    expect((await stateOf(ctx, pending.id)).status).toBe("pending");
    expect(await feedbackFor(ctx, pending.id)).toEqual([]);
  });

  // Failure: a mode-only explicit None looks empty and has no target-field audit.
  it("preserves explicit None assignment intent with a null effective value", async () => {
    const project = (
      await createRepoEntity(ctx, "project", {
        name: "Synthetic candidate project",
      })
    ).output;
    const task = (
      await createRepoEntity(ctx, "task", {
        name: "Synthetic task",
        trade: "electrical",
        projectMode: "explicit",
        projectId: null,
      })
    ).output;
    const [stored] = (
      await getDb(ctx.db).execute<{ id: string }>(
        sql`SELECT id FROM "Task" WHERE shortcode = ${task.id}`,
      )
    ).rows;
    const pending = await seedPending(ctx, {
      entity: "task",
      recordId: stored!.id,
      field: "projectId",
      currentValue: null,
      suggestedValue: project.id,
      kind: "addition",
    });
    await getDb(ctx.db)
      .update(assessmentState)
      .set({
        confidence: 0.97,
        provenance: {
          dependencies: dependencyStamps(
            await producingAiManifest(ctx.db),
            fieldDependencyKeys("task", "projectId"),
          ),
          inputFingerprint: "synthetic",
          optionFingerprint: "synthetic",
          model: "typesafe/jev",
        },
      })
      .where(eq(assessmentState.id, pending.id));
    expect(
      await canAutomaticallyFillField(ctx.db, kernelCtx(ctx), pending.id),
    ).toBe(false);
    await expect(
      acceptSuggestion(
        ctx.db,
        kernelCtx(ctx),
        { id: pending.id },
        { mode: "automatic", confidence: 0.97 },
      ),
    ).rejects.toThrow(/existing field decision/);
    expect((await stateOf(ctx, pending.id)).status).toBe("pending");
  });

  it("keeps populated member fields pending for explicit review", async () => {
    const item = await productFixture(
      ctx,
      "Synthetic member-classified product",
    );
    await executeEntity(
      kernelCtx(ctx),
      entityCommandSchema.parse({
        action: "update",
        entity: "product",
        id: item.id,
        data: { categoryId: taxonomyShortcode("tools") },
      }),
    );
    const sweep = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts() },
    );
    const [pending] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.runId, sweep.id));
    expect(pending).toMatchObject({ kind: "correction", status: "pending" });
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("tools"));
    expect(await feedbackFor(ctx, pending!.id)).toEqual([]);
  });
});
