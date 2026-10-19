import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import type { AutomaticRuleKey } from "@cubby/schemas/automatic-rule";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { and, desc, eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { answering } from "~/server/domains/statement-import/repo/statement-decision-port.fixtures";
import {
  listStatementRows,
  recordStatementRows,
} from "~/server/domains/statement-import/repo/statement-row";
import {
  buildChargeProposals,
  generateStatementSuggestionPage,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import {
  applyAutomaticRules,
  listAutomaticRules,
  setAutomaticRule,
} from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { ruleBase } from "~/server/generic/assessment/repo/automatic-rules";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { createSystemUserFixture } from "~/server/testing/repo.fixtures";

type Ctx = ReturnType<typeof withTestDb>;

const ATTACH: AutomaticRuleKey = "statement_transaction.attach";
const ADDITION: AutomaticRuleKey = "field.addition";

type Verdict = "correct" | "wrong" | "dismissed";

/**
 * Reviewed rule matches written directly: windows need dozens of them.
 * `automatic` rows also carry an automatic application receipt.
 */
async function seedReviews(
  ctx: Ctx,
  input: {
    family: "field" | "statement_transaction";
    stamp: string;
    verdicts: Verdict[];
    automatic?: boolean;
    candidateId?: string;
    correction?: unknown;
    /** Seconds before now of the newest review; later entries are older. */
    agedFrom?: number;
  },
) {
  const client = getDb(ctx.db);
  const rows = input.verdicts.map((verdict, index) => ({
    id: crypto.randomUUID(),
    verdict,
    at: new Date(Date.now() - ((input.agedFrom ?? 0) + index + 1) * 1000),
  }));
  const status = input.automatic ? "applied" : "resolved";
  const data = { matchedRules: [input.stamp] };
  if (input.family === "field")
    // The field publication trigger writes each Assessment.
    await client.insert(assessmentState).values(
      rows.map((row) => ({
        id: row.id,
        family: "field" as const,
        entity: "product",
        recordId: crypto.randomUUID(),
        field: "categoryId",
        kind: "addition",
        confidence: 0.97,
        model: "typesafe/jev",
        data,
        status,
      })),
    );
  else {
    await client.insert(assessment).values(
      rows.map((row) => ({
        id: row.id,
        publicationKey: `synthetic:${row.id}`,
        family: "statement_transaction" as const,
        subject: {
          kind: "statement_transaction" as const,
          entity: "statementRow" as const,
          recordId: crypto.randomUUID(),
          source: "monarch",
          chargeKey: `synthetic-${row.id}`,
        },
        judgment: {
          recommended: "attach",
          candidates: [
            { transactionId: input.candidateId ?? crypto.randomUUID() },
          ],
        },
        fingerprint: "synthetic-fingerprint",
      })),
    );
    await client.insert(assessmentState).values(
      rows.map((row) => ({
        id: row.id,
        family: "statement_transaction" as const,
        entity: "statementRow",
        recordId: crypto.randomUUID(),
        data,
        status,
      })),
    );
  }
  const [key, revision] = input.stamp.split("@");
  if (input.automatic)
    await client.insert(feedback).values(
      rows.map((row) => ({
        assessmentId: row.id,
        operationId: "command-application:automatic:synthetic",
        verdict: "ungraded",
        correction: { present: false as const },
        intent: "apply",
        authority: "automatic",
        actorUserId: systemActor().userId,
        receipt: {},
        metadata: {
          kind: "assessment_application",
          rule: { key, revision, stamp: input.stamp },
        },
        createdAt: new Date(row.at.getTime() - 1_000_000),
      })),
    );
  await client.insert(feedback).values(
    rows.map((row) => ({
      assessmentId: row.id,
      operationId: "synthetic-review",
      verdict: row.verdict,
      correction:
        input.correction === undefined
          ? { present: false as const }
          : { present: true as const, value: z.json().parse(input.correction) },
      intent: "history",
      authority: "member",
      actorUserId: ctx.actor.userId,
      createdAt: row.at,
    })),
  );
  return rows.map((row) => row.id);
}

const times = (count: number, verdict: Verdict) =>
  Array.from({ length: count }, () => verdict);

const ruleOf = async (ctx: Ctx, key: AutomaticRuleKey) =>
  (await listAutomaticRules(ctx.db)).rules.find(
    (rule) => rule.ruleKey === key,
  )!;

const feedbackFor = async (ctx: Ctx, assessmentId: string) =>
  (
    await getDb(ctx.db).execute<{
      authority: string;
      verdict: string;
      metadata: { kind?: string; rule?: { key: string; stamp: string } };
    }>(
      sql`SELECT authority, verdict, metadata FROM "Feedback" WHERE "assessmentId" = ${assessmentId}::uuid ORDER BY "createdAt"`,
    )
  ).rows;

const stateOf = async (ctx: Ctx, assessmentId: string) =>
  (
    await getDb(ctx.db).execute<{
      status: string;
      data: { matchedRules?: string[]; auditSample?: boolean };
    }>(
      sql`SELECT status, data FROM "AssessmentState" WHERE id = ${assessmentId}::uuid`,
    )
  ).rows[0]!;

// --- statement fixtures: one charge whose only candidate is the same money ---

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

const eligibleFor = (ctx: Ctx, models: readonly string[]) =>
  Promise.all(
    models.map((model) =>
      seedReviews(ctx, {
        family: "statement_transaction",
        stamp: `${ruleBase(ATTACH)}@${model}`,
        verdicts: times(50, "correct"),
      }),
    ),
  );

describe("Automatic rules", () => {
  const ctx = withTestDb();

  // Failure modes: a rule turns on below 50 reviews or below 98%; a system
  // actor flips a member's switch; turning a rule off is refused.
  it("turns a rule on only at 50 reviews and 98% precision, by a member", async () => {
    const stamp = `${ruleBase(ATTACH)}@typesafe/jev`;
    await seedReviews(ctx, {
      family: "statement_transaction",
      stamp,
      verdicts: [...times(48, "correct"), "wrong"],
    });
    expect(await ruleOf(ctx, ATTACH)).toMatchObject({
      enabled: false,
      eligible: false,
      n: 49,
      hits: 48,
    });
    const enable = () =>
      setAutomaticRule(ctx.db, ctx.actor, { ruleKey: ATTACH, enabled: true });
    await expect(enable()).rejects.toThrow(/not eligible.*n=49, hits=48/);
    await seedReviews(ctx, {
      family: "statement_transaction",
      stamp,
      verdicts: ["dismissed"],
      agedFrom: 100,
    });
    // n=50, 48/50 = 96%.
    await expect(enable()).rejects.toThrow(/n=50, hits=48/);
    await seedReviews(ctx, {
      family: "statement_transaction",
      stamp,
      verdicts: times(50, "correct"),
      agedFrom: 200,
    });
    // n=100, 98/100: exactly the bar.
    await expect(
      setAutomaticRule(ctx.db, systemActor(), {
        ruleKey: ATTACH,
        enabled: true,
      }),
    ).rejects.toThrow(/Only a member/);
    expect(await enable()).toMatchObject({
      enabled: true,
      eligible: true,
      n: 100,
      hits: 98,
      enabledByUserId: ctx.actor.userId,
    });
    // Off needs no eligibility: the field rule has no reviews at all.
    expect(
      await setAutomaticRule(ctx.db, ctx.actor, {
        ruleKey: ADDITION,
        enabled: false,
      }),
    ).toMatchObject({ enabled: false, n: 0, eligible: false });
  });

  // Failure modes: automatic applications inflate their own precision; a
  // Wrong on one disappears; an older revision's reviews still count; the
  // window grows past the latest 200; a correction choosing the rule's own
  // candidate counts against it.
  it("measures only served matches of the current revision in the latest 200", async () => {
    await seedReviews(ctx, {
      family: "field",
      stamp: ruleBase(ADDITION),
      verdicts: times(10, "correct"),
    });
    await seedReviews(ctx, {
      family: "field",
      stamp: ruleBase(ADDITION),
      verdicts: ["wrong", "wrong", "correct"],
      automatic: true,
    });
    await seedReviews(ctx, {
      family: "field",
      stamp: "field.addition@2000-01-01.1",
      verdicts: times(5, "wrong"),
    });
    expect(await ruleOf(ctx, ADDITION)).toMatchObject({
      n: 10,
      hits: 10,
      precision: 1,
      correctedAutomatic: 2,
      windows: [
        expect.objectContaining({ stamp: ruleBase(ADDITION), model: null }),
      ],
    });

    const account = (await card(ctx)).output;
    const candidate = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 12,
        postedDate: "2026-05-05",
        merchant: "Example Grocer",
        rawDescription: "EXAMPLE GROCER",
        sourceRefs: [],
      })
    ).output;
    const clef = `${ruleBase(ATTACH)}@@cf/cloudflare/clef`;
    const attachSame = {
      kind: "statement_transaction",
      action: "attach",
      transactionId: candidate.id,
      fields: ["postedDate"],
      rejectedCandidateIds: [],
    };
    await seedReviews(ctx, {
      family: "statement_transaction",
      stamp: clef,
      verdicts: ["wrong"],
      candidateId: (
        await getDb(ctx.db).execute<{ id: string }>(
          sql`SELECT id FROM "FinancialTransaction" WHERE shortcode = ${candidate.id}`,
        )
      ).rows[0]!.id,
      correction: attachSame,
    });
    await seedReviews(ctx, {
      family: "statement_transaction",
      stamp: clef,
      verdicts: ["wrong"],
      correction: { ...attachSame, action: "create" },
      agedFrom: 10,
    });
    const jev = `${ruleBase(ATTACH)}@typesafe/jev`;
    // The 10 oldest of 210 are Wrong and fall outside the window.
    await seedReviews(ctx, {
      family: "statement_transaction",
      stamp: jev,
      verdicts: [...times(200, "correct"), ...times(10, "wrong")],
    });
    const attach = await ruleOf(ctx, ATTACH);
    expect(attach.windows).toEqual([
      expect.objectContaining({
        stamp: clef,
        model: "@cf/cloudflare/clef",
        n: 2,
        hits: 1,
      }),
      expect.objectContaining({
        stamp: jev,
        model: "typesafe/jev",
        n: 200,
        hits: 200,
        eligible: true,
      }),
    ]);
    expect(attach.eligible).toBe(true);
  });

  // Failure mode: audited Wrongs pile up while the rule keeps applying.
  it("turns itself off when a member review takes audited precision below 98%", async () => {
    await seedReviews(ctx, {
      family: "field",
      stamp: ruleBase(ADDITION),
      verdicts: [...times(48, "correct"), "wrong"],
      agedFrom: 10,
    });
    // An audit-sample match a member is about to review.
    const id = crypto.randomUUID();
    await getDb(ctx.db)
      .insert(assessmentState)
      .values({
        id,
        family: "field",
        entity: "product",
        recordId: crypto.randomUUID(),
        field: "categoryId",
        kind: "addition",
        confidence: 0.97,
        model: "typesafe/jev",
        data: { matchedRules: [ruleBase(ADDITION)], auditSample: true },
        status: "pending",
      });
    expect(await ruleOf(ctx, ADDITION)).toMatchObject({ enabled: true, n: 49 });
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    });
    expect(await ruleOf(ctx, ADDITION)).toMatchObject({
      enabled: false,
      n: 50,
      hits: 48,
      disabledReason: expect.stringMatching(
        /Turned itself off.*n=50, hits=48, precision=0\.96,/,
      ),
    });
  });

  // Failure mode: a label page built up front publishes a charge with
  // evidence an automatic rule earlier in the page already changed, so its
  // suggestion fails as stale on accept.
  it("leaves no stale suggestion after an automatic attach mid-page", async () => {
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
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    await eligibleFor(ctx, supportedDecisionModelSchema.options);
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    await label(ctx);
    const rows = (await listStatementRows(ctx.db, {})).data;
    expect(rows.filter((row) => row.matchState === "matched")).toEqual([
      expect.objectContaining({ transactionId: existing.id }),
    ]);
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
    expect(pending).toHaveLength(1);
    // Every pending suggestion still matches its charge's current evidence.
    for (const row of pending) {
      const [current] = await buildChargeProposals(ctx.db, [row]);
      expect(current?.evidenceFingerprint).toBe(row.evidenceFingerprint);
    }
  });

  // Failure modes: an automatic attach ticks diff fields, bypasses the
  // family apply path, records member Feedback, or applies twice on replay.
  it("attaches a sole same-charge candidate through the review path, once", async () => {
    await createSystemUserFixture(ctx.db);
    const { existing } = await soleCandidateCharge(ctx);
    await eligibleFor(ctx, supportedDecisionModelSchema.options);
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    const state = await stateOf(ctx, suggestion.id);
    expect(state.data.auditSample).toBe(false);
    expect(state.status).toBe("applied");
    const [stamp] = state.data.matchedRules!;
    expect(stamp).toMatch(/^statement_transaction\.attach@.+@.+/);
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

    const view = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      appliedAutomatically: true,
    });
    expect(view.items).toEqual([
      expect.objectContaining({
        assessmentId: suggestion.id,
        automaticRule: `${ruleBase(ATTACH)}`,
        matchedRules: [stamp],
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
    await eligibleFor(ctx, supportedDecisionModelSchema.options);
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
            stamp: `${ruleBase(ATTACH)}@synthetic-model`,
          },
        },
      ),
    ).rejects.toThrow(/is off; review the suggestion/);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("pending");
    expect(await feedbackFor(ctx, suggestion.id)).toEqual([]);
  });

  // Failure modes: turning the rule on for one measured model authorizes
  // another; evidence that drifted after publication is applied anyway.
  it("applies nothing for an unmeasured model or drifted evidence", async () => {
    await createSystemUserFixture(ctx.db);
    const { account } = await soleCandidateCharge(ctx);
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    const [stamp] = (await stateOf(ctx, suggestion.id)).data.matchedRules!;
    const others = supportedDecisionModelSchema.options.filter(
      (model) => !stamp!.endsWith(`@${model}`),
    );
    await eligibleFor(ctx, others);
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: ATTACH,
      enabled: true,
    });
    expect(await applyAutomaticRules(ctx.db, [suggestion.id])).toMatchObject({
      applied: [],
      refused: [],
    });
    expect((await stateOf(ctx, suggestion.id)).status).toBe("pending");

    await eligibleFor(
      ctx,
      supportedDecisionModelSchema.options.filter(
        (model) => !others.includes(model),
      ),
    );
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
