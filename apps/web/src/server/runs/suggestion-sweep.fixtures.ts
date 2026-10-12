import { type FieldSuggestion, fieldSuggestionsOut } from "@cubby/schemas/ai";
import { entityRefKey } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  parseEntityRef,
  runShortcode,
  type RunId,
} from "@cubby/schemas/identifiers";
import type { ProductCategoryFeature } from "@cubby/schemas/product-category-fields";
import {
  type SupportedDecisionModel,
  supportedDecisionModelSchema,
} from "@cubby/shared/ai/models";
import { eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import type { TestDbContext } from "tooling/test-setup";

import type { DecisionPort } from "~/server/ai/decision-model";
import type { ReferenceSuggestSpec } from "~/server/ai/field-suggest/registry";
import type { Database } from "~/server/db";
import {
  expense as expenseTable,
  product as productTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel/adapter";
import { getDb } from "~/server/repo/database-helpers";
import { createProduct } from "~/server/repo/product/crud";
import { makeProductInput } from "~/server/repo/repo.fixtures";
import {
  lookupShortcodes,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

import { ensureRun } from "./ensure-run";
import {
  startSuggestionSweep as startSweep,
  resumeSuggestionSweep as resumeSweep,
} from "./suggestion-sweep";

type Ctx = Pick<TestDbContext, "db" | "actor">;
type SweepPorts = Parameters<typeof startSweep>[2];

export const PRIMARY_MODEL =
  "typesafe/jev" as const satisfies SupportedDecisionModel;
const otherDecisionModels = supportedDecisionModelSchema.options.filter(
  (model) => model !== PRIMARY_MODEL,
);
// The sweep pairs the pinned model with the one other supported decision model.
if (otherDecisionModels.length !== 1)
  throw new Error("Paired sweeps expect exactly two decision models");
export const PAIRED_MODEL = otherDecisionModels[0]!;

export const kernelCtx = (ctx: Ctx) =>
  entityKernelContextSchema.parse(
    createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
  );

/** Defaults: pinned primary model, no paired sampling, no pacing waits. */
const sweepDefaults = {
  decisionModel: () => PRIMARY_MODEL,
  samplePair: () => false,
  wait: async () => {},
};
export const startSuggestionSweep = (
  db: Database,
  input: Parameters<typeof startSweep>[1],
  ports: SweepPorts,
) => startSweep(db, input, { ...sweepDefaults, ...ports });
export const resumeSuggestionSweep = (
  db: Database,
  runId: Parameters<typeof resumeSweep>[1],
  ports: SweepPorts,
) => resumeSweep(db, runId, { ...sweepDefaults, ...ports });

export async function recordId<E extends ShortcodeEntity>(
  db: Database,
  shortcode: string,
  entity: E,
) {
  const id = await resolveLiveShortcode(db, shortcode, entity);
  if (!id) throw new Error(`Synthetic ${entity} record is missing`);
  return id;
}

/** The review queue filters by a Run's public shortcode. */
export async function runCode(db: Database, id: string) {
  const codes = await lookupShortcodes(db, [parseEntityRef("run", id)]);
  const code = codes.get(entityRefKey("run", id));
  if (!code) throw new Error("Synthetic Run is missing");
  return runShortcode.parse(code);
}

export const productFixture = (
  ctx: Ctx,
  name: string,
  input: {
    manufacturer?: string;
    categoryId?: ReturnType<typeof taxonomyId>;
  } = {},
) =>
  createProduct(
    ctx.db,
    makeProductInput({ name, manufacturer: "Synthetic maker", ...input }),
    ctx.actor,
  );

export const expenseFixture = (
  db: Database,
  name: string,
  input: Partial<
    Pick<typeof expenseTable.$inferInsert, "date" | "purchaseId">
  > = {},
) =>
  insertWithShortcode(db, "expense", {
    name,
    cost: 12,
    date: "2026-09-01",
    costType: "materials",
    trade: "other",
    ...input,
  });

/** A pending Suggestion on a completed ai_suggest Run. */
export async function seedPending(
  ctx: Ctx,
  row: Pick<
    typeof suggestionTable.$inferInsert,
    "entity" | "recordId" | "field" | "currentValue" | "suggestedValue" | "kind"
  >,
) {
  const runId = await ensureRun(ctx.db, ctx.actor, {
    purpose: "ai_suggest",
    trigger: "manual",
    status: "completed",
  });
  const [saved] = await getDb(ctx.db)
    .insert(suggestionTable)
    .values({
      runId,
      confidence: 0.8,
      model: PRIMARY_MODEL,
      status: "pending",
      ...row,
    })
    .returning({ id: suggestionTable.id });
  if (!saved) throw new Error("Synthetic Suggestion was not persisted");
  return { runId, id: saved.id };
}

export async function suggestionStatus(db: Database, id: string) {
  const [row] = await getDb(db)
    .select({ status: suggestionTable.status })
    .from(suggestionTable)
    .where(eq(suggestionTable.id, id));
  return row?.status;
}

export const runSuggestions = (db: Database, runId: RunId) =>
  getDb(db)
    .select()
    .from(suggestionTable)
    .where(eq(suggestionTable.runId, runId));

export async function productCategoryId(db: Database, shortcode: string) {
  const id = await recordId(db, shortcode, "product");
  const [row] = await getDb(db)
    .select({ categoryId: productTable.categoryId })
    .from(productTable)
    .where(eq(productTable.id, id));
  return row?.categoryId;
}

/** A `suggest` port result proposing `decision.value` for one field. */
export const suggestion = (
  field: string,
  decision: Pick<FieldSuggestion, "value" | "label"> & {
    probability: number;
    financeReview?: FieldSuggestion["financeReview"];
  },
) =>
  fieldSuggestionsOut.parse({
    suggestions: {
      [field]: {
        detail: null,
        confidence: decision.probability >= 0.85 ? "high" : "medium",
        reasoning: "Synthetic decision",
        alternatives: [],
        ...decision,
      },
    },
  });

/** A `suggest` port result that evaluated the field and proposed nothing. */
export const noProposal = (field: string) =>
  fieldSuggestionsOut.parse({
    suggestions: { [field]: null },
    outcomes: {
      [field]: {
        kind: "evaluated",
        answer: "none",
        confidence: "high",
        probability: 0.9,
        alternatives: [],
      },
    },
  });

/** The single category the decision roster offers, so every decision proposes it. */
export const SUGGESTED_CATEGORY: ProductCategoryFeature = "food";

type CategoryCandidate = { id: string; title: string };
const categorySpec: ReferenceSuggestSpec<CategoryCandidate> = {
  kind: "reference",
  entity: "productCategory",
  rules: "Choose the category.",
  maxCandidates: 5,
  roster: async () => [
    { id: taxonomyShortcode(SUGGESTED_CATEGORY), title: "Synthetic food" },
  ],
  idOf: (candidate) => candidate.id,
  labelOf: (candidate) => candidate.title,
  renderLine: ({ id, title }) => `${id} | ${title}`,
  subject: (basis) => `Product: ${basis.name ?? ""}`,
};

const decisionAt =
  (confidence: number): DecisionPort =>
  async (input) => {
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = keys[0]!;
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
                : (1 - confidence) / Math.max(1, keys.length - 1),
            ]),
          ),
        },
      },
    };
  };

/** Real field-suggest path for `product.categoryId` with a scripted the decision model. */
export const categoryPorts = (confidence = 0.97) => ({
  suggestPorts: {
    decisionPort: decisionAt(confidence),
    registry: { "product.categoryId": categorySpec },
  },
});
