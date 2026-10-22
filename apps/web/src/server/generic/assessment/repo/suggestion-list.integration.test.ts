import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import {
  recordSourceTransactionRecordsInput,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { suggestionListFilters } from "@cubby/schemas/suggestion-list";
import { eq } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { assessmentState, sourceTransactionRecord } from "~/server/db/schema";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { readAssessmentRecordRefs } from "~/server/generic/assessment/repo/review-families";
import { suggestionFamilies } from "~/server/generic/assessment/repo/suggestion-families";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { publishFieldAssessment } from "./assessment";
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

  it("omits ignored statement evidence without a retirement pass", async () => {
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    expect(
      (await listSuggestionPage(ctx.db, { family: "statement_transaction" }))
        .items,
    ).toHaveLength(1);
    await getDb(ctx.db).update(sourceTransactionRecord).set({
      disposition: "ignored",
      dispositionReason: "not_modeled",
      dispositionNote: "Synthetic unmodeled charge",
    });
    expect(
      (await listSuggestionPage(ctx.db, { family: "statement_transaction" }))
        .items,
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
    for (const record of [current.output.id, proposed.output.id]) {
      const page = await listSuggestionPage(ctx.db, {
        family: "field",
        entity: "productCategory",
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
    const unscoped = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
    });
    expect(unscoped.items).toHaveLength(1);
    for (const id of [
      account.id,
      ...candidates.map((candidate) => candidate.id),
    ]) {
      expect(
        (
          await listSuggestionPage(ctx.db, {
            family: "statement_transaction",
            recordIds: [id],
          })
        ).items.map((row) => row.assessmentId),
      ).toEqual(unscoped.items.map((row) => row.assessmentId));
    }
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
      "manufacturer",
      0.7,
      new Date("2026-01-02T00:00:00Z"),
    );
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const { proposal } = await connection(ctx);

    const page = await listSuggestionPage(ctx.db, { limit: 200 });
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
    const first = await listSuggestionPage(ctx.db, { limit: 2 });
    const second = await listSuggestionPage(ctx.db, {
      limit: 2,
      cursor: first.next!,
    });
    const offset = await listSuggestionPage(ctx.db, { limit: 2, offset: 2 });
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual(
      ids.slice(0, 4),
    );
    expect(offset.items.map((row) => row.id)).toEqual(ids.slice(2, 4));
    expect(first.meta).toMatchObject({ pageSize: 2, totalCount: ids.length });
    expect(first.facets.family).toEqual(
      expect.arrayContaining([
        { value: "field", count: 2 },
        { value: "recommendation", count: 1 },
      ]),
    );
    // Failure mode: a one-family view drops the common facets, so the page
    // hides its "Accept N clean" banner.
    const fieldsOnly = await listSuggestionPage(ctx.db, { family: "field" });
    expect(fieldsOnly.facets.clean).toEqual([{ value: false, count: 2 }]);
  });

  // Failure mode: a connection lists only under the endpoint that requested
  // discovery, so the other record's view misses it.
  it("lists a connection under both of its endpoints", async () => {
    const { item, charge, proposal } = await connection(ctx);
    for (const recordId of [item.id, charge.output.id]) {
      const page = await listSuggestionPage(ctx.db, {
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
          where: { clean: { in: [true] } },
        })
      ).items,
    ).toEqual([]);
    const grouped = await listSuggestionPage(ctx.db, {
      groups: "account_month",
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
      data: { ledgerPartyId: owner.output.id, provisional: false },
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

  // Failure mode: counts read one family, so the page's chips undercount.
  it("counts pending Suggestions per family", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic counted product" }),
      ctx.actor,
    );
    await fieldSuggestion(ctx, product, "model", 0.95, new Date());
    await connection(ctx);
    await card(ctx);
    await record(ctx, [rowInput()]);
    await generate(ctx);
    const { families } = await suggestionCountsByFamily(ctx.db);
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
    expect(byFamily.get("statement_transaction")?.pending).toBe(1);
  });
});
