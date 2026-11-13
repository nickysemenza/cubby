import { systemActor } from "@cubby/schemas/context";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
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
import {
  applySpendingClassificationReview,
  previewSpendingClassificationReview,
} from "~/server/domains/spending-category/repo/spending-classification-review";
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
import { ruleBase } from "~/server/generic/suggestions/repo/automatic-policy";
import { fieldAuthority } from "~/server/generic/suggestions/repo/field-authority";
import { applyFieldAuthorityAction } from "~/server/generic/suggestions/repo/field-authority-actions";
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

async function unmatchedCharge(ctx: Ctx, income = false) {
  const account = (await card(ctx)).output;
  if (!income)
    await createRepoEntity(ctx, "vendor", { name: "Example Grocer" });
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
          ...(income
            ? {
                providerAmount: 1200,
                merchant: "Example Employer",
                rawDescription: "EXAMPLE EMPLOYER PAYROLL",
                sourceCategory: "Paychecks",
              }
            : {
                providerAmount: -42.5,
                merchant: "Example Grocer",
                rawDescription: "EXAMPLE GROCER 0001",
                sourceCategory: "Groceries",
              }),
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
    { scope: "import", income: false, booked: true },
    { scope: "account/date", income: false, booked: true },
    { scope: "import", income: true, booked: true },
  ] as const)(
    "books clean $scope work (income: $income)",
    async ({ scope, income, booked }) => {
      const { account, recorded } = await unmatchedCharge(ctx, income);
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
        port: income
          ? answering({ kind: "income", counterparty: "business" })
          : sameCharge,
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
      // Income settles without spending.
      expect(await getDb(ctx.db).select().from(expense)).toHaveLength(
        booked && !income ? 1 : 0,
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
          settlement: true,
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
  /** A confident pending answer for one Product's category, as a refresh publishes it. */
  const confidentCategory = async (
    recordId: string,
    current: string | null,
    proposed: string,
  ) => {
    const pending = await seedPending(ctx, {
      entity: "product",
      recordId,
      field: "categoryId",
      kind: current === null ? "addition" : "correction",
      currentValue: current,
      suggestedValue: proposed,
    });
    await getDb(ctx.db)
      .update(suggestionTable)
      .set({
        confidence: 0.97,
        provenance: {
          dependencies: dependencyStamps(
            await producingAiManifest(ctx.db),
            fieldDependencyKeys("product", "categoryId"),
          ),
          inputFingerprint: "synthetic",
          optionFingerprint: "synthetic",
          model: "typesafe/jev",
        },
      })
      .where(eq(suggestionTable.id, pending.id));
    return pending.id;
  };
  const automaticallyApplied = async (
    item: { id: string },
    current: string | null,
    proposed: string,
  ) => {
    const recordId = await resolveOrThrow(ctx.db, "product", item.id);
    const id = await confidentCategory(recordId, current, proposed);
    if (!(await canAutomaticallyFillField(ctx.db, kernelCtx(ctx), id)))
      return false;
    await applyAutomaticRules(ctx.db, [id], { context: kernelCtx(ctx) });
    return (await stateOf(ctx, id)).status === "applied";
  };
  const holderOf = async (item: { id: string }) =>
    (
      await fieldAuthority(
        ctx.db,
        "product",
        await resolveOrThrow(ctx.db, "product", item.id),
        "categoryId",
      )
    ).holder;
  const writeCategory = (
    item: { id: string },
    category: string,
    actorContext = kernelCtx(ctx).actorContext,
  ) =>
    executeEntity(
      { ...kernelCtx(ctx), actorContext },
      entityCommandSchema.parse({
        action: "update",
        entity: "product",
        id: item.id,
        data: { categoryId: category },
      }),
    );
  const sweptCubbyValue = async (name: string) => {
    const item = await productFixture(ctx, name);
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.9) },
    );
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("food"));
    expect(await holderOf(item)).toBe("cubby");
    return item;
  };

  // Dangerous rule: Cubby never overwrites a value a person, an import or an
  // agent decided, and revises only values it set and nobody kept.
  it.each(["member", "agent", "import"] as const)(
    "never overwrites a value written by a %s",
    async (writer) => {
      const item = await productFixture(ctx, `Synthetic ${writer} value`);
      const base = kernelCtx(ctx).actorContext;
      await writeCategory(
        item,
        taxonomyShortcode("tools"),
        writer === "member"
          ? base
          : writer === "agent"
            ? { ...base, channel: "mcp" }
            : systemActor(),
      );
      expect(await holderOf(item)).toBe("person");
      expect(
        await automaticallyApplied(
          item,
          taxonomyShortcode("tools"),
          taxonomyShortcode("food"),
        ),
      ).toBe(false);
      expect(await productCategoryId(ctx.db, item.id)).toBe(
        taxonomyId("tools"),
      );
    },
  );

  it("treats a value set at creation as a person's", async () => {
    const item = await productFixture(ctx, "Synthetic created value", {
      categoryId: taxonomyId("tools"),
    });
    expect(await holderOf(item)).toBe("person");
  });

  it.each(["edit", "restore"] as const)(
    "a member %s ends Cubby's hold at once",
    async (action) => {
      const item = await sweptCubbyValue(`Synthetic member ${action}`);
      await writeCategory(item, taxonomyShortcode("tools"));
      if (action === "restore")
        await writeCategory(item, taxonomyShortcode("food"));
      expect(await holderOf(item)).toBe("person");
      const listed = await executeEntity(kernelCtx(ctx), {
        action: "list",
        entity: "product",
        filters: { ids: [item.id] },
        pagination: { pageIndex: 0, pageSize: 10 },
      });
      expect(listed).toMatchObject({
        items: [
          {
            id: item.id,
            fields: {
              categoryId: {
                current: { assignment: { ownership: { kind: "record" } } },
              },
            },
          },
        ],
      });
    },
  );

  it("revises its own value, never returns to one it replaced, and stops once kept", async () => {
    const item = await sweptCubbyValue("Synthetic revisable value");
    expect(
      await automaticallyApplied(
        item,
        taxonomyShortcode("food"),
        taxonomyShortcode("tools"),
      ),
    ).toBe(true);
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("tools"));
    expect(await holderOf(item)).toBe("cubby");
    // No return: the value Cubby replaced is never applied again.
    expect(
      await automaticallyApplied(
        item,
        taxonomyShortcode("tools"),
        taxonomyShortcode("food"),
      ),
    ).toBe(false);
    await applyFieldAuthorityAction(ctx.db, kernelCtx(ctx), {
      entity: "product",
      id: item.id,
      field: "categoryId",
      action: "keep",
    });
    expect(await holderOf(item)).toBe("person");
    expect(
      await automaticallyApplied(
        item,
        taxonomyShortcode("tools"),
        taxonomyShortcode("household"),
      ),
    ).toBe(false);
  });

  it("clears a wrong value, rules it out, and accepts another", async () => {
    const item = await sweptCubbyValue("Synthetic wrong value");
    await applyFieldAuthorityAction(ctx.db, kernelCtx(ctx), {
      entity: "product",
      id: item.id,
      field: "categoryId",
      action: "clear",
    });
    expect(await productCategoryId(ctx.db, item.id)).toBeNull();
    expect(await holderOf(item)).toBe("open");
    expect(
      await automaticallyApplied(item, null, taxonomyShortcode("food")),
    ).toBe(false);
    expect(
      await automaticallyApplied(item, null, taxonomyShortcode("tools")),
    ).toBe(true);
  });

  it("revises a member's value only after the member hands it back", async () => {
    const item = await productFixture(ctx, "Synthetic released value");
    await writeCategory(item, taxonomyShortcode("tools"));
    await applyFieldAuthorityAction(ctx.db, kernelCtx(ctx), {
      entity: "product",
      id: item.id,
      field: "categoryId",
      action: "release",
    });
    expect(await holderOf(item)).toBe("cubby");
    expect(
      await automaticallyApplied(
        item,
        taxonomyShortcode("tools"),
        taxonomyShortcode("food"),
      ),
    ).toBe(true);
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("food"));
  });

  it("treats a value written after a hand-back without its own audit row as a person's", async () => {
    const item = await productFixture(ctx, "Synthetic out-of-band value");
    await writeCategory(item, taxonomyShortcode("tools"));
    await applyFieldAuthorityAction(ctx.db, kernelCtx(ctx), {
      entity: "product",
      id: item.id,
      field: "categoryId",
      action: "release",
    });
    await getDb(ctx.db).execute(
      sql`UPDATE "Product" SET "categoryId" = ${taxonomyId("household")} WHERE shortcode = ${item.id}`,
    );
    expect(await holderOf(item)).toBe("person");
  });

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

  // Dangerous rule: an undecided placeholder is open to Cubby, while a profile
  // a person chose is never overwritten.
  it("treats an undecided Vendor spending profile as open until a person decides it", async () => {
    const merchant = (
      await createRepoEntity(ctx, "vendor", {
        name: "Synthetic hosting vendor",
      })
    ).output;
    const recordId = await resolveOrThrow(ctx.db, "vendor", merchant.id);
    const holder = async () =>
      (await fieldAuthority(ctx.db, "vendor", recordId, "spendingProfile"))
        .holder;
    const confidentProfile = async () => {
      const pending = await seedPending(ctx, {
        entity: "vendor",
        recordId,
        field: "spendingProfile",
        currentValue: "unspecified",
        suggestedValue: "single_category",
        kind: "addition",
      });
      await getDb(ctx.db)
        .update(suggestionTable)
        .set({
          confidence: 0.97,
          provenance: {
            dependencies: dependencyStamps(
              await producingAiManifest(ctx.db),
              fieldDependencyKeys("vendor", "spendingProfile"),
            ),
            inputFingerprint: "synthetic",
            optionFingerprint: "synthetic",
            model: "typesafe/jev",
          },
        })
        .where(eq(suggestionTable.id, pending.id));
      return pending.id;
    };
    expect(await holder()).toBe("open");
    expect(
      await canAutomaticallyFillField(
        ctx.db,
        kernelCtx(ctx),
        await confidentProfile(),
      ),
    ).toBe(true);
    // A person decides the profile through the reviewed classification flow.
    const request = {
      action: "vendor" as const,
      vendorId: parseShortcodeFor("vendor", merchant.id),
      spendingProfile: "mixed_retail" as const,
      defaultSpendingCategoryId: null,
    };
    await applySpendingClassificationReview(kernelCtx(ctx), {
      request,
      fingerprint: (await previewSpendingClassificationReview(ctx.db, request))
        .fingerprint,
    });
    expect(await holder()).toBe("person");
    expect(
      await canAutomaticallyFillField(
        ctx.db,
        kernelCtx(ctx),
        await confidentProfile(),
      ),
    ).toBe(false);
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
