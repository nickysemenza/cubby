import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { suggestionTable, expense, spendingCategory } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  categoryPorts,
  kernelCtx,
  productFixture,
  seedPending,
  productCategoryId,
  startSuggestionSweep,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { sourceObservationFrom } from "~/server/domains/transaction-import/repo/source-observation-state";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions as runStatementLabels } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { applyAutomaticRules } from "~/server/generic/suggestions/repo/automatic-application";
import { listAutomaticDecisions } from "~/server/generic/suggestions/repo/automatic-decisions";
import { loadCurrentFieldOwnership } from "~/server/generic/suggestions/repo/automatic-fields";
import { ruleBase } from "~/server/generic/suggestions/repo/automatic-policy";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import * as suggestionReview from "~/server/generic/suggestions/repo/suggestion-review";
import {
  canAutomaticallyFillField,
  acceptSuggestion,
} from "~/server/generic/suggestions/repo/suggestion-review";
import { buildCrudServices } from "~/server/http/request-context";

type Ctx = ReturnType<typeof withTestDb>;

const labelStatementSuggestions: typeof runStatementLabels = async (
  db,
  input,
) => {
  const category = await getDb(db).query.spendingCategory.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          eq(spendingCategory.name, "Synthetic automatic spending"),
        ),
    },
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

const BOOK_SPENDING = "statement_transaction.book_spending";

const feedbackFor = async (ctx: Ctx, suggestionId: string) =>
  (
    await getDb(ctx.db).execute<{
      authority: string;
      verdict: string;
      metadata: { kind?: string; rule?: { key: string; stamp: string } };
    }>(
      sql`SELECT decision->>${"authority"} AS authority, decision->>${"verdict"} AS verdict, decision->${"metadata"} AS metadata
        FROM "Suggestion" s CROSS JOIN LATERAL jsonb_array_elements(s.decisions) decision
        WHERE s.id = ${suggestionId}::uuid ORDER BY decision->>${"createdAt"}`,
    )
  ).rows;

const stateOf = async (ctx: Ctx, suggestionId: string) =>
  (
    await getDb(ctx.db).execute<{
      status: string;
      data: { matchedRules?: string[] };
    }>(
      sql`SELECT status, data FROM "Suggestion" WHERE id = ${suggestionId}::uuid`,
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

    identity: { kind: "credit_card", network: "visa" },
    sourceAliases: [
      {
        source: "monarch",
        alias: "Synthetic Card (...4242)",
        externalAccountId: null,
      },
    ],
  });
};

async function unmatchedCharge(ctx: Ctx) {
  const account = (await card(ctx)).output;
  const recorded = await recordSourceTransactionRecords(
    ctx.db,
    recordSourceTransactionRecordsInput.parse({
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
  await generateStatementSuggestionPage(ctx.db, {
    servicesFor: buildCrudServices,
    after: null,
    runId: null,
  });
  return { account, recorded };
}

/** A second charge of the same money, a day after the sole candidate's. */
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
        id: suggestionTable.id,
        fingerprint: suggestionTable.fingerprint,
      })
      .from(suggestionTable)
      .where(
        and(
          eq(suggestionTable.family, "statement_transaction"),
          eq(suggestionTable.active, true),
        ),
      )
      .orderBy(desc(suggestionTable.createdAt))
      .limit(1)
  )[0]!;

