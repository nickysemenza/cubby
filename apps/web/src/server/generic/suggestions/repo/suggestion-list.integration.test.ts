import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import {
  recordSourceTransactionRecordsInput,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  suggestionTable,
  financialTransactionAllocation,
  sourceTransactionRecord,
  sourceOccurrence,
  transactionImport,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import {
  sourceObservationColumns,
  sourceObservationFrom,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { updateSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readSuggestionRecordRefs } from "~/server/generic/suggestions/repo/suggestion-reference-resolution";
import {
  touchingSuggestionIds,
  touchingSuggestionQuery,
} from "~/server/generic/suggestions/repo/suggestion-touching";
import { buildCrudServices } from "~/server/http/request-context";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { listAutomaticDecisions } from "./automatic-decisions";
import { automaticApplicationRule, recordFeedback } from "./suggestion";
import {
  acceptCleanSuggestions,
  listSuggestionPage,
  suggestionRecordCounts,
  suggestionCountsByFamily,
} from "./suggestion-list";

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
      rows: rows.map((row) =>
        row.providerTransactionId
          ? {
              ...row,
              providerAccountId: "synthetic-list-account",
              providerData: {
                id: row.providerTransactionId,
                account_id: "synthetic-list-account",
              },
            }
          : row,
      ),
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
      servicesFor: buildCrudServices,
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
  const row = await seedFieldSuggestion(
    ctx.db,
    {
      entity: "product",
      recordId: product.entityId,
      field,
      // Cubby disagreeing with a person's value is what the queue lists.
      currentValue: `Synthetic current ${field}`,
      suggestedValue: `Synthetic ${field}`,
      confidence,
      model: "typesafe/jev",
      kind: "correction",
      status: "pending",
      createdAt,
    },
    true,
  );
  return row.id;
}

describe("cross-family Suggestion list", () => {
  it("uses indexed Suggestion probes for a 50-record scope", async () => {
    await getDb(ctx.db)
      .execute(sql`INSERT INTO "Suggestion" ("publicationKey", family, subject, judgment, entity, "recordId", field, status, active, "suggestedValue", evidence, data)
      SELECT 'plan-' || n, (ARRAY[${suggestionFamily.enum.field},${suggestionFamily.enum.recommendation},${suggestionFamily.enum.statement_transaction},${suggestionFamily.enum.product_pair},${suggestionFamily.enum.transfer_pair}])[1 + (n % 5)],
        '{}'::jsonb, '{}'::jsonb, ${"product"}, gen_random_uuid(), ${"brandId"},
        CASE WHEN (n / 5) % 100 = 0 THEN ${"pending"} ELSE ${"resolved"} END, true, to_jsonb('00000000-0000-4000-8000-000000000001'::text), jsonb_build_object('records', jsonb_build_array(jsonb_build_object('entity', ${"vendor"}::text, 'id', '00000000-0000-4000-8000-000000000001'))), '{}'::jsonb
      FROM generate_series(1, 10000) n`);
    await getDb(ctx.db).execute(sql`ANALYZE "Suggestion"`);
    const records = Array.from({ length: 50 }, (_, n) => ({
      entity: "vendor",
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      code: `VND-${String(n).padStart(4, "0")}`,
    }));
    const query = touchingSuggestionQuery(ctx.db, {
      records,
      eligibility: {
        kind: "suggestions",
        families: [
          "field",
          "recommendation",
          "statement_transaction",
          "product_pair",
          "transfer_pair",
        ],
        status: "pending",
      },
    });
    const result = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      "objects",
    );
    type Plan = {
      "Node Type": string;
      "Relation Name"?: string;
      Plans?: Plan[];
    };
    const document = result[0]!["QUERY PLAN"] as { Plan: Plan }[];
    const scans: string[] = [];
    const visit = (plan: Plan) => {
      if (
        plan["Node Type"] === "Seq Scan" &&
        plan["Relation Name"] === "Suggestion"
      )
        scans.push(plan["Node Type"]);
      plan.Plans?.forEach(visit);
    };
    visit(document[0]!.Plan);
    expect(scans).toEqual([]);
  });

  const ctx = withTestDb();

  it("omits ignored statement evidence without a retirement pass", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
        })
      ).items,
    ).toHaveLength(1);
    await getDb(ctx.db).update(sourceOccurrence).set({
      disposition: "ignored",
      dispositionReason: "not_modeled",
      dispositionNote: "Synthetic unmodeled charge",
    });
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
        })
      ).items,
    ).toEqual([]);
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
      .update(suggestionTable)
      .set({
        currentValue: current.output.id,
        suggestedValue: proposed.output.id,
      })
      .where(eq(suggestionTable.id, id));
    for (const record of [current.output.id, proposed.output.id]) {
      const page = await listSuggestionPage(ctx.db, {
        family: "field",
        recordEntity: "productCategory",
        recordIds: [record],
      });
      expect(page.items.map((row) => row.suggestionId)).toEqual([id]);
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
    const unscoped = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
    });
    expect(unscoped.items).toHaveLength(1);
    const affected = [
      account.id,
      ...candidates.map((candidate) => candidate.id),
    ];
    expect(
      (await suggestionRecordCounts(ctx.db, { recordIds: affected })).records,
    ).toEqual(affected.map((id) => ({ id, pending: 1 })));
    for (const id of affected) {
      expect(
        (await suggestionRecordCounts(ctx.db, { recordIds: [id] })).records,
      ).toEqual([{ id, pending: 1 }]);
      expect(
        (
          await listSuggestionPage(ctx.db, {
            family: "statement_transaction",
            recordIds: [id],
          })
        ).items.map((row) => row.suggestionId),
      ).toEqual(unscoped.items.map((row) => row.suggestionId));
    }
  });

  it("scopes statement history through settlement allocations to Expenses", async () => {
    const account = (await card(ctx)).output;
    await record(ctx, [
      rowInput({ providerTransactionId: "synthetic-scope-charge" }),
    ]);
    await generate(ctx);
    const [source] = await getDb(ctx.db)
      .select(sourceObservationColumns)
      .from(sourceObservationFrom)
      .where(
        eq(
          sourceTransactionRecord.providerTransactionId,
          "synthetic-scope-charge",
        ),
      );
    if (!source) throw new Error("Synthetic source observation missing");
    const proposal = (
      await listSuggestionPage(ctx.db, {
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
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: source.source, externalIds: [source.externalId] },
        data: { accountId: account.id },
      },
      ctx.actor,
    );
    const settled = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      sourceRefs: [{ source: "monarch", externalId: source.chargeKey }],
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
      families: [suggestionFamily.enum.statement_transaction],
      status: "pending",
    } satisfies Parameters<typeof touchingSuggestionIds>[1]["eligibility"];
    const scoped = async (
      records: NonNullable<
        Parameters<typeof touchingSuggestionIds>[1]["records"]
      >,
    ) =>
      await touchingSuggestionIds(ctx.db, {
        records,
        eligibility,
      });
    expect(await scoped([expenseRef])).toContain(proposal.suggestionId);
    expect(await scoped([unrelatedRef])).not.toContain(proposal.suggestionId);
    expect(await scoped([unrelatedRef, accountRef])).toContain(
      proposal.suggestionId,
    );
    expect(
      await touchingSuggestionIds(ctx.db, { entity: "expense", eligibility }),
    ).toContain(proposal.suggestionId);

    // Retained advice keeps its old SOC handle after the primary record moves to a survivor.
    await record(
      ctx,
      [rowInput({ providerTransactionId: "synthetic-surviving-charge" })],
      { fingerprint: "fp-scope-survivor" },
    );
    const [survivor] = await getDb(ctx.db)
      .select(sourceObservationColumns)
      .from(sourceObservationFrom)
      .where(
        eq(
          sourceTransactionRecord.providerTransactionId,
          "synthetic-surviving-charge",
        ),
      );
    if (!survivor?.occurrenceId || !source.occurrenceId)
      throw new Error("Synthetic source owner missing");
    const settledId = await resolveOrThrow(
      ctx.db,
      "financialTransaction",
      settled.output.id,
    );
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({
        currentObservationId: null,
        acceptedTransactionId: null,
        supersededByOccurrenceId: survivor.occurrenceId,
      })
      .where(eq(sourceOccurrence.id, source.occurrenceId));
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ occurrenceId: survivor.occurrenceId })
      .where(eq(sourceTransactionRecord.id, source.id));
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({ acceptedTransactionId: settledId })
      .where(eq(sourceOccurrence.id, survivor.occurrenceId));
    const settlementRefs = [
      {
        entity: "financialTransaction",
        id: settledId,
        code: settled.output.id,
      },
      {
        entity: "purchase",
        id: await resolveOrThrow(ctx.db, "purchase", purchase.output.id),
        code: purchase.output.id,
      },
      expenseRef,
    ];
    for (const ref of settlementRefs) {
      expect(await scoped([ref])).toContain(proposal.suggestionId);
      expect(await scoped([ref, unrelatedRef])).toContain(
        proposal.suggestionId,
      );
      expect(
        (await suggestionRecordCounts(ctx.db, { recordIds: [ref.code] }))
          .records,
      ).toEqual([{ id: ref.code, pending: 1 }]);
    }
    const expanded = await readSuggestionRecordRefs(ctx.db, [
      proposal.suggestionId,
    ]);
    expect(expanded.get(proposal.suggestionId)).toEqual(
      expect.arrayContaining(
        settlementRefs.map(({ entity, code }) => ({ entity, id: code })),
      ),
    );
    expect(
      (
        await suggestionRecordCounts(ctx.db, {
          recordIds: settlementRefs.map((ref) => ref.code),
        })
      ).records,
    ).toEqual(settlementRefs.map((ref) => ({ id: ref.code, pending: 1 })));

    const purchaseId = await resolveOrThrow(
      ctx.db,
      "purchase",
      purchase.output.id,
    );
    await getDb(ctx.db)
      .update(financialTransactionAllocation)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId));
    expect(await scoped([expenseRef])).not.toContain(proposal.suggestionId);
    await getDb(ctx.db)
      .update(financialTransactionAllocation)
      .set({ deletedAt: null })
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId));

    await getDb(ctx.db)
      .update(suggestionTable)
      .set({ status: "superseded", active: false })
      .where(eq(suggestionTable.id, proposal.suggestionId));
    await recordFeedback(ctx.db, {
      suggestionId: proposal.suggestionId,
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
    expect(await history([expense.output.id])).toContain(proposal.suggestionId);
    // The panel's default view has no family, so it unions the mail branches.
    expect(
      (
        await listAutomaticDecisions(ctx.db, { recordIds: [expense.output.id] })
      ).items.map((row) => row.id),
    ).toContain(proposal.suggestionId);
    expect(await history([unrelated.output.id])).not.toContain(
      proposal.suggestionId,
    );
    expect(await history([unrelated.output.id, account.id])).toContain(
      proposal.suggestionId,
    );
    expect(
      await touchingSuggestionIds(ctx.db, {
        entity: "expense",
        eligibility: {
          kind: "automatic",
          appliedRule: automaticApplicationRule,
        },
      }),
    ).toContain(proposal.suggestionId);

    await getDb(ctx.db)
      .update(financialTransactionAllocation)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId));
    expect(await history([expense.output.id])).not.toContain(
      proposal.suggestionId,
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
    const page = await listSuggestionPage(ctx.db, {});
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
        await listSuggestionPage(ctx.db, {
          ownerExclude: ["LPY-2A2A"],
        })
      ).items.map((row) => row.id),
    ).toEqual(page.items.map((row) => row.id));
    expect(
      (
        await listSuggestionPage(ctx.db, {
          accountExclude: [account.id],
        })
      ).items.map((row) => row.family),
    ).toEqual(["field"]);
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
          account: [account.id],
          accountExclude: [account.id],
        })
      ).items,
    ).toEqual([]);
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
    const page = await listSuggestionPage(ctx.db, {
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
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
          clean: ["true"],
        })
      ).items,
    ).toEqual([]);
    const grouped = await listSuggestionPage(ctx.db, {
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
    const listed = await listSuggestionPage(ctx.db, {
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
    const history = await getDb(ctx.db)
      .select(sourceObservationColumns)
      .from(sourceObservationFrom);
    const previous = history.find(
      (row) =>
        row.providerTransactionId &&
        row.rawDescription === "EXAMPLE GROCER 0001",
    );
    const selectedRevision = history.find(
      (row) =>
        row.providerTransactionId &&
        row.rawDescription === "EXAMPLE GROCER REVISED",
    );
    if (!previous || !selectedRevision)
      throw new Error("Synthetic collection revision missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: previous.source,
          externalIds: [previous.externalId],
        },
        data: { supersededByExternalId: selectedRevision.externalId },
      },
      ctx.actor,
    );

    await generate(ctx);
    const observations = await getDb(ctx.db)
      .select({
        code: sourceTransactionRecord.shortcode,
        providerId: sourceTransactionRecord.providerTransactionId,
      })
      .from(sourceTransactionRecord);
    const occurrences = await getDb(ctx.db)
      .select({ code: sourceOccurrence.shortcode, id: sourceOccurrence.id })
      .from(sourceOccurrence);
    const collections = await getDb(ctx.db)
      .select({
        code: transactionImport.shortcode,
        fingerprint: transactionImport.fingerprint,
      })
      .from(transactionImport);
    expect(observations).toHaveLength(3);
    expect(collections).toHaveLength(4);
    const all = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
    });
    expect(all.items).toHaveLength(2);
    const current = all.items.find(
      (row) =>
        row.family === "statement_transaction" &&
        row.evidence.rawDescription === "EXAMPLE GROCER REVISED",
    );
    expect(current).toBeDefined();
    const affected = [
      ...observations.map((row) => ({
        entity: "sourceTransactionRecord" as const,
        code: row.code,
        relevant: row.providerId !== null,
      })),
      ...occurrences.map((row) => ({
        entity: "sourceOccurrence" as const,
        code: row.code,
        relevant: row.id === selectedRevision.occurrenceId,
      })),
      ...collections.map((row) => ({
        entity: "transactionImport" as const,
        code: row.code,
        relevant: row.fingerprint !== "fp-list-unrelated",
      })),
    ];
    const batched = await suggestionRecordCounts(ctx.db, {
      recordIds: affected.map((ref) => ref.code),
    });
    expect(batched.records).toEqual(
      affected.map((ref) => ({ id: ref.code, pending: 1 })),
    );
    for (const ref of affected) {
      expect(
        (await suggestionRecordCounts(ctx.db, { recordIds: [ref.code] }))
          .records,
      ).toEqual([{ id: ref.code, pending: 1 }]);
      const filters = {
        family: "statement_transaction" as const,
        recordEntity: ref.entity,
        recordIds: [ref.code],
      };
      const page = await listSuggestionPage(ctx.db, filters);
      expect(page.items).toHaveLength(1);
      expect(page.items.some((row) => row.id === current?.id)).toBe(
        ref.relevant,
      );
      const counts = await suggestionCountsByFamily(ctx.db, filters);
      expect(
        counts.families.find((row) => row.family === "statement_transaction")
          ?.pending,
      ).toBe(1);
    }
    const combined = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      recordIds: observations
        .filter((row) => row.providerId !== null)
        .map((row) => row.code),
    });
    expect(combined.items.map((row) => row.id)).toEqual([current?.id]);
    if (!current) throw new Error("Synthetic source proposal missing");
    // Old publications can retain an STR charge key after occurrence ownership was backfilled.
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({
        data: sql`jsonb_set(${suggestionTable.data}, '{chargeKey}', to_jsonb(${previous.shortcode}::text))`,
      })
      .where(eq(suggestionTable.id, current.suggestionId));
    expect(
      (
        await suggestionRecordCounts(ctx.db, {
          recordIds: affected.map((ref) => ref.code),
        })
      ).records,
    ).toEqual(batched.records);
  });
});
