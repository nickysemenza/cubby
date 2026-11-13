import { type FieldSuggestion, fieldSuggestionsOut } from "@cubby/schemas/ai";
import { entityRefKey } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  parseEntityRef,
  runShortcode,
  type RunId,
  type VendorId,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ProductCategoryFeature } from "@cubby/schemas/product-category-fields";
import { RUN_KINDS } from "@cubby/schemas/run-fields";
import type { SupportedDecisionModel } from "@cubby/shared/ai/models";
import { eq } from "drizzle-orm";
import { driveAiWork } from "tooling/ai-work";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import type { TestDbContext } from "tooling/test-setup";

import type { DecisionPort } from "~/server/ai/decision-model";
import type { ReferenceSuggestSpec } from "~/server/ai/field-suggest/registry";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  expense as expenseTable,
  product as productTable,
  suggestionTable,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel/adapter";
import {
  lookupShortcodes,
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";
import { controlWorkflowRun } from "~/server/workflows/runs/control";

import { ensureRun } from "../repo/ensure-run";
import type { StepPlan } from "./step-run";
import {
  rosterSuggestionTargets,
  suggestionSweepInput,
  type SuggestionSweepPorts,
} from "./suggestion-sweep";
import { startSweep, sweepStepDrivers } from "./sweep";

type Ctx = Pick<TestDbContext, "db" | "actor">;
type SweepPorts = SuggestionSweepPorts;
type SweepInput = {
  entity: ShortcodeEntity;
  fields: string[];
  filters: Record<
    string,
    import("./../repo/suggestion-sweep-state").SuggestionValue
  >;
  trigger?: "manual" | "scheduled";
};

export const PRIMARY_MODEL =
  "typesafe/jev" as const satisfies SupportedDecisionModel;

export const kernelCtx = (ctx: Ctx) =>
  entityKernelContextSchema.parse(
    createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
  );

/** Provider seam shared by the existing review journeys. */
const sweepDefaults = {
  decisionModel: () => PRIMARY_MODEL,
};
function fieldPlan(
  target: Omit<SweepInput, "trigger">,
  ports: SweepPorts,
): StepPlan {
  return RUN_KINDS.sweep.steps
    .filter((step) => step.family === "field")
    .map((declaration) => ({
      declaration,
      driver:
        declaration.key === "field_roster"
          ? {
              ...sweepStepDrivers.field_roster,
              page: async ({ db, run }) => ({
                kind: "progress" as const,
                delta: { done: 1 },
                cursor: 1,
                tallies: {
                  evaluations: await rosterSuggestionTargets(
                    db,
                    run.id,
                    await suggestionSweepInput(db, target, ports),
                    ports,
                  ),
                },
                done: true,
              }),
            }
          : sweepStepDrivers.field_evaluate,
    }));
}
export const startSuggestionSweep = async (
  db: Database,
  input: SweepInput,
  ports: SweepPorts,
) => {
  const options = { ...sweepDefaults, ...ports };
  const { trigger = "manual", ...target } = input;
  const id = await startSweep(db, ports.context.actorContext, {
    trigger,
    families: [{ family: "field", scope: { targets: [target] } }],
  });
  await driveAiWork(db, id, { sweep: options }, fieldPlan(target, options));
  return { id };
};
export const resumeSuggestionSweep = async (
  db: Database,
  runId: RunId,
  ports: SweepPorts,
) => {
  const options = { ...sweepDefaults, ...ports };
  await controlWorkflowRun(
    db,
    ports.context.actorContext,
    { runPublicId: await runCode(db, runId), action: "resume" },
    "sweep",
  );
  await driveAiWork(db, runId, { sweep: options });
};

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
    brandId?: VendorId | VendorShortcode | null;
    model?: ReturnType<typeof makeProductInput>["model"];
    notes?: string;
    categoryId?: ReturnType<typeof taxonomyId>;
  } = {},
) =>
  createProductFixture(ctx.db, makeProductInput({ name, ...input }), ctx.actor);

export const expenseFixture = (
  db: Database,
  name: string,
  input: Partial<
    Pick<typeof expenseTable.$inferInsert, "date" | "purchaseId">
  > = {},
) =>
  insertWithShortcode(db, "expense", {
    lineKind: "principal",
    name,
    cost: 1200n,
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
    "entity" | "field" | "currentValue" | "suggestedValue" | "kind"
  > & { field: string; recordId: string },
) {
  const runId = await ensureRun(ctx.db, ctx.actor, {
    purpose: "ai_suggest",
    trigger: "manual",
    status: "completed",
  });
  const saved = await seedFieldSuggestion(
    ctx.db,
    {
      runId,
      confidence: 0.8,
      model: PRIMARY_MODEL,
      status: "pending",
      ...row,
      data: {
        liveInputFingerprint: await fieldInputFingerprint(
          ctx.db,
          row.entity,
          row.recordId,
          row.field,
        ),
      },
    },
    true,
  );
  return { runId, id: saved.id };
}

/** Eligibility follows current field inputs; historical state need not be rewritten. */
export async function isSuggestionReviewable(db: Database, id: string) {
  return (await readReviewFields(db, { minConfidence: 0 })).some(
    (row) => row.id === id,
  );
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

export const decisionAt =
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

/** Existing review journeys use the production key reader and field hydrator. */
export async function readReviewFields(
  db: Database,
  input: {
    entity?: ShortcodeEntity;
    field?: string;
    fields?: string[];
    kind?: "addition" | "correction";
    status?: "pending" | "applied" | "rejected" | "superseded";
    minConfidence?: number;
    limit?: number;
    recordIds?: string[];
    runId?: string;
  } = {},
) {
  if (input.recordIds && !input.entity)
    throw new Error("recordIds filters one entity's records; name its entity.");
  const { fieldSuggestionKeys, readFieldSuggestions } =
    await import("~/server/generic/suggestions/repo/suggestion-review");
  const keys = await fieldSuggestionKeys(db, {
    status: input.status ?? "pending",
    entities: input.entity ? [input.entity] : undefined,
    runId: input.runId,
    recordUuids:
      input.recordIds && input.entity
        ? [
            ...(
              await resolveLiveShortcodes(db, input.recordIds, input.entity)
            ).values(),
          ]
        : undefined,
  });
  const selected = keys.filter(
    (row) =>
      row.confidence >= (input.minConfidence ?? 0.5) &&
      (!input.field || row.field === input.field) &&
      (!input.fields || input.fields.includes(row.field)) &&
      (!input.kind || row.kind === input.kind),
  );
  return readFieldSuggestions(
    db,
    selected.slice(0, input.limit ?? 500).map((row) => row.id),
  );
}