// Failure modes: clean booking is invisible or cannot be paused; a measured
// attach bypasses its pause; stale automatic commands ignore the persisted
// switch; feedback retries reapply rejected or already-booked evidence.
describe("clean import booking controls", () => {
  const ctx = withTestDb();

  it.each([
    { scope: "import", booking: true, booked: true },
    { scope: "account/date", booking: true, booked: false },
  ] as const)(
    "books clean $scope spending only in import scope",
    async ({ scope, booked }) => {
      const { account, recorded } = await unmatchedCharge(ctx);
      const collection = await getDb(ctx.db).query.transactionImport.findFirst({
        where: {
          RAW: (table, { eq }) =>
            relationalSql(table, eq(table.id, recorded.batchId!)),
        },
      });
      const withdrawals = () =>
        getDb(ctx.db).execute(
          sql`
        SELECT id, "withdrawnAt", "withdrawalImportId" FROM ${sourceObservationFrom} ORDER BY id
      `,
          "objects",
        );
      const beforeWithdrawals = await withdrawals();
      const result = await labelStatementSuggestions(ctx.db, {
        port: sameCharge,
        scope:
          scope === "import"
            ? { importId: recorded.batchId! }
            : {
                accountIds: [
                  await resolveOrThrow(ctx.db, "financialAccount", account.id),
                ],
                since: "2026-05-01",
              },
      });
      expect(result.failed).toEqual([]);
      const suggestion = await chargeSuggestion(ctx);
      expect((await stateOf(ctx, suggestion.id)).status).toBe(
        booked ? "applied" : "pending",
      );
      expect(await getDb(ctx.db).select().from(expense)).toHaveLength(
        booked ? 1 : 0,
      );
      const audit = await listAutomaticDecisions(ctx.db, {
        family: "statement_transaction",
        limit: 20,
      });
      expect(audit.items.map(({ automaticRule }) => automaticRule)).toEqual(
        booked ? [ruleBase(BOOK_SPENDING)] : [],
      );
      expect(
        await getDb(ctx.db).query.transactionImport.findFirst({
          where: {
            RAW: (table, { eq }) =>
              relationalSql(table, eq(table.id, recorded.batchId!)),
          },
        }),
      ).toEqual(collection);
      expect(await withdrawals()).toEqual(beforeWithdrawals);
    },
  );

  it("does not automatically reapply an unchanged pending suggestion marked Wrong", async () => {
    await unmatchedCharge(ctx);
    await label(ctx);
    const suggestion = await chargeSuggestion(ctx);
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: suggestion.id,
      operationId: "synthetic-pending-wrong",
      verdict: "wrong",
      intent: "history",
    });
    const history = await feedbackFor(ctx, suggestion.id);
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
    });
    await label(ctx);
    expect(
      (
        await applyAutomaticRules(ctx.db, [suggestion.id], {
          context: buildCrudServices,
          importClean: true,
        })
      ).applied,
    ).toEqual([]);
    expect((await stateOf(ctx, suggestion.id)).status).toBe("rejected");
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await feedbackFor(ctx, suggestion.id)).toEqual(history);
  });
});

