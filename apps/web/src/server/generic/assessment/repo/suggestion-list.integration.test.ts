import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  ASSESSMENT_READ_RULES_VERSION,
  ASSESSMENT_READ_TARGET,
  assessmentReadCoverage,
  assessmentReadFact,
  assessmentReadScopedSourceKind,
  type AssessmentReadDependency,
  type AssessmentReadResult,
} from "@cubby/schemas/assessment-read-publication";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import {
  recordSourceTransactionRecordsInput,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { suggestionListFilters } from "@cubby/schemas/suggestion-list";
import { eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity, createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { textHashRefSql } from "~/server/db/derived-source-ref";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  assessmentReadPublication,
  assessmentReadDependency,
  financialTransactionAllocation,
  financialTransaction,
  product as productTable,
  sourceTransactionRecord,
  transactionImport,
} from "~/server/db/schema";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { pendingSuggestionsWorkSource } from "~/server/domains/work/repo/work-suggestions";
import { executeEntity } from "~/server/entity-kernel";
import {
  writeAssessmentReadStage,
  readAssessmentReadStage,
  publishedAssessmentAdmissionSql,
  publishedAssessmentCoverageSql,
  publishedAssessmentRecordRefsSql,
  assessmentReadSourceSelection,
  type AssessmentReadStagePlan,
  type AssessmentReadStageWrite,
} from "~/server/generic/assessment/repo/read-publication";
import {
  readAssessmentRecordRefs,
  readAssessmentReadMemberships,
  touchingAssessmentIds,
} from "~/server/generic/assessment/repo/review-families";
import { suggestionFamilies } from "~/server/generic/assessment/repo/suggestion-families";
import {
  prepareAssessmentReadPublication,
  prepareCanonicalAssessmentReadPublication,
} from "~/server/generic/assessment/service/read-publication";
import { isDerivedSink } from "~/server/generic/derived/repo/compute";
import {
  DERIVED_DRAIN,
  derivedFanoutSourceScope,
} from "~/server/generic/derived/repo/drain";
import {
  readWorkItems,
  deleteWorkItems,
  updateWorkItems,
} from "~/server/generic/jobs/jobs.fixtures";
import { markWork } from "~/server/generic/jobs/repo/work-items";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  readWorkQueueWith,
  readRecordWorkQueueWith,
} from "~/server/generic/work-queue/repo/work-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

import {
  automaticApplicationRule,
  publishFieldAssessment,
  recordFeedback,
} from "./assessment";
import { reviewAssessment } from "./assessment-review";
import { listAutomaticDecisions } from "./automatic-decisions";
import {
  acceptCleanSuggestions,
  listSuggestionPage as readPublishedPage,
  prepareSuggestionAdmission,
  suggestionKeyFacts,
  suggestionRecordCounts,
  suggestionCountsByFamily as readPublishedCounts,
} from "./suggestion-list";
import {
  prepareTagSuggestionPublication,
  tagSourceRevision,
} from "./tag-suggestions";

type Ctx = ReturnType<typeof withTestDb>;

let position = 0;
const rowInput = (
  overrides: Partial<SourceTransactionRecordInput> = {},
): SourceTransactionRecordInput => ({
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
const importInput = (
  overrides: Partial<TransactionImportInput> = {},
): TransactionImportInput => ({
  source: "monarch",
  label: "synthetic-export.csv",
  fingerprint: "fp-list-1",
  dateKind: "posted" as const,
  rowCountDeclared: null,
  notes: null,
  ...overrides,
});
const record = (
  ctx: Ctx,
  rows: SourceTransactionRecordInput[],
  overrides: Partial<TransactionImportInput> = {},
) =>
  recordSourceTransactionRecords(
    ctx.db,
    recordSourceTransactionRecordsInput.parse({
      import: importInput(overrides),
      rows,
    }),
    ctx.actor,
  );
const card = (ctx: Ctx) =>
  createRepoEntity(ctx, "financialAccount", {
    name: "Synthetic Card",
    identity: { kind: "credit_card", network: "visa" },
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
  for (;;) {
    const page = await generateStatementSuggestionPage(ctx.db, {
      after,
      runId: null,
    });
    if (!page.next) return;
    after = page.next;
  }
};

async function fieldSuggestion(
  ctx: Ctx,
  product: { entityId: string },
  field: string,
  confidence: number,
  createdAt: Date,
) {
  const row = await publishFieldAssessment(
    ctx.db,
    {
      entity: "product",
      recordId: product.entityId,
      field,
      currentValue: null,
      suggestedValue: `Synthetic ${field}`,
      confidence,
      model: "typesafe/jev",
      kind: "addition",
      status: "pending",
      createdAt,
    },
    true,
  );
  return row.id;
}

async function connection(ctx: Ctx) {
  const item = await createProductFixture(
    ctx.db,
    makeProductInput({ name: "Synthetic connection saw" }),
    ctx.actor,
  );
  const charge = await createRepoEntity(ctx, "expense", {
    name: "Synthetic saw charge",
    cost: 24,
    trade: "building",
    costType: "tools",
  });
  const proposal = await publishEntityConnection(ctx.db, {
    relation: "product-expense",
    source: { entityKind: "product", entityId: item.id },
    target: { entityKind: "expense", entityId: charge.output.id },
    label: "Connect acquisition charge",
    evidence: {
      reasons: ["Member review required"],
      contradictions: [],
      unknowns: [],
    },
  });
  return { item, charge, proposal };
}

const RANK = { strong: 2, medium: 1, weak: 0 } as const;
const readyKey = (row: SuggestionListRow) =>
  [Number(row.clean), RANK[row.strength], Date.parse(row.createdAt)] as const;

describe("cross-family Suggestion list", () => {
  const ctx = withTestDb();
  const publishReadFacts = async (ids: readonly string[]) => {
    const prepared = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      ids,
      async () => () => sql`true`,
    );
    expect([...prepared.failures]).toEqual([]);
    expect(prepared.retained).toEqual([]);
    for (const component of prepared.components)
      expect(
        await withTransactionDatabase(ctx.db, (tx) =>
          writeAssessmentReadStage(tx, component.prepared, {
            notify: () => undefined,
          }),
        ),
      ).toMatchObject({ kind: "activated" });
  };
  // These journeys compare completed background publications with the former
  // canonical results. Bare readers below separately verify missing coverage.
  const refreshReadFacts = async () => {
    const ids = (
      await getDb(ctx.db)
        .select({ id: assessmentState.id })
        .from(assessmentState)
        .where(
          sql`${assessmentState.active} AND ${assessmentState.status} = ${"pending"}`,
        )
    ).map(({ id }) => id);
    for (let start = 0; start < ids.length; start += 20)
      await publishReadFacts(ids.slice(start, start + 20));
  };
  const refreshAndListSuggestions = async (
    ...args: Parameters<typeof readPublishedPage>
  ) => {
    await refreshReadFacts();
    return readPublishedPage(...args);
  };
  const refreshAndCountSuggestions = async (
    ...args: Parameters<typeof readPublishedCounts>
  ) => {
    await refreshReadFacts();
    return readPublishedCounts(...args);
  };

  it("omits ignored statement evidence without a retirement pass", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          family: "statement_transaction",
        })
      ).items,
    ).toHaveLength(1);
    await getDb(ctx.db).update(sourceTransactionRecord).set({
      disposition: "ignored",
      dispositionReason: "not_modeled",
      dispositionNote: "Synthetic unmodeled charge",
    });
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          family: "statement_transaction",
        })
      ).items,
    ).toEqual([]);
  });

  // Entity-wide history can contain more ids than a Postgres Bind message
  // permits. A scoped key read must use a bounded number of parameters.
  it("reads a large assessment roster through every proposal adapter", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic roster product" }),
      ctx.actor,
    );
    const id = await fieldSuggestion(ctx, item, "model", 0.9, new Date());
    const assessmentIds = [
      id,
      ...Array.from({ length: 65536 }, () => crypto.randomUUID()),
    ];
    for (const [family, presentation] of Object.entries(suggestionFamilies)) {
      const keys = await presentation.keys(ctx.db, {
        filters: suggestionListFilters.parse({}),
        assessmentIds,
      });
      expect(keys.map((key) => key.assessmentId)).toEqual(
        family === "field" ? [id] : [],
      );
    }
    // Per-record counts expand the whole touching roster, not only one page.
    expect(
      (await readAssessmentRecordRefs(ctx.db, assessmentIds)).get(id),
    ).toEqual([{ entity: "product", id: item.id }]);
    const claimed = [id];
    for (let index = 0; index < 20; index++) {
      const source = await createProductFixture(
        ctx.db,
        makeProductInput({ name: `Synthetic bounded publication ${index}` }),
        ctx.actor,
      );
      claimed.push(
        await fieldSuggestion(ctx, source, "model", 0.9, new Date()),
      );
    }
    const bounded = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      claimed,
      async () => () => sql`true`,
    );
    expect(bounded.components.flatMap(({ plan }) => plan.idsToPrepare)).toEqual(
      claimed.slice(0, 20),
    );
    expect(bounded.retained).toEqual(claimed.slice(20));
    expect(bounded.failures.size).toBe(0);
    const resumed = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      bounded.retained,
      async () => () => sql`true`,
    );
    expect(
      resumed.components.flatMap(({ prepared }) =>
        prepared.results.flatMap((result) =>
          result.facts.map((fact) => fact.key.assessmentId),
        ),
      ),
    ).toEqual(claimed.slice(20));
    expect(resumed.retained).toEqual([]);
    await recordFeedback(ctx.db, {
      assessmentId: id,
      operationId: "synthetic.hidden-field-inputs",
      verdict: "ungraded",
      authority: "automatic",
      intent: "apply",
      actorUserId: ctx.actor.userId,
      metadata: {
        kind: "assessment_application",
        rule: { key: "synthetic-field-rule", revision: 1 },
      },
      receipt: { synthetic: true },
    });
    const hidden = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      [id],
      async () => () => sql`true`,
    );
    expect(hidden.failures.size).toBe(0);
    expect(
      hidden.components.flatMap(({ prepared }) => prepared.results),
    ).toMatchObject([
      {
        assessmentId: id,
        facts: [],
        dependencies: expect.arrayContaining([
          { sourceKind: "product", sourceId: item.entityId },
          { sourceKind: "assessment.fieldWrite", sourceId: item.entityId },
        ]),
      },
    ]);
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ data: sql`${assessmentState.data} - 'liveInputFingerprint'` })
      .where(eq(assessmentState.id, id));
    const unavailable = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      [id],
      async () => () => sql`true`,
    );
    expect(unavailable.failures.size).toBe(0);
    expect(
      unavailable.components.flatMap(({ prepared }) => prepared.results),
    ).toEqual(hidden.components.flatMap(({ prepared }) => prepared.results));
    await getDb(ctx.db)
      .update(assessment)
      .set({ served: false })
      .where(eq(assessment.id, id));
    const unserved = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      [id],
      async () => () => sql`true`,
    );
    expect(unserved.failures.size).toBe(0);
    expect(
      unserved.components.flatMap(({ prepared }) => prepared.results),
    ).toEqual([
      {
        assessmentId: id,
        groupKey: `assessment:${id}`,
        facts: [],
        memberships: [],
        dependencies: [],
      },
    ]);
    await getDb(ctx.db)
      .update(assessment)
      .set({ served: true })
      .where(eq(assessment.id, id));
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ active: false, status: "superseded" })
      .where(eq(assessmentState.id, id));
    const closed = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      [id],
      async () => () => sql`true`,
    );
    expect(closed.failures.size).toBe(0);
    expect(
      closed.components.flatMap(({ prepared }) => prepared.results),
    ).toEqual([
      {
        assessmentId: id,
        groupKey: `assessment:${id}`,
        facts: [],
        memberships: [],
        dependencies: [],
      },
    ]);
    await markWork(
      ctx.db,
      DERIVED_DRAIN,
      claimed.map((ref) => ({ target: ASSESSMENT_READ_TARGET, ref })),
    );
    const adapter = derivedComputes[ASSESSMENT_READ_TARGET];
    if (!adapter || !isDerivedSink(adapter))
      throw new Error("Synthetic Assessment sink missing");
    const prepared = await adapter.prepare(ctx.db, claimed);
    expect(adapter.preparationFailures?.(prepared).size).toBe(0);
    const tickets = async () =>
      new Map(
        (await readWorkItems(ctx.db, { target: ASSESSMENT_READ_TARGET })).map(
          (item) => [item.ref, item.ticket],
        ),
      );
    const notified = new Set<string>();
    const publication = {
      tickets: await tickets(),
      notify: (entity: string, refs: readonly string[]) => {
        for (const ref of refs) notified.add(`${entity}:${ref}`);
      },
    };
    const outcome = await withTransactionDatabase(ctx.db, (tx) =>
      adapter.publish(tx, claimed, prepared, publication),
    );
    expect(outcome).toMatchObject({ retain: claimed.slice(20) });
    expect(notified.size).toBeGreaterThan(0);
    // The sink reports completion; only the generic settlement owner clears work.
    expect((await tickets()).size).toBe(claimed.length);
    await markWork(ctx.db, DERIVED_DRAIN, [
      { target: ASSESSMENT_READ_TARGET, ref: id },
    ]);
    const replay = await withTransactionDatabase(ctx.db, (tx) =>
      adapter.publish(tx, [id], prepared, {
        ...publication,
        tickets: new Map(),
      }),
    );
    expect(replay).toMatchObject({ retain: [id], changed: [], covered: [] });
    const currentTickets = await tickets();
    const blocked = adapter.publicationBlocked?.(prepared, [id]);
    const mixed = adapter.publicationBlocked?.(prepared, claimed);
    if (!blocked || !mixed)
      throw new Error("Synthetic Assessment source fence missing");
    expect(
      (
        await getDb(ctx.db).execute(
          sql`SELECT ${blocked} AS blocked, ${mixed} AS mixed`,
        )
      ).rows,
    ).toEqual([{ blocked: true, mixed: false }]);
    const remarked = await withTransactionDatabase(ctx.db, (tx) =>
      adapter.publish(tx, [id], prepared, {
        ...publication,
        tickets: currentTickets,
      }),
    );
    expect(remarked).toMatchObject({ retain: [id], changed: [], covered: [] });
  });

  // Reference proposals touch both the old and proposed records, even when
  // neither is the field's primary subject or entity kind.
  it("scopes reference-valued field proposals to both referenced records", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic reference drill" }),
      ctx.actor,
    );
    const current = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic current tools",
    });
    const proposed = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic proposed tools",
    });
    const id = await fieldSuggestion(ctx, item, "categoryId", 0.9, new Date());
    await getDb(ctx.db)
      .update(assessmentState)
      .set({
        currentValue: current.output.id,
        suggestedValue: proposed.output.id,
      })
      .where(eq(assessmentState.id, id));
    const memberships = (await readAssessmentReadMemberships(ctx.db, [id])).get(
      id,
    );
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "scope",
          entity: "productCategory",
          value: current.output.id,
          stateFamily: "field",
          retained: false,
        }),
        expect.objectContaining({
          kind: "scope",
          entity: "productCategory",
          value: proposed.output.id,
          stateFamily: "field",
          retained: false,
        }),
      ]),
    );
    const references =
      (await readAssessmentRecordRefs(ctx.db, [id])).get(id) ?? [];
    expect(
      memberships
        ?.filter((row) => row.kind === "ref")
        .map((row) => ({ entity: row.entity, id: row.value })),
    ).toEqual(expect.arrayContaining(references));
    expect(memberships?.filter((row) => row.kind === "ref")).toHaveLength(
      references.length,
    );
    expect(
      await suggestionRecordCounts(ctx.db, { recordIds: [current.output.id] }),
    ).toMatchObject({
      records: [{ id: current.output.id, pending: 1 }],
      coverage: { missing: false },
    });
    await publishReadFacts([id]);
    for (const record of [current.output.id, proposed.output.id]) {
      const page = await refreshAndListSuggestions(ctx.db, {
        family: "field",
        recordEntity: "productCategory",
        recordIds: [record],
      });
      expect(page.items.map((row) => row.assessmentId)).toEqual([id]);
      expect(
        (await suggestionRecordCounts(ctx.db, { recordIds: [record] })).records,
      ).toEqual([{ id: record, pending: 1 }]);
    }
  });

  // A row can offer several existing Transactions; every candidate must expose
  // review, rather than only the preferred candidate or owning account.
  it("scopes a statement proposal to its account and every candidate", async () => {
    const account = (await card(ctx)).output;
    const candidates = await Promise.all(
      ["2026-05-04", "2026-05-05"].map(
        async (postedDate) =>
          (
            await createRepoEntity(ctx, "financialTransaction", {
              accountId: account.id,
              kind: "purchase",
              status: "posted",
              amount: 42.5,
              postedDate,
              merchant: "Example Grocer",
              sourceRefs: [],
            })
          ).output,
      ),
    );
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const unscoped = await refreshAndListSuggestions(ctx.db, {
      family: "statement_transaction",
    });
    expect(unscoped.items).toHaveLength(1);
    for (const id of [
      account.id,
      ...candidates.map((candidate) => candidate.id),
    ]) {
      expect(
        (
          await refreshAndListSuggestions(ctx.db, {
            family: "statement_transaction",
            recordIds: [id],
          })
        ).items.map((row) => row.assessmentId),
      ).toEqual(unscoped.items.map((row) => row.assessmentId));
    }
  });

  it("scopes statement history through settlement allocations to Expenses", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [
      rowInput({ providerTransactionId: "synthetic-scope-charge" }),
    ]);
    await generate(ctx);
    const [source] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord)
      .where(
        eq(
          sourceTransactionRecord.providerTransactionId,
          "synthetic-scope-charge",
        ),
      );
    if (!source) throw new Error("Synthetic source observation missing");
    const proposal = (
      await refreshAndListSuggestions(ctx.db, {
        family: "statement_transaction",
      })
    ).items.find(
      (row) =>
        row.family === "statement_transaction" &&
        row.evidence.rawDescription === "EXAMPLE GROCER 0001",
    );
    if (!proposal) throw new Error("Synthetic statement proposal missing");
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic settlement vendor",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
    });
    const expense = await createRepoEntity(ctx, "expense", {
      name: "Synthetic allocated line",
      purchaseId: purchase.output.id,
      date: "2026-05-04",
      cost: 42.5,
      costType: "materials",
      trade: "building",
    });
    const unrelated = await createRepoEntity(ctx, "expense", {
      name: "Synthetic unrelated line",
      costType: "materials",
      trade: "building",
    });
    const settled = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      sourceRefs: [{ source: "monarch", externalId: source.externalId }],
      allocations: [{ purchaseId: purchase.output.id, amount: 42.5 }],
    });
    const expenseId = await resolveOrThrow(
      ctx.db,
      "expense",
      expense.output.id,
    );
    const unrelatedId = await resolveOrThrow(
      ctx.db,
      "expense",
      unrelated.output.id,
    );
    const accountId = await resolveOrThrow(
      ctx.db,
      "financialAccount",
      account.id,
    );
    // These observations and settlement edges arrived before any publication
    // dependencies. Current indexed associations must still enroll the advice.
    const transactionId = await resolveOrThrow(
      ctx.db,
      "financialTransaction",
      settled.output.id,
    );
    for (const [kind, id] of [
      ["sourceTransactionRecord", source.id],
      ["financialAccount", accountId],
      ["financialTransaction", transactionId],
    ]) {
      if (!kind || !id) throw new Error("Synthetic Statement input missing");
      const affected = await getDb(ctx.db).execute(
        assessmentReadSourceSelection(kind, sql`SELECT ${id}::uuid AS id`),
      );
      expect(affected.rows.map((row) => row.id)).toContain(
        proposal.assessmentId,
      );
    }
    const expenseRef = {
      entity: "expense",
      id: expenseId,
      code: expense.output.id,
    };
    const unrelatedRef = {
      entity: "expense",
      id: unrelatedId,
      code: unrelated.output.id,
    };
    const accountRef = {
      entity: "financialAccount",
      id: accountId,
      code: account.id,
    };
    const eligibility = {
      kind: "suggestions",
      families: [assessmentFamily.enum.statement_transaction],
      status: "pending",
    } satisfies Parameters<typeof touchingAssessmentIds>[1]["eligibility"];
    const scoped = async (
      records: NonNullable<
        Parameters<typeof touchingAssessmentIds>[1]["records"]
      >,
    ) =>
      await touchingAssessmentIds(ctx.db, {
        records,
        eligibility,
      });
    expect(await scoped([expenseRef])).toContain(proposal.assessmentId);
    expect(await scoped([unrelatedRef])).not.toContain(proposal.assessmentId);
    expect(await scoped([unrelatedRef, accountRef])).toContain(
      proposal.assessmentId,
    );
    expect(
      await touchingAssessmentIds(ctx.db, { entity: "expense", eligibility }),
    ).toContain(proposal.assessmentId);

    const purchaseId = await resolveOrThrow(
      ctx.db,
      "purchase",
      purchase.output.id,
    );
    await getDb(ctx.db)
      .update(financialTransactionAllocation)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId));
    expect(await scoped([expenseRef])).not.toContain(proposal.assessmentId);
    await getDb(ctx.db)
      .update(financialTransactionAllocation)
      .set({ deletedAt: null })
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId));

    const otherAccount = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic settlement account",
      identity: { kind: "bank_account", accountType: "checking" },
    });
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ accountId: otherAccount.entityId })
      .where(eq(financialTransaction.id, settled.entityId));
    const observedInputs = new Map<
      string,
      readonly AssessmentReadDependency[]
    >();
    const publishedMemberships = await readAssessmentReadMemberships(
      ctx.db,
      [proposal.assessmentId],
      (id, inputs) => observedInputs.set(id, inputs),
    );
    const inputs = observedInputs.get(proposal.assessmentId) ?? [];
    expect(inputs).toEqual(
      expect.arrayContaining([
        { sourceKind: "sourceTransactionRecord", sourceId: source.id },
        { sourceKind: "financialTransaction", sourceId: settled.entityId },
        { sourceKind: "financialAccount", sourceId: accountId },
        { sourceKind: "financialAccount", sourceId: otherAccount.entityId },
        { sourceKind: "purchase", sourceId: purchaseId },
        { sourceKind: "expense", sourceId: expenseId },
      ]),
    );
    expect(publishedMemberships.get(proposal.assessmentId)).not.toContainEqual(
      expect.objectContaining({
        entity: "financialAccount",
        value: otherAccount.output.id,
      }),
    );
    const hashes = await getDb(ctx.db).execute(sql`SELECT
      ${textHashRefSql(sql`${source.chargeKey}::text`)}::text AS charge,
      ${textHashRefSql(sql`${source.externalId}::text`)}::text AS ref`);
    expect(inputs).toEqual(
      expect.arrayContaining([
        {
          sourceKind: assessmentReadScopedSourceKind.enum.statementCharge,
          sourceId: hashes.rows[0]?.charge,
        },
        {
          sourceKind: assessmentReadScopedSourceKind.enum.statementRef,
          sourceId: hashes.rows[0]?.ref,
        },
      ]),
    );

    await getDb(ctx.db)
      .update(assessmentState)
      .set({ status: "superseded", active: false })
      .where(eq(assessmentState.id, proposal.assessmentId));
    await recordFeedback(ctx.db, {
      assessmentId: proposal.assessmentId,
      operationId: "synthetic.statement-history",
      verdict: "ungraded",
      authority: "automatic",
      intent: "apply",
      actorUserId: ctx.actor.userId,
      metadata: {
        kind: "assessment_application",
        rule: { key: "synthetic-statement-rule", revision: 1 },
      },
      receipt: { synthetic: true },
    });
    const history = async (recordIds: string[]) =>
      (
        await listAutomaticDecisions(ctx.db, {
          family: "statement_transaction",
          recordIds,
        })
      ).items.map((row) => row.id);
    expect(await history([expense.output.id])).toContain(proposal.assessmentId);
    expect(await history([unrelated.output.id])).not.toContain(
      proposal.assessmentId,
    );
    expect(await history([unrelated.output.id, account.id])).toContain(
      proposal.assessmentId,
    );
    expect(
      await touchingAssessmentIds(ctx.db, {
        entity: "expense",
        eligibility: {
          kind: "automatic",
          appliedRule: automaticApplicationRule,
        },
      }),
    ).toContain(proposal.assessmentId);

    await getDb(ctx.db)
      .update(financialTransactionAllocation)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId));
    expect(await history([expense.output.id])).not.toContain(
      proposal.assessmentId,
    );
  });

  it("excludes matching column values while keeping null and absent values", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic exclusion product" }),
      ctx.actor,
    );
    await fieldSuggestion(ctx, product, "model", 0.95, new Date());
    const page = await refreshAndListSuggestions(ctx.db, {});
    expect(page.items).toHaveLength(2);
    expect(
      page.items.find((row) => row.family === "statement_transaction")?.columns
        .owner,
    ).toBeNull();
    expect(
      page.items.find((row) => row.family === "field")?.columns.owner,
    ).toBeUndefined();
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          ownerExclude: ["LPY-2A2A"],
        })
      ).items.map((row) => row.id),
    ).toEqual(page.items.map((row) => row.id));
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          accountExclude: [account.id],
        })
      ).items.map((row) => row.family),
    ).toEqual(["field"]);
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          family: "statement_transaction",
          account: [account.id],
          accountExclude: [account.id],
        })
      ).items,
    ).toEqual([]);
  });

  // Failure modes: one family's rows sort as a block instead of interleaving
  // by readiness; a weak row outranks a clean one; paging repeats or skips.
  it("orders every family clean first, then by Strength, then newest", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic ordered product" }),
      ctx.actor,
    );
    const confident = await fieldSuggestion(
      ctx,
      product,
      "model",
      0.95,
      new Date("2026-01-01T00:00:00Z"),
    );
    const unsure = await fieldSuggestion(
      ctx,
      product,
      "brandName",
      0.7,
      new Date("2026-01-02T00:00:00Z"),
    );
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const { proposal } = await connection(ctx);

    const page = await refreshAndListSuggestions(ctx.db, { limit: 200 });
    expect(new Set(page.items.map((row) => row.family))).toEqual(
      new Set(["field", "statement_transaction", "recommendation"]),
    );
    for (const [index, row] of page.items.entries()) {
      const previous = page.items[index - 1];
      if (!previous) continue;
      const [a, b] = [readyKey(previous), readyKey(row)];
      expect(
        a[0] > b[0] ||
          (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]))),
      ).toBe(true);
    }
    const ids = page.items.map((row) => row.id);
    // Reset only synthetic publications for the first-publication recovery
    // journey. Source rows, member decisions and durable tickets remain.
    await getDb(ctx.db).delete(assessmentReadPublication);
    await getDb(ctx.db).delete(assessmentReadDependency);
    await markWork(
      ctx.db,
      DERIVED_DRAIN,
      ids.map((ref) => ({ target: ASSESSMENT_READ_TARGET, ref })),
    );
    const observe = async () =>
      (await readWorkItems(ctx.db))
        .filter(
          ({ target }) =>
            target === ASSESSMENT_READ_TARGET ||
            target.startsWith(`${ASSESSMENT_READ_TARGET}@`),
        )
        .map(({ target, ref, ticket }) => ({ target, ref, ticket }));
    const observed = await observe();
    const publishedFacts = async (
      scope?: Parameters<typeof publishedAssessmentAdmissionSql>[0],
    ) =>
      assessmentReadFact
        .array()
        .parse(
          (await getDb(ctx.db).execute(publishedAssessmentAdmissionSql(scope)))
            .rows,
        );
    const coverage = async () =>
      assessmentReadCoverage.parse(
        (await getDb(ctx.db).execute(publishedAssessmentCoverageSql())).rows[0],
      );
    const readPublishedWork = (
      input: Parameters<typeof readWorkQueueWith>[2]["input"] = {},
    ) =>
      readWorkQueueWith(
        ctx.db,
        { sources: [pendingSuggestionsWorkSource], deferrals: [] },
        {
          input: { pageSize: 100, ...input },
          memberPartyId: null,
          memberOnly: false,
        },
      );
    const missingWork = await readPublishedWork();
    expect(missingWork.meta.totalCount).toBeGreaterThan(0);
    // Work reads pending State directly, so there is no publication coverage warning.
    expect(missingWork.meta.incompleteSources).toEqual([]);
    expect(await publishedFacts()).toEqual([]);
    expect(await readPublishedPage(ctx.db, {})).toMatchObject({
      meta: { totalCount: ids.length, coverage: { missing: false } },
    });
    expect(await coverage()).toEqual({
      missing: true,
      stale: false,
      unresolved: true,
      failed: false,
    });
    const isolated = await prepareAssessmentReadPublication(
      ctx.db,
      [confident, unsure],
      async (snapshot, plan) => {
        if (plan.stage.assessmentIds.includes(confident))
          throw new Error("Synthetic malformed publication input");
        return prepareSuggestionAdmission(snapshot, plan.idsToPrepare);
      },
    );
    expect([...isolated.failures.keys()]).toEqual([confident]);
    expect(
      isolated.components.map(({ plan }) => plan.stage.assessmentIds),
    ).toEqual([[unsure]]);
    expect(isolated.components[0]?.prepared.rows.has(unsure)).toBe(true);
    const memberships = await readAssessmentReadMemberships(ctx.db, ids);
    const references = await readAssessmentRecordRefs(ctx.db, ids);
    for (const id of ids) {
      const published = (memberships.get(id) ?? [])
        .filter((row) => row.kind === "ref")
        .map((row) => ({ entity: row.entity, id: row.value }));
      expect(published).toHaveLength(references.get(id)?.length ?? 0);
      expect(published).toEqual(
        expect.arrayContaining(references.get(id) ?? []),
      );
    }
    const together = await prepareSuggestionAdmission(ctx.db, ids);
    expect(together.memberships).toEqual(memberships);
    expect([...together.dependencies.keys()].sort()).toEqual([...ids].sort());
    expect(together.dependencies.get(confident)).toEqual(
      expect.arrayContaining([
        { sourceKind: "product", sourceId: product.entityId },
        { sourceKind: "assessment.fieldWrite", sourceId: product.entityId },
      ]),
    );
    expect(together.dependencies.get(proposal.review.assessmentId)).toEqual(
      expect.arrayContaining([
        {
          sourceKind: "product",
          sourceId: await resolveOrThrow(
            ctx.db,
            "product",
            proposal.source.entityId,
          ),
        },
        {
          sourceKind: "expense",
          sourceId: await resolveOrThrow(
            ctx.db,
            "expense",
            proposal.target.entityId,
          ),
        },
      ]),
    );
    const separately = [];
    for (const id of ids)
      separately.push(await prepareSuggestionAdmission(ctx.db, [id]));
    expect(together.rows).toEqual(
      new Map(page.items.map((row) => [row.assessmentId, row])),
    );
    expect(new Map(separately.flatMap((batch) => [...batch.rows]))).toEqual(
      together.rows,
    );
    expect(
      new Map(separately.flatMap((batch) => [...batch.memberships])),
    ).toEqual(together.memberships);
    expect(
      new Map(separately.flatMap((batch) => [...batch.dependencies])),
    ).toEqual(together.dependencies);
    const factsById = (keys: Parameters<typeof suggestionKeyFacts>[0][]) =>
      new Map(keys.map((key) => [key.assessmentId, suggestionKeyFacts(key)]));
    expect(factsById(separately.flatMap((batch) => batch.keys))).toEqual(
      factsById(together.keys),
    );
    const canonical = await prepareCanonicalAssessmentReadPublication(
      ctx.db,
      ids,
      async () => () => sql`true`,
    );
    expect(canonical.failures.size).toBe(0);
    const canonicalResults = new Map(
      canonical.components.flatMap(({ prepared }) =>
        prepared.results.map(
          (result) => [result.assessmentId, result] as const,
        ),
      ),
    );
    const results: AssessmentReadResult[] = ids.map((id) => {
      const result = canonicalResults.get(id);
      if (!result) throw new Error("Synthetic canonical publication missing");
      // The recovery journey below supplies separate provisional dependencies.
      return {
        ...result,
        groupKey: `synthetic-admission-${id}`,
        dependencies: [],
      };
    });
    const stage: AssessmentReadStagePlan = {
      id: crypto.randomUUID(),
      componentKey: "synthetic-shared-admission",
      groups: results.map((row) => row.groupKey),
      assessmentIds: ids,
      tickets: observed,
      revision: crypto.randomUUID(),
      nextIndex: 0,
      rulesVersion: ASSESSMENT_READ_RULES_VERSION,
      clockDay: null,
    };
    const notified = new Set<string>();
    const publication: Parameters<typeof writeAssessmentReadStage>[2] = {
      notify: (entity, refs) =>
        refs.forEach((ref) => notified.add(`${entity}:${ref}`)),
    };
    const write = (
      plan: AssessmentReadStagePlan,
      prefix: AssessmentReadResult[],
      previousStageIds: readonly string[] = [],
      sourceScope?: AssessmentReadStageWrite["sourceScope"],
    ) =>
      getDb(ctx.db).transaction((tx) =>
        writeAssessmentReadStage(
          tx,
          { stage: plan, previousStageIds, results: prefix, sourceScope },
          publication,
        ),
      );
    const headers = () =>
      getDb(ctx.db)
        .select()
        .from(assessmentReadPublication)
        .where(eq(assessmentReadPublication.active, true));
    const middle = Math.ceil(ids.length / 2);
    const left = {
      ...stage,
      componentKey: "synthetic-admission-left",
      assessmentIds: ids.slice(0, middle),
      groups: stage.groups.slice(0, middle),
    };
    const right = {
      ...stage,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      componentKey: "synthetic-admission-right",
      assessmentIds: ids.slice(middle),
      groups: stage.groups.slice(middle),
    };
    const firstResult = results[0];
    if (!firstResult) throw new Error("Synthetic admission result missing");
    expect(
      await write(left, [
        {
          ...firstResult,
          dependencies: [
            {
              sourceKind: "synthetic.provisional",
              sourceId: crypto.randomUUID(),
            },
          ],
        },
      ]),
    ).toMatchObject({
      kind: "retained",
    });
    expect(
      await getDb(ctx.db).select().from(assessmentReadDependency),
    ).toHaveLength(1);
    expect(await write(right, results.slice(middle, middle + 1))).toMatchObject(
      { kind: "retained" },
    );
    expect(await headers()).toEqual([]);
    // New source work cannot activate an older complete staged snapshot.
    await markWork(ctx.db, DERIVED_DRAIN, [
      { target: ASSESSMENT_READ_TARGET, ref: ids[0]! },
    ]);
    expect(
      await write({ ...left, nextIndex: 1 }, results.slice(1, middle)),
    ).toMatchObject({ kind: "retained" });
    expect(await headers()).toEqual([]);
    const restarted = {
      ...stage,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      tickets: await observe(),
    };
    expect(await write(restarted, results, [left.id, right.id])).toMatchObject({
      kind: "activated",
    });
    const active = await headers();
    expect((await readPublishedWork()).meta.totalCount).toBeGreaterThan(0);
    const recordWork = await readRecordWorkQueueWith(
      ctx.db,
      { sources: [pendingSuggestionsWorkSource], deferrals: [] },
      { id: product.id, memberPartyId: null, memberOnly: false },
    );
    expect(recordWork.items).toHaveLength(1);
    expect(recordWork.items[0]).toMatchObject({
      entity: "product",
      id: product.id,
      reasonKeys: ["suggestions:field"],
    });
    expect(
      (
        await readPublishedWork({ reasonExclude: "suggestions:field" })
      ).items.map((row) => row.id),
    ).not.toContain(product.id);
    expect(
      (await readPublishedWork({ reason: "suggestions:field" })).items.map(
        (row) => row.id,
      ),
    ).toContain(product.id);
    expect(
      new Map(
        (await publishedFacts()).map((fact) => [
          fact.key.assessmentId,
          fact.row,
        ]),
      ),
    ).toEqual(together.rows);
    expect(await coverage()).toEqual({
      missing: false,
      stale: true,
      unresolved: true,
      failed: false,
    });
    expect(active.map((row) => row.assessmentId).sort()).toEqual(
      [...ids].sort(),
    );
    expect(await getDb(ctx.db).select().from(assessmentReadDependency)).toEqual(
      [],
    );
    expect(
      await getDb(ctx.db).select().from(assessmentReadPublication),
    ).toHaveLength(together.keys.length);
    expect(notified.size).toBeGreaterThan(0);
    expect(await write(restarted, results)).toEqual({
      kind: "activated",
      changed: [],
    });
    // Another component's newly owed direct work does not invalidate this one.
    await markWork(ctx.db, DERIVED_DRAIN, [
      { target: ASSESSMENT_READ_TARGET, ref: crypto.randomUUID() },
    ]);
    const unchanged = {
      ...restarted,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
    };
    notified.clear();
    expect(await write(unchanged, results, [restarted.id])).toEqual({
      kind: "activated",
      changed: [],
    });
    expect(notified.size).toBeGreaterThan(0);
    expect(await headers()).toEqual(active);
    expect(
      await getDb(ctx.db).select().from(assessmentReadPublication),
    ).toHaveLength(together.keys.length);
    const empty = {
      ...unchanged,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
    };
    expect(
      await write(
        empty,
        results.map((result) => ({ ...result, facts: [], memberships: [] })),
        [unchanged.id],
      ),
    ).toMatchObject({ kind: "activated" });
    const emptyPublications = await headers();
    expect((await readPublishedWork()).meta.totalCount).toBeGreaterThan(0);
    expect(await publishedFacts()).toEqual([]);
    expect((await coverage()).missing).toBe(false);
    expect(emptyPublications).toHaveLength(ids.length);
    expect(
      emptyPublications.every(
        (row) =>
          !row.admitted &&
          row.family === null &&
          row.key === null &&
          row.row === null,
      ),
    ).toBe(true);
    const relevantSource = crypto.randomUUID();
    const newlyRelatedSource = crypto.randomUUID();
    const sourceScope = derivedFanoutSourceScope({
      dependentIds: ids,
      sourceRefs: new Map([[`${ASSESSMENT_READ_TARGET}@0`, [relevantSource]]]),
      declaration: {
        kind: "internalRecord",
        target: ASSESSMENT_READ_TARGET,
        table: "Assessment",
        compute: ASSESSMENT_READ_TARGET,
        label: "Synthetic Assessment reviews",
        publishes: "ownTable",
        notifications: "sinkOwned",
        reconcile: null,
        dependsOn: [],
        inputs: [
          {
            table: "Product",
            tableColumn: "id",
            entityColumn: "id",
            columns: null,
            where: null,
            except: [],
            path: null,
            targetWhere: null,
            json: null,
            selection: { key: "syntheticCurrentAndRetained" },
          },
        ],
      },
      selections: {
        syntheticCurrentAndRetained: (
          refs,
        ) => sql`SELECT ${confident}::uuid AS id
          FROM (${refs}) source WHERE source.id = ${newlyRelatedSource}::uuid`,
      },
    });
    // A source becoming relevant between the two barriers must not leave an
    // applied cursor behind. The sequence models that changing SQL observation.
    await getDb(ctx.db).execute(
      sql`CREATE SEQUENCE synthetic_assessment_fence`,
    );
    const racingSource = crypto.randomUUID();
    const racingScope: NonNullable<AssessmentReadStageWrite["sourceScope"]> = ({
      ref,
    }) =>
      sql`CASE WHEN ${ref} = ${racingSource}::uuid
        THEN nextval('synthetic_assessment_fence') > 1 ELSE false END`;
    const raced = {
      ...empty,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      tickets: await observe(),
    };
    await markWork(ctx.db, DERIVED_DRAIN, [
      { target: `${ASSESSMENT_READ_TARGET}@0`, ref: racingSource },
    ]);
    expect(await write(raced, results, [empty.id], racingScope)).toEqual({
      kind: "retained",
      changed: [],
    });
    expect(
      await readAssessmentReadStage(ctx.db, raced.componentKey),
    ).toMatchObject({
      id: raced.id,
      assessmentIds: ids,
      nextIndex: 0,
    });
    expect(await headers()).toEqual(emptyPublications);
    await deleteWorkItems(ctx.db, {
      target: `${ASSESSMENT_READ_TARGET}@0`,
      refs: [racingSource],
    });
    expect(await write(raced, results, [], racingScope)).toMatchObject({
      kind: "activated",
    });
    expect((await publishedFacts()).length).toBeGreaterThan(0);
    await getDb(ctx.db).execute(sql`DROP SEQUENCE synthetic_assessment_fence`);
    const scoped = {
      ...empty,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      tickets: await observe(),
    };
    await markWork(ctx.db, DERIVED_DRAIN, [
      { target: `${ASSESSMENT_READ_TARGET}@0`, ref: crypto.randomUUID() },
    ]);
    expect(await write(scoped, results, [raced.id], sourceScope)).toMatchObject(
      { kind: "activated" },
    );
    const beforeSourceEdit = await headers();
    const blocked = {
      ...scoped,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
    };
    await markWork(ctx.db, DERIVED_DRAIN, [
      { target: `${ASSESSMENT_READ_TARGET}@0`, ref: relevantSource },
    ]);
    expect(await write(blocked, results, [scoped.id], sourceScope)).toEqual({
      kind: "retained",
      changed: [],
    });
    expect(await headers()).toEqual(beforeSourceEdit);
    await deleteWorkItems(ctx.db, {
      target: `${ASSESSMENT_READ_TARGET}@0`,
      refs: [relevantSource],
    });
    await markWork(ctx.db, DERIVED_DRAIN, [
      { target: `${ASSESSMENT_READ_TARGET}@0`, ref: newlyRelatedSource },
    ]);
    expect(await write(blocked, results, [scoped.id], sourceScope)).toEqual({
      kind: "retained",
      changed: [],
    });
    expect(await headers()).toEqual(beforeSourceEdit);
    await updateWorkItems(
      ctx.db,
      { target: ASSESSMENT_READ_TARGET, refs: [confident] },
      { lastError: "Synthetic publication failure", attempts: 1 },
    );
    expect((await coverage()).failed).toBe(true);
    await deleteWorkItems(ctx.db, { target: `${ASSESSMENT_READ_TARGET}@0` });
    await deleteWorkItems(ctx.db, { target: ASSESSMENT_READ_TARGET });
    // Complete the source work enrolled by real registration as well as the
    // synthetic controller work used to exercise staged recovery above.
    for (const target of new Set((await observe()).map((work) => work.target)))
      await deleteWorkItems(ctx.db, { target });
    expect(await coverage()).toEqual({
      missing: false,
      stale: false,
      unresolved: false,
      failed: false,
    });
    expect((await readPublishedWork()).meta.incompleteSources).toEqual([]);
    expect(ids.indexOf(confident)).toBeLessThan(ids.indexOf(unsure));
    const connectionRow = page.items.find(
      (row) => row.id === proposal.review.assessmentId,
    );
    expect(connectionRow).toMatchObject({ clean: false, strength: "strong" });
    // Model confidence alone is never strong or clean, however high.
    expect(page.items.find((row) => row.id === confident)).toMatchObject({
      clean: false,
      strength: "medium",
    });
    expect(page.items.find((row) => row.id === unsure)).toMatchObject({
      clean: false,
      strength: "weak",
    });

    // Keyset and offset pages walk the same order without gaps.
    const first = await refreshAndListSuggestions(ctx.db, { limit: 2 });
    const second = await refreshAndListSuggestions(ctx.db, {
      limit: 2,
      cursor: first.next!,
    });
    const offset = await refreshAndListSuggestions(ctx.db, {
      limit: 2,
      offset: 2,
    });
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual(
      ids.slice(0, 4),
    );
    expect(offset.items.map((row) => row.id)).toEqual(ids.slice(2, 4));
    expect(first.meta).toMatchObject({ pageSize: 2, totalCount: ids.length });
    // The clean banner retains its count; decorative facet rosters are removed.
    const fieldsOnly = await refreshAndListSuggestions(ctx.db, {
      family: "field",
    });
    expect(fieldsOnly.meta.totalCount).toBe(2);
    expect(fieldsOnly.meta.cleanCount).toBe(0);
    const productId = await resolveOrThrow(ctx.db, "product", product.id);
    const productScope = {
      records: [{ entity: "product", code: product.id, id: productId }],
    };
    const publishedCounts = await getDb(ctx.db)
      .execute(sql`SELECT "recordCode", count(*)::int AS count
      FROM (${publishedAssessmentRecordRefsSql(productScope)}) records
      WHERE "recordCode" = ${product.id} GROUP BY "recordCode"`);
    expect(publishedCounts.rows).toEqual([
      { recordCode: product.id, count: 2 },
    ]);
    expect(
      await suggestionRecordCounts(ctx.db, { recordIds: [product.id] }),
    ).toMatchObject({
      records: [{ id: product.id, pending: 2 }],
      coverage: {
        missing: false,
        stale: false,
        unresolved: false,
        failed: false,
      },
    });
    expect(
      (await publishedFacts(productScope))
        .map((fact) => fact.key.assessmentId)
        .sort(),
    ).toEqual([confident, unsure].sort());
    expect(await publishedFacts({ records: [] })).toEqual([]);
    expect(await publishedFacts({ families: [] })).toEqual([]);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: confident,
      operationId: "synthetic-published-reader-reject",
      verdict: "wrong",
      intent: "history",
    });
    expect(
      (await publishedFacts()).map((fact) => fact.key.assessmentId),
    ).not.toContain(confident);
    expect(
      (await suggestionRecordCounts(ctx.db, { recordIds: [product.id] }))
        .records,
    ).toEqual([{ id: product.id, pending: 1 }]);
    const fieldCounts = (
      await readPublishedCounts(ctx.db, {
        family: "field",
        recordIds: [product.id],
      })
    ).families[0];
    expect(fieldCounts?.pending).toBe(1);
    expect(
      fieldCounts?.fields.reduce((total, field) => total + field.pending, 0),
    ).toBe(1);
    // The retained revision is still stored; the committed member decision hid it.
    expect(
      (await headers()).some((row) => row.assessmentId === confident),
    ).toBe(true);
    const donors = [];
    for (let index = 0; index < 3; index++)
      donors.push(
        await createProductFixture(
          ctx.db,
          makeProductInput({
            name: `Synthetic tag donor ${index}`,
            tags: ["synthetic-shared"],
          }),
          ctx.actor,
        ),
      );
    const revision = await tagSourceRevision(ctx.db, product.id);
    if (!revision) throw new Error("Synthetic tag source missing");
    const publishTag = await prepareTagSuggestionPublication(
      ctx.db,
      product.id,
      {
        tag: "synthetic-shared",
        supportingProductCount: 3,
        supportingProductIds: donors.map((donor) => donor.id),
      },
      revision,
    );
    if (!publishTag) throw new Error("Synthetic tag preparation missing");
    const tag = await publishTag(ctx.db);
    if (!tag) throw new Error("Synthetic tag publication missing");
    const beforeTagEdit = await prepareSuggestionAdmission(ctx.db, [
      tag.assessmentId,
    ]);
    expect(beforeTagEdit.keys).toHaveLength(1);
    expect(beforeTagEdit.dependencies.get(tag.assessmentId)).toHaveLength(4);
    expect(
      beforeTagEdit.dependencies
        .get(tag.assessmentId)
        ?.every(
          (input) =>
            input.sourceKind === assessmentReadScopedSourceKind.enum.tagProduct,
        ),
    ).toBe(true);
    await getDb(ctx.db)
      .update(productTable)
      .set({ updatedAt: sql`${productTable.updatedAt} + interval '1 second'` })
      .where(eq(productTable.id, donors[0]!.entityId));
    const afterTagEdit = await prepareSuggestionAdmission(ctx.db, [
      tag.assessmentId,
    ]);
    expect(afterTagEdit.keys).toEqual([]);
    expect(afterTagEdit.dependencies).toEqual(beforeTagEdit.dependencies);
  });

  // Reference pruning must retain both endpoints and mixed scopes without
  // admitting a connection under an unrelated record kind.
  it("lists a connection under both of its endpoints", async () => {
    const { item, charge, proposal } = await connection(ctx);
    // The target is not this recommendation's primary State record, and no
    // publication dependencies exist yet. Endpoint indexes must still find it.
    for (const [kind, code] of [
      ["product", item.id],
      ["expense", charge.output.id],
    ] as const) {
      const id = await resolveOrThrow(ctx.db, kind, code);
      const affected = await getDb(ctx.db).execute(
        assessmentReadSourceSelection(kind, sql`SELECT ${id}::uuid AS id`),
      );
      expect(affected.rows.map((row) => row.id)).toContain(
        proposal.review.assessmentId,
      );
    }
    const unrelatedExpenses: Awaited<
      ReturnType<typeof createRepoIdentity<"expense">>
    >[] = [];
    for (let index = 0; index < 49; index++) {
      unrelatedExpenses.push(
        await createRepoIdentity(ctx, "expense", {
          name: `Synthetic unrelated expense ${index}`,
          costType: "materials",
          trade: "other",
        }),
      );
    }
    const unrelatedCodes = unrelatedExpenses.map((row) => row.output.id);
    const batchCounts = async (recordIds: string[]) =>
      (await suggestionRecordCounts(ctx.db, { recordIds })).records;
    expect(
      await suggestionRecordCounts(ctx.db, { recordIds: [item.id] }),
    ).toMatchObject({
      records: [{ id: item.id, pending: 1 }],
      coverage: { missing: false },
    });
    await publishReadFacts([proposal.review.assessmentId]);
    expect(await batchCounts([charge.output.id, ...unrelatedCodes])).toEqual([
      { id: charge.output.id, pending: 1 },
      ...unrelatedCodes.map((id) => ({ id, pending: 0 })),
    ]);
    expect(
      await batchCounts([
        charge.output.id,
        item.id,
        ...unrelatedCodes.slice(0, 48),
      ]),
    ).toEqual([
      { id: charge.output.id, pending: 1 },
      { id: item.id, pending: 1 },
      ...unrelatedCodes.slice(0, 48).map((id) => ({ id, pending: 0 })),
    ]);
    for (const recordId of [item.id, charge.output.id]) {
      const page = await refreshAndListSuggestions(ctx.db, {
        recordIds: [recordId],
        family: "recommendation",
      });
      expect(page.items.map((row) => row.id)).toEqual([
        proposal.review.assessmentId,
      ]);
      expect(page.items[0]).toMatchObject({
        record: { entity: "product", id: item.id },
        other: { entity: "expense", id: charge.output.id },
        impact: [
          expect.objectContaining({ qualityCheck: "product_unpurchased" }),
          expect.objectContaining({
            qualityCheck: "expense_product_resolution",
          }),
        ],
      });
    }
    // The connection adapter uses immutable family authority even when State
    // differs; primary-record discovery must retain that adapter.
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ family: "image_description" })
      .where(eq(assessmentState.id, proposal.review.assessmentId));
    const divergentInputs: AssessmentReadDependency[] = [];
    const divergent =
      (
        await readAssessmentReadMemberships(
          ctx.db,
          [proposal.review.assessmentId],
          (_id, inputs) => divergentInputs.push(...inputs),
        )
      ).get(proposal.review.assessmentId) ?? [];
    expect(divergentInputs).toEqual(
      expect.arrayContaining([
        { sourceKind: "image", sourceId: item.entityId },
        { sourceKind: "product", sourceId: item.entityId },
        {
          sourceKind: "expense",
          sourceId: await resolveOrThrow(ctx.db, "expense", charge.output.id),
        },
      ]),
    );
    await getDb(ctx.db)
      .update(assessment)
      .set({
        evidence: sql`jsonb_set(${assessment.evidence}, '{candidate,target,entityId}', to_jsonb(${"  " + charge.output.id.toLowerCase() + "  "}::text))`,
      })
      .where(eq(assessment.id, proposal.review.assessmentId));
    const normalizedInputs: AssessmentReadDependency[] = [];
    await readAssessmentReadMemberships(
      ctx.db,
      [proposal.review.assessmentId],
      (_id, inputs) => normalizedInputs.push(...inputs),
    );
    expect(normalizedInputs).toContainEqual({
      sourceKind: "expense",
      sourceId: await resolveOrThrow(ctx.db, "expense", charge.output.id),
    });
    await getDb(ctx.db)
      .update(assessment)
      .set({
        evidence: sql`jsonb_set(${assessment.evidence}, '{candidate,target,entityId}', to_jsonb(${charge.output.id}::text))`,
      })
      .where(eq(assessment.id, proposal.review.assessmentId));
    expect(divergent.filter((row) => row.kind === "scope")).toEqual([
      expect.objectContaining({
        entity: "product",
        value: item.entityId,
        stateFamily: "image_description",
      }),
    ]);
    expect(divergent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ref",
          entity: "expense",
          value: charge.output.id,
        }),
      ]),
    );
    // Discovery covers the whole request batch before references are counted.
    expect(await batchCounts([charge.output.id])).toEqual([
      { id: charge.output.id, pending: 0 },
    ]);
    expect(await batchCounts([item.id, charge.output.id])).toEqual([
      { id: item.id, pending: 1 },
      { id: charge.output.id, pending: 1 },
    ]);
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ family: "recommendation" })
      .where(eq(assessmentState.id, proposal.review.assessmentId));
    const category = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic unrelated category",
    });
    const task = await createRepoEntity(ctx, "task", { trade: "other" });
    for (const recordId of [category.output.id, task.output.id]) {
      expect(
        (
          await refreshAndListSuggestions(ctx.db, {
            recordIds: [recordId],
            family: "recommendation",
          })
        ).items,
      ).toEqual([]);
    }
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          recordIds: [category.output.id, charge.output.id],
          family: "recommendation",
        })
      ).items.map((row) => row.id),
    ).toEqual([proposal.review.assessmentId]);
    // Excluding either value in a multi-valued column removes the row.
    for (const entityKind of ["product", "expense"]) {
      expect(
        (
          await refreshAndListSuggestions(ctx.db, {
            family: "recommendation",
            entityKindExclude: [entityKind],
          })
        ).items,
      ).toEqual([]);
    }
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          family: "recommendation",
          entityKindExclude: ["task"],
        })
      ).items.map((row) => row.id),
    ).toEqual([proposal.review.assessmentId]);
    const [originalReference] = await getDb(ctx.db)
      .select({ subject: assessment.subject, evidence: assessment.evidence })
      .from(assessment)
      .where(eq(assessment.id, proposal.review.assessmentId));
    if (!originalReference) throw new Error("Synthetic recommendation missing");

    const retained = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic retained recommendation endpoint" }),
      ctx.actor,
    );
    const touchesRetained = () =>
      touchingAssessmentIds(ctx.db, {
        records: [
          { entity: "product", id: retained.entityId, code: retained.id },
          ...unrelatedExpenses.map((expense) => ({
            entity: "expense",
            id: expense.entityId,
            code: expense.output.id,
          })),
        ],
        eligibility: {
          kind: "suggestions",
          families: ["recommendation"],
          status: "pending",
        },
      });
    for (const id of [retained.entityId, retained.id]) {
      await getDb(ctx.db)
        .update(assessment)
        .set({
          evidence: sql`${assessment.evidence} || ${JSON.stringify({ records: [{ entity: "product", id, label: "Synthetic retained reference" }] })}::jsonb`,
        })
        .where(eq(assessment.id, proposal.review.assessmentId));
      // Connection endpoints stay authoritative even when retained records exist.
      expect((await touchesRetained())?.size).toBe(0);
      expect(
        (
          await readAssessmentReadMemberships(ctx.db, [
            proposal.review.assessmentId,
          ])
        )
          .get(proposal.review.assessmentId)
          ?.filter((row) => row.kind === "scope" && row.value === id),
      ).toEqual([]);
    }
    await getDb(ctx.db)
      .update(assessment)
      .set({
        subject: sql`jsonb_set(${assessment.subject}, '{scope}', '"synthetic.retained-history"'::jsonb)`,
      })
      .where(eq(assessment.id, proposal.review.assessmentId));
    for (const id of [retained.entityId, retained.id]) {
      await getDb(ctx.db)
        .update(assessment)
        .set({
          evidence: sql`${assessment.evidence} || ${JSON.stringify({ records: [{ entity: "product", id, label: "Synthetic retained reference" }] })}::jsonb`,
        })
        .where(eq(assessment.id, proposal.review.assessmentId));
      expect(await touchesRetained()).toEqual(
        new Set([proposal.review.assessmentId]),
      );
      expect(
        (
          await readAssessmentReadMemberships(ctx.db, [
            proposal.review.assessmentId,
          ])
        ).get(proposal.review.assessmentId),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "scope",
            entity: "product",
            value: id,
            retained: true,
          }),
        ]),
      );
    }
    await getDb(ctx.db)
      .update(assessment)
      .set(originalReference)
      .where(eq(assessment.id, proposal.review.assessmentId));
    const taskUuid = await resolveOrThrow(ctx.db, "task", task.output.id);
    const taskConnection = await publishEntityConnection(ctx.db, {
      relation: "task-subject-product",
      source: { entityKind: "task", entityId: task.output.id },
      target: { entityKind: "product", entityId: item.id },
      label: "Synthetic Task subject",
      evidence: { reasons: [], contradictions: [], unknowns: [] },
    });
    for (const recordId of [task.output.id, item.id]) {
      expect(
        (
          await refreshAndListSuggestions(ctx.db, {
            recordIds: [recordId],
            family: "recommendation",
          })
        ).items.map((row) => row.id),
      ).toContain(taskConnection.review.assessmentId);
    }

    // Retained current state can differ from the immutable candidate source.
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ entity: "task", recordId: taskUuid })
      .where(eq(assessmentState.id, proposal.review.assessmentId));
    const productUuid = await resolveOrThrow(ctx.db, "product", item.id);
    const expenseUuid = await resolveOrThrow(
      ctx.db,
      "expense",
      charge.output.id,
    );
    // Model a retained unknown connection scope with a UUID-form source ref.
    await getDb(ctx.db)
      .update(assessment)
      .set({
        subject: sql`jsonb_set(${assessment.subject}, '{scope}', to_jsonb('connection.legacy-synthetic'::text))`,
        evidence: sql`jsonb_set(${assessment.evidence}, '{candidate,source,entityId}', to_jsonb(${productUuid}::text))`,
      })
      .where(eq(assessment.id, proposal.review.assessmentId));
    const eligibility = {
      kind: "suggestions" as const,
      families: [assessmentFamily.enum.recommendation],
      status: "pending" as const,
    };
    const records = [
      { entity: "product", id: productUuid, code: item.id },
      { entity: "expense", id: expenseUuid, code: charge.output.id },
      { entity: "task", id: taskUuid, code: task.output.id },
    ];
    for (const record of records) {
      expect(
        await touchingAssessmentIds(ctx.db, { records: [record], eligibility }),
      ).toContain(proposal.review.assessmentId);
    }

    // Automatic history still follows both original endpoints after retirement.
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ status: "superseded", active: false })
      .where(eq(assessmentState.id, proposal.review.assessmentId));
    await recordFeedback(ctx.db, {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic.connection-history",
      verdict: "ungraded",
      authority: "automatic",
      intent: "apply",
      actorUserId: ctx.actor.userId,
      metadata: {
        kind: "assessment_application",
        rule: { key: "synthetic-retained-rule", revision: 1 },
      },
      receipt: { synthetic: true },
    });
    const automatic = {
      kind: "automatic" as const,
      appliedRule: automaticApplicationRule,
    };
    for (const record of records) {
      expect(
        await touchingAssessmentIds(ctx.db, {
          records: [record],
          eligibility: automatic,
        }),
      ).toContain(proposal.review.assessmentId);
    }

    // A retained null scope uses explicit evidence records, not candidate refs.
    await getDb(ctx.db)
      .update(assessment)
      .set({
        subject: sql`jsonb_set(${assessment.subject}, '{scope}', 'null'::jsonb)`,
        evidence: sql`jsonb_set(${assessment.evidence}, '{records}', ${JSON.stringify([{ entity: "product", id: item.id }])}::jsonb)`,
      })
      .where(eq(assessment.id, proposal.review.assessmentId));
    for (const record of records) {
      expect(
        (
          await touchingAssessmentIds(ctx.db, {
            records: [record],
            eligibility: automatic,
          })
        )?.has(proposal.review.assessmentId),
      ).toBe(record.entity !== "expense");
    }
  });

  // Failure mode: the uniform row recomputes clean and drifts from the
  // statement judgment, letting a sibling charge into bulk accept.
  it("keeps statement clean exactly as the judgment states", async () => {
    await card(ctx);
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE MKTPLACE PMTS" })]);
    await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE MKTPL*AB12CD34" })],
      { fingerprint: "fp-list-firmed" },
    );
    await generate(ctx);
    const page = await refreshAndListSuggestions(ctx.db, {
      family: "statement_transaction",
    });
    expect(page.items).toHaveLength(2);
    for (const row of page.items) {
      if (row.family !== "statement_transaction") throw new Error(row.family);
      expect(row.clean).toBe(row.evidence.clean);
      expect(row.clean).toBe(false);
      expect(row.columns).toMatchObject({
        account: row.evidence.accountId,
        action: row.evidence.recommended,
      });
    }
    expect(
      (
        await refreshAndListSuggestions(ctx.db, {
          family: "statement_transaction",
          clean: ["true"],
        })
      ).items,
    ).toEqual([]);
    const grouped = await refreshAndListSuggestions(ctx.db, {
      group: "account_month",
    });
    expect(grouped.meta.groups).toEqual([
      expect.objectContaining({ month: "2026-05", count: 2, clean: 0 }),
    ]);
  });

  // Failure mode: bulk accept trusts the ids a client listed, so a charge
  // republished as no longer clean between list and accept is applied.
  it("accepts only what is clean when it runs, skipping a republished charge", async () => {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic suggestion list member",
      kind: "member",
    });
    const account = await card(ctx);
    await executeEntity(kernelCtx(ctx), {
      action: "update",
      entity: "financialAccount",
      id: account.output.id,
      data: { ledgerPartyId: owner.output.id },
    });
    const category = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      { name: "Synthetic suggestion list groceries" },
    );
    const advice = financialSpendingAdvice.parse({
      spendingCategoryId: category.id,
      categoryConfidence: "high",
      vendorName: "Synthetic list grocer",
      vendorConfidence: "high",
      counterparty: "business",
    });
    await record(ctx, [rowInput({ rawDescription: "EXAMPLE MKTPLACE PMTS" })]);
    await generate(ctx);
    // Clean creation requires a kind label and categorized member spending.
    await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "purchase", counterparty: "business" }),
      spendingAdvice: async () => advice,
      runId: await ensureRun(ctx.db, ctx.actor, { purpose: "background" }),
    });
    const listed = await refreshAndListSuggestions(ctx.db, {
      family: "statement_transaction",
    });
    // A later export observes the same money under a firmed-up descriptor;
    // the first charge republishes with a sibling and is no longer clean.
    await record(
      ctx,
      [rowInput({ rawDescription: "EXAMPLE MKTPL*AB12CD34" })],
      { fingerprint: "fp-list-republish" },
    );
    await generate(ctx);
    const results = await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
      filters: { family: "statement_transaction" },
    });
    expect(listed.items.filter((row) => row.clean)).toHaveLength(1);
    expect(results).toEqual([]);
  });

  // A retained predecessor and later collection must reach the same current charge proposal.
  it("scopes statement proposals by retained source observations and collection membership", async () => {
    await card(ctx);
    await record(ctx, [
      rowInput({ providerTransactionId: "synthetic-provider-charge" }),
    ]);
    await record(
      ctx,
      [
        rowInput({
          providerTransactionId: "synthetic-provider-charge",
          rawDescription: "EXAMPLE GROCER REVISED",
        }),
      ],
      { fingerprint: "fp-list-revision" },
    );
    await record(
      ctx,
      [
        rowInput({
          providerTransactionId: "synthetic-provider-charge",
          rawDescription: "EXAMPLE GROCER REVISED",
        }),
      ],
      { fingerprint: "fp-list-reobserved" },
    );
    await record(ctx, [rowInput({ providerAmount: -73 })], {
      fingerprint: "fp-list-unrelated",
    });
    await generate(ctx);
    const observations = await getDb(ctx.db)
      .select({
        code: sourceTransactionRecord.shortcode,
        providerId: sourceTransactionRecord.providerTransactionId,
      })
      .from(sourceTransactionRecord);
    const collections = await getDb(ctx.db)
      .select({
        code: transactionImport.shortcode,
        fingerprint: transactionImport.fingerprint,
      })
      .from(transactionImport);
    expect(observations).toHaveLength(3);
    expect(collections).toHaveLength(4);
    const all = await refreshAndListSuggestions(ctx.db, {
      family: "statement_transaction",
    });
    expect(all.items).toHaveLength(2);
    const current = all.items.find(
      (row) =>
        row.family === "statement_transaction" &&
        row.evidence.rawDescription === "EXAMPLE GROCER REVISED",
    );
    expect(current).toBeDefined();
    for (const ref of [
      ...observations.map((row) => ({
        entity: "sourceTransactionRecord" as const,
        code: row.code,
        relevant: row.providerId !== null,
      })),
      ...collections.map((row) => ({
        entity: "transactionImport" as const,
        code: row.code,
        relevant: row.fingerprint !== "fp-list-unrelated",
      })),
    ]) {
      const filters = {
        family: "statement_transaction" as const,
        recordEntity: ref.entity,
        recordIds: [ref.code],
      };
      const page = await refreshAndListSuggestions(ctx.db, filters);
      expect(page.items).toHaveLength(1);
      expect(page.items.some((row) => row.id === current?.id)).toBe(
        ref.relevant,
      );
      const counts = await refreshAndCountSuggestions(ctx.db, filters);
      expect(
        counts.families.find((row) => row.family === "statement_transaction")
          ?.pending,
      ).toBe(1);
    }
    const combined = await refreshAndListSuggestions(ctx.db, {
      family: "statement_transaction",
      recordIds: observations
        .filter((row) => row.providerId !== null)
        .map((row) => row.code),
    });
    expect(combined.items.map((row) => row.id)).toEqual([current?.id]);
  });

  // Failure mode: counts read one family, so the page's chips undercount.
  it("counts pending Suggestions per family", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic counted product" }),
      ctx.actor,
    );
    await fieldSuggestion(ctx, product, "model", 0.95, new Date());
    await connection(ctx);
    const account = await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const { families } = await refreshAndCountSuggestions(ctx.db);
    const byFamily = new Map(families.map((row) => [row.family, row]));
    expect(byFamily.get("field")).toMatchObject({
      pending: 1,
      clean: 0,
      strong: 0,
    });
    expect(byFamily.get("recommendation")).toMatchObject({
      pending: 1,
      clean: 0,
    });
    expect(byFamily.get("statement_transaction")).toMatchObject({
      pending: 1,
      clean: 0,
      strong: 0,
      medium: 0,
      weak: 1,
    });
    const pending = async (input: Parameters<typeof readPublishedCounts>[1]) =>
      (
        await refreshAndCountSuggestions(ctx.db, {
          family: "statement_transaction",
          ...input,
        })
      ).families[0]?.pending;
    expect(await pending({ recordIds: [account.output.id] })).toBe(1);
    expect(await pending({ recordIds: [] })).toBe(0);
    expect(await pending({ recordEntity: "product" })).toBe(0);
    expect(await pending({ action: ["attach"] })).toBe(0);
  });
});