describe("automatic field assignments", () => {
  const ctx = withTestDb();
  it.each([0.849, 0.85, 0.88])(
    "fills an untouched empty category only at high confidence (%s)",
    async (confidence) => {
      const item = await productFixture(ctx, "Synthetic unclassified product");
      const sweep = await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          fields: ["categoryId"],
          filters: { ids: [item.id] },
        },
        { context: kernelCtx(ctx), ...categoryPorts(confidence) },
      );
      const [state] = await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(eq(suggestionTable.runId, sweep.id));
      expect(state?.status).toBe(confidence >= 0.85 ? "applied" : "pending");
      expect(await productCategoryId(ctx.db, item.id)).toBe(
        confidence >= 0.85 ? taxonomyId("food") : null,
      );
    },
  );
  it("propagates a serialization abort from automatic preflight", async () => {
    const untouched = await productFixture(ctx, "Synthetic preflight recovery");
    const pending = await seedPending(ctx, {
      entity: "product",
      recordId: await resolveOrThrow(ctx.db, "product", untouched.id),
      field: "categoryId",
      kind: "addition",
      currentValue: null,
      suggestedValue: taxonomyShortcode("food"),
    });
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({ confidence: 0.9 })
      .where(eq(suggestionTable.id, pending.id));
    const preflight = vi
      .spyOn(suggestionReview, "canAutomaticallyFillField")
      .mockImplementationOnce(async (db) => {
        // A real SQL abort before review's savepoint must reach the owner.
        await getDb(db).execute(
          sql`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Synthetic automatic preflight serialization'; END $$`,
        );
        return true;
      });
    try {
      await expect(
        withTransactionDatabase(ctx.db, (tx) =>
          applyAutomaticRules(tx, [pending.id], {
            context: { ...kernelCtx(ctx), db: tx },
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "40001" } });
      expect(preflight).toHaveBeenCalledTimes(1);
    } finally {
      preflight.mockRestore();
    }
    expect((await stateOf(ctx, pending.id)).status).toBe("pending");
    expect(await productCategoryId(ctx.db, untouched.id)).toBeNull();
  });
  // Failure: receipt-backed provenance survives a member edit, ABA edit, or confirmation.
  it.each(["edit", "restore", "confirm"] as const)(
    "clears list auto provenance after member %s",
    async (action) => {
      const item = await productFixture(ctx, "Synthetic automatic provenance");
      const sweep = await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          fields: ["categoryId"],
          filters: { ids: [item.id] },
        },
        { context: kernelCtx(ctx), ...categoryPorts(0.9) },
      );
      const [state] = await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(eq(suggestionTable.runId, sweep.id));
      expect(state?.status).toBe("applied");
      if (!state) throw new Error("Missing automatic application");
      expect(
        (
          await loadCurrentFieldOwnership(ctx.db, "product", [state.recordId!])
        ).get(state.recordId!)?.categoryId,
      ).toEqual({ kind: "automatic", receiptId: state.id, confidence: 0.9 });
      expect(
        (
          await loadCurrentFieldOwnership(
            ctx.db,
            "product",
            [state.recordId!],
            ["categoryId"],
          )
        ).get(state.recordId!)?.categoryId,
      ).toEqual({ kind: "automatic", receiptId: state.id, confidence: 0.9 });
      expect(
        await loadCurrentFieldOwnership(
          ctx.db,
          "product",
          [state.recordId!],
          ["id"],
        ),
      ).toEqual(new Map());
      const list = async () =>
        executeEntity(kernelCtx(ctx), {
          action: "list",
          entity: "product",
          filters: { ids: [item.id] },
          pagination: { pageIndex: 0, pageSize: 10 },
        });
      expect(await list()).toMatchObject({
        items: [
          {
            id: item.id,
            fields: {
              categoryId: {
                current: {
                  assignment: {
                    kind: "value",
                    ownership: { kind: "automatic", confidence: 0.9 },
                  },
                },
              },
            },
          },
        ],
      });
      expect((await list()).meta).not.toHaveProperty("derived");
      if (action === "confirm") {
        await reviewSuggestion(ctx.db, kernelCtx(ctx), {
          suggestionId: state.id,
          operationId: "synthetic-auto-confirmation",
          verdict: "correct",
          intent: "history",
        });
      } else {
        await executeEntity(
          kernelCtx(ctx),
          entityCommandSchema.parse({
            action: "update",
            entity: "product",
            id: item.id,
            data: { categoryId: taxonomyShortcode("tools") },
          }),
        );
        if (action === "restore")
          await executeEntity(
            kernelCtx(ctx),
            entityCommandSchema.parse({
              action: "update",
              entity: "product",
              id: item.id,
              data: { categoryId: taxonomyShortcode("food") },
            }),
          );
      }
      // Authority changes synchronously, without waiting for background work.
      expect(
        (
          await loadCurrentFieldOwnership(ctx.db, "product", [state.recordId!])
        ).get(state.recordId!)?.categoryId,
      ).toBeUndefined();
      const refreshed = await list();
      expect(refreshed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: item.id,
            fields: expect.objectContaining({
              categoryId: expect.objectContaining({
                current: expect.objectContaining({
                  assignment: expect.objectContaining({
                    ownership: { kind: "record" },
                  }),
                }),
              }),
            }),
          }),
        ]),
      );
    },
  );
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
    if (
      effective.action !== "get" ||
      effective.entity !== "vendor" ||
      !effective.item
    )
      throw new Error("Synthetic Vendor read returned no Vendor");
    expect(fieldValueOf(effective.item.fields.itemizationExpectation)).toBe(
      "required",
    );
    expect(effective.item).not.toHaveProperty("fieldResolutions");
    const pending = await seedPending(ctx, {
      entity: "vendor",
      recordId: stored!.id,
      field: "itemizationExpectation",
      currentValue: null,
      suggestedValue: "not_expected",
      kind: "addition",
    });
    await getDb(ctx.db)
      .update(suggestionTable)
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
      .where(eq(suggestionTable.id, pending.id));
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
      .update(suggestionTable)
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
      .where(eq(suggestionTable.id, pending.id));
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
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, sweep.id));
    expect(pending).toMatchObject({ kind: "correction", status: "pending" });
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("tools"));
    expect(await feedbackFor(ctx, pending!.id)).toEqual([]);
  });
});
