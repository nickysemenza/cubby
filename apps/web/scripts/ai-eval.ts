// Minimal eval harness comparing SupportedChatModel tiers on live (read-only)
// Cubby data. See docs/agents/validation.md and the B4 plan section for
// context. Usage:
//
//   pnpm --dir apps/web exec tsx scripts/ai-eval.ts \
//     --feature recipe-flow|detection|category|usda|merge \
//     --models a,b --limit 20 [--out path]
//
// or `pnpm --dir apps/web ai:eval -- ...` via the package script.
//
// HARD RULE: the dev DATABASE_URL is production Neon. This script opens a
// READ ONLY session (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`
// on every physical connection) and must never write. Any write attempt made
// by a called production function (e.g. best-effort AI-usage telemetry) is
// expected to fail at the database level and be swallowed by that function's
// own error handling — it is not this script's job to succeed at writing.
//
// `clients/ai.ts` owns the production system prompts. This script never
// duplicates their text: `category`, `detection`, and `recipe-flow` each pull
// their systemPrompts/messages/outputSchema from a pure request builder
// exported by `clients/ai.ts` (`buildCategorySuggestionRequest`,
// `buildInventoryDetectionRequest`, `buildRecipeFlowRequest`) — the same
// builder the corresponding `AiClient` method calls in production. Every
// requested model, including the one matching a feature's built-in tier,
// runs that shared request through a hand-built `chat()` call against
// `chatAdapterFor` with local usage capture — never through the public
// `AiClient` methods, whose usage hook writes AiUsage rows and exposes no
// token/cost data. This keeps token/cost/latency capture uniform across every
// row in the table. `usda` and `merge` are the exception: they always run on
// FAST_MODEL through the real `suggestUsdaFood`/`suggestIngredientMerge`
// service functions (which build their own adapter internally), so `--models`
// is informational for those two features only.
import "dotenv/config";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AiAnalysisEntityType } from "@cubby/schemas/ai";
import { detectedInventoryAiResultSchema } from "@cubby/schemas/ai";
import {
  type IngredientId,
  type LocationId,
  type RecipeId,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe";
import { chat, type ChatMiddleware } from "@tanstack/ai";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";

import {
  type AiStructuredFeature,
  LOCATION_INVENTORY_DETECTION_FEATURE,
  PRODUCT_CATEGORY_SUGGESTION_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
} from "~/server/ai/features";
import { type AiChatRequest, modelOptionsFor } from "~/server/ai/run-feature";
import { normalizeEvalName } from "~/server/ai/inventory-detection-evals";
import {
  FAST_MODEL,
  type SupportedChatModel,
  catalogedChatModels,
  estimateAiUsageCostUsd,
  providerFor,
} from "~/server/ai/models";
import { chatAdapterFor } from "~/server/clients/ai-adapters";
import {
  buildCategorySuggestionRequest,
  buildInventoryDetectionRequest,
  buildRecipeFlowRequest,
} from "~/server/clients/ai";
import { surfaceStructuredOutputRunErrors } from "~/server/clients/structured-output-adapter";
import { USDAClient } from "~/server/clients/usda";
import { Database, type DatabaseRuntime } from "~/server/db/database";
import * as schema from "~/server/db/schema";
import { aiAnalysis, ingredient, product } from "~/server/db/schema";
import { getErrorMessage } from "~/lib/error-utils";
import { getLocationById } from "~/server/repo/location";
import { getRecipeByID } from "~/server/repo/recipe";
import { suggestIngredientMerge } from "~/server/services/ai-enrichment/ingredient-merge";
import { suggestUsdaFood } from "~/server/services/ai-enrichment/usda-match";
import {
  assessRecipeFlowCandidate,
  flowPromptInput,
} from "~/server/services/recipe-flow/recipe-flow.service";
import { USDAService } from "~/server/services/usda.service";

const FEATURES = [
  "recipe-flow",
  "detection",
  "category",
  "usda",
  "merge",
] as const;
type FeatureName = (typeof FEATURES)[number];

function isFeatureName(value: string): value is FeatureName {
  return FEATURES.some((feature) => feature === value);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  help: boolean;
  feature?: string;
  models: string[];
  limit?: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, models: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--feature":
        args.feature = argv[++i];
        break;
      case "--models":
        args.models = (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--limit":
        args.limit = Number(argv[++i]);
        break;
      case "--out":
        args.out = argv[++i];
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`Usage: pnpm --dir apps/web exec tsx scripts/ai-eval.ts --feature <feature> --models <a,b> --limit <N> [--out <path>]

Compares SupportedChatModel tiers on live (read-only) Cubby data.
Requires DATABASE_URL and AI_GATEWAY_API_KEY. Opens a READ ONLY session and
never writes. The dev DATABASE_URL is production Neon.

  --feature   ${FEATURES.join(" | ")}
  --models    comma-separated SupportedChatModel ids (usda/merge always run a
              fixed FAST tier internally; --models is informational there)
  --limit     max input rows to evaluate (default 20)
  --out       JSON output path (default $TMPDIR/cubby-ai-eval/<feature>-<iso>.json)

Valid models: ${catalogedChatModels().join(", ")}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtureSchema = z.object({
  ingredientNames: z.array(z.string().min(1)),
});
type Fixture = z.infer<typeof fixtureSchema>;

function loadFixture(): Fixture {
  const path = new URL("./fixtures/ai-eval-inputs.json", import.meta.url);
  return fixtureSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

// ---------------------------------------------------------------------------
// Read-only database bootstrap
//
// Mirrors the `ensure-db-extensions.ts` / test-setup.ts pattern: a raw pg
// Pool + drizzle client wrapped in the app's `Database` handle, never the
// full `~/server/db.ts` runtime (which owns its own pool and request-scope
// plumbing this standalone script has no business touching).
// ---------------------------------------------------------------------------

function openReadOnlyDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  pool.on("connect", (client) => {
    client
      .query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
      .catch((error) => {
        console.error(
          "[ai-eval] could not set the session read-only; refusing to continue:",
          getErrorMessage(error),
        );
        process.exit(1);
      });
  });
  const client = drizzle({ client: pool, schema });
  const runtime: DatabaseRuntime = {
    client,
    withConnection: async (fn) => {
      const connection = await pool.connect();
      try {
        return await fn(drizzle({ client: connection, schema }));
      } finally {
        connection.release();
      }
    },
  };
  return { db: new Database(() => runtime), pool };
}

/** No `~/env` (full app env validation) and no CF service binding — a plain
 * fetch to the local/public USDA API, matching `buildCrudServices`'s dev
 * fallback. `getLinkedProducts` is a no-op: `suggestUsdaFood`'s prompt never
 * reads a food's linked-products list. */
function buildUsdaService(): USDAService {
  const usdaClient = new USDAClient(
    process.env.USDA_API_URL ?? "http://localhost:8080/",
  );
  return new USDAService(usdaClient, async () => []);
}

// ---------------------------------------------------------------------------
// Shared metrics plumbing
// ---------------------------------------------------------------------------

interface CapturedUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Never `aiGatewayUsageMiddleware` (that writes AiUsage rows). Purely local
 * accumulation for this run's own reporting. */
function usageCapture(sink: CapturedUsage[]): ChatMiddleware[] {
  return [
    {
      name: "cubby-ai-eval-usage",
      async onFinish(_ctx, info) {
        sink.push({
          inputTokens: info.usage?.promptTokens ?? 0,
          outputTokens: info.usage?.completionTokens ?? 0,
        });
      },
    },
  ];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : intersection / union;
}

interface ModelRow {
  feature: string;
  model: string;
  n: number;
  passRate: number | null;
  agreement: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** false only when tokens WERE captured but pricing lookup failed — the
   * "add this model to the crate catalog" case that exits non-zero. */
  costKnown: boolean;
  p50Ms: number | null;
  note?: string;
  /** Per-input outcomes where a feature has a validator, for diagnosing a low pass rate. */
  samples?: readonly {
    index: number;
    ok: boolean;
    issues: readonly string[];
  }[];
}

function buildRow(args: {
  feature: string;
  model: SupportedChatModel;
  n: number;
  passRate: number | null;
  agreement: number | null;
  usage: CapturedUsage[] | null;
  latenciesMs: number[];
  note?: string;
  samples?: ModelRow["samples"];
}): ModelRow {
  const p50Ms = median(args.latenciesMs);
  if (args.usage === null) {
    return {
      feature: args.feature,
      model: args.model,
      n: args.n,
      passRate: args.passRate,
      agreement: args.agreement,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      costKnown: true,
      p50Ms,
      note:
        args.note ??
        "no token/cost data: this row calls a service function that builds its own adapter internally, exposing no usage hook",
      samples: args.samples,
    };
  }
  const inputTokens = args.usage.reduce((sum, u) => sum + u.inputTokens, 0);
  const outputTokens = args.usage.reduce((sum, u) => sum + u.outputTokens, 0);
  const costUsd = estimateAiUsageCostUsd(providerFor(args.model), args.model, {
    inputTokens,
    outputTokens,
  });
  return {
    feature: args.feature,
    model: args.model,
    n: args.n,
    passRate: args.passRate,
    agreement: args.agreement,
    inputTokens,
    outputTokens,
    costUsd,
    costKnown: costUsd !== null,
    p50Ms,
    note: args.note,
    samples: args.samples,
  };
}

/** Newest-first distinct entityIds recorded against one feature, from a
 * plain scan (not `listAiAnalysesForEntityFeature`, which needs a specific
 * entityId already in hand). */
async function distinctEntityIds(
  db: Database,
  feature: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .clientForRepository()
    .select({ entityId: aiAnalysis.entityId })
    .from(aiAnalysis)
    .where(and(eq(aiAnalysis.feature, feature), isNull(aiAnalysis.deletedAt)))
    .orderBy(desc(aiAnalysis.updatedAt))
    .limit(limit * 20);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    if (row.entityId && !seen.has(row.entityId)) {
      seen.add(row.entityId);
      ids.push(row.entityId);
      if (ids.length >= limit) break;
    }
  }
  return ids;
}

/** Most recent stored analysis for one entity/feature, any prompt version —
 * this is a read-only comparison baseline, not the cache the services use. */
async function latestAnalysisResult<T>(
  db: Database,
  entityType: AiAnalysisEntityType,
  entityId: string,
  feature: string,
  schema_: z.ZodType<T>,
): Promise<T | null> {
  const rows = await db
    .clientForRepository()
    .select({ result: aiAnalysis.result })
    .from(aiAnalysis)
    .where(
      and(
        eq(aiAnalysis.entityType, entityType),
        eq(aiAnalysis.entityId, entityId),
        eq(aiAnalysis.feature, feature),
        isNull(aiAnalysis.deletedAt),
      ),
    )
    .orderBy(desc(aiAnalysis.updatedAt))
    .limit(1);
  const parsed = schema_.safeParse(rows[0]?.result);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Generic per-model sweep — one chat() call per (model, item) pair, sharing
// the same gateway feature name, token cap, and local usage capture across
// every requested model. This is what keeps token/cost/latency uniform
// across every row, including the model matching a feature's built-in tier:
// no row here ever goes through a public `AiClient` method.
// ---------------------------------------------------------------------------

interface SweepOutcome<TOut> {
  results: TOut[];
  usage: CapturedUsage[];
  latenciesMs: number[];
}

/**
 * The feature record supplies the gateway label, the token cap, and the
 * output schema; only the prompt varies per item. `modelOptionsFor` keeps
 * the reasoning dial uniform across every model in the sweep (the record's
 * own tier-specific effort would not transfer).
 */
async function runModelSweep<TItem, TOut>(args: {
  models: SupportedChatModel[];
  items: TItem[];
  feature: AiStructuredFeature<TOut>;
  buildRequest: (item: TItem) => AiChatRequest;
}): Promise<Map<SupportedChatModel, SweepOutcome<TOut>>> {
  const byModel = new Map<SupportedChatModel, SweepOutcome<TOut>>();
  for (const model of args.models) {
    const outcome: SweepOutcome<TOut> = {
      results: [],
      usage: [],
      latenciesMs: [],
    };
    for (const item of args.items) {
      const built = args.buildRequest(item);
      const start = performance.now();
      // SAFETY: modelOptionsFor's return type is a union across provider
      // option shapes; chatAdapterFor's return type is the matching union
      // of adapters. Both are keyed off the same `model`'s route, so the
      // pairing is always consistent at runtime even though the union
      // collapses statically (see the "collapses modelOptions typing" note
      // in ai-adapters.ts).
      // SAFETY: `chat()`'s return type is a conditional on its own schema
      // and stream generics; called with this function's `TOut` still a type
      // parameter, that conditional can't resolve (a "deferred conditional
      // type") and widens to a union including the streaming branches. Every
      // caller passes a concrete `outputSchema` and no `stream`, so this
      // always runs the structured-output branch and resolves to
      // `Promise<TOut>` at runtime.
      const result = (await chat({
        adapter: surfaceStructuredOutputRunErrors(
          chatAdapterFor(model, {
            metadata: { feature: args.feature.feature, operation: "eval" },
            skipCache: true,
          }),
        ),
        modelOptions: modelOptionsFor(model, {
          maxTokens: args.feature.maxTokens,
        }) as never,
        middleware: usageCapture(outcome.usage),
        systemPrompts: built.systemPrompts,
        messages: built.messages,
        outputSchema: args.feature.schema,
      })) as TOut;
      outcome.latenciesMs.push(performance.now() - start);
      outcome.results.push(result);
    }
    byModel.set(model, outcome);
  }
  return byModel;
}

// ---------------------------------------------------------------------------
// category
// ---------------------------------------------------------------------------

interface CategoryItem {
  name: string;
  manufacturer: string;
  category: string | null;
}

/** Newest N live Products with a recorded category — the real ground truth,
 * not the fixture (the fixture only backs usda/merge-style curated cases;
 * this feature reads live data per the B4 spec). */
async function loadCategoryItems(
  db: Database,
  limit: number,
): Promise<CategoryItem[]> {
  return db
    .clientForRepository()
    .select({
      name: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
    })
    .from(product)
    .where(and(isNotNull(product.category), isNull(product.deletedAt)))
    .orderBy(desc(product.createdAt))
    .limit(limit);
}

async function runCategory(
  db: Database,
  models: SupportedChatModel[],
  limit: number,
): Promise<ModelRow[]> {
  const items = await loadCategoryItems(db, limit);
  const byModel = await runModelSweep({
    models,
    items,
    feature: PRODUCT_CATEGORY_SUGGESTION_FEATURE,
    buildRequest: (item) =>
      buildCategorySuggestionRequest(item.name, item.manufacturer),
  });

  return models.map((model) => {
    const { results, usage, latenciesMs } = byModel.get(model)!;
    const correct = results.filter(
      (r, i) => r.category === items[i]!.category,
    ).length;
    return buildRow({
      feature: "category",
      model,
      n: items.length,
      passRate: items.length ? correct / items.length : null,
      agreement: null,
      usage,
      latenciesMs,
    });
  });
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

interface DetectionEntity {
  locationId: LocationId;
  name: string;
  imageUrls: string[];
  stored: Set<string> | null;
}

async function loadDetectionEntities(
  db: Database,
  limit: number,
): Promise<DetectionEntity[]> {
  const entityIds = await distinctEntityIds(
    db,
    LOCATION_INVENTORY_DETECTION_FEATURE.feature,
    limit,
  );
  const entities: DetectionEntity[] = [];
  for (const id of entityIds) {
    let locationId: LocationId;
    try {
      locationId = parseEntityId("location", id);
    } catch {
      continue;
    }
    const location = await getLocationById(db, locationId).catch(() => null);
    if (!location) continue; // stale AiAnalysis row referencing a deleted location
    const imageUrls = (location.images ?? []).slice(0, 5).map((img) => img.url);
    if (imageUrls.length === 0) continue;
    const stored = await latestAnalysisResult(
      db,
      "location",
      id,
      LOCATION_INVENTORY_DETECTION_FEATURE.feature,
      detectedInventoryAiResultSchema,
    );
    entities.push({
      locationId,
      name: location.name,
      imageUrls,
      stored: stored
        ? new Set(stored.items.map((item) => normalizeEvalName(item.name)))
        : null,
    });
    if (entities.length >= limit) break;
  }
  return entities;
}

async function runDetection(
  db: Database,
  models: SupportedChatModel[],
  limit: number,
): Promise<ModelRow[]> {
  const entities = await loadDetectionEntities(db, limit);
  const byModel = await runModelSweep({
    models,
    items: entities,
    feature: LOCATION_INVENTORY_DETECTION_FEATURE,
    buildRequest: (entity) =>
      buildInventoryDetectionRequest(entity.imageUrls, entity.name),
  });

  const resultSetsByModel = new Map<
    SupportedChatModel,
    Map<string, Set<string>>
  >();
  const rows = models.map((model) => {
    const { results, usage, latenciesMs } = byModel.get(model)!;
    const resultSets = new Map<string, Set<string>>();
    const jaccardsVsStored: number[] = [];
    results.forEach((detection, i) => {
      const entity = entities[i]!;
      const names = new Set(
        detection.items.map((item) => normalizeEvalName(item.name)),
      );
      resultSets.set(entity.locationId, names);
      if (entity.stored) jaccardsVsStored.push(jaccard(names, entity.stored));
    });
    resultSetsByModel.set(model, resultSets);
    return buildRow({
      feature: "detection",
      model,
      n: entities.length,
      passRate: jaccardsVsStored.length ? average(jaccardsVsStored) : null,
      agreement: null, // filled in below once every requested model has run
      usage,
      latenciesMs,
      note: jaccardsVsStored.length
        ? undefined
        : "no stored AiAnalysis result for any sampled location to compare against",
    });
  });

  if (models.length >= 2) {
    const [first, second] = models;
    const setsA = resultSetsByModel.get(first!);
    const setsB = resultSetsByModel.get(second!);
    const pairwise = entities
      .map((entity) => {
        const namesA = setsA?.get(entity.locationId);
        const namesB = setsB?.get(entity.locationId);
        return namesA && namesB ? jaccard(namesA, namesB) : null;
      })
      .filter((v): v is number => v !== null);
    const agreement = pairwise.length ? average(pairwise) : null;
    for (const row of rows) row.agreement = agreement;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// recipe-flow
// ---------------------------------------------------------------------------

async function loadFlowRecipes(
  db: Database,
  limit: number,
): Promise<RecipeOut[]> {
  const entityIds = await distinctEntityIds(
    db,
    RECIPE_FLOW_PRIMARY_FEATURE.feature,
    limit,
  );
  const recipes: RecipeOut[] = [];
  for (const id of entityIds) {
    let recipeId: RecipeId;
    try {
      recipeId = parseEntityId("recipe", id);
    } catch {
      continue;
    }
    const recipe = await getRecipeByID(db, recipeId);
    if (recipe) recipes.push(recipe);
    if (recipes.length >= limit) break;
  }
  return recipes;
}

// This sweep calls `chat()` directly, one shot, per model — it measures
// single-pass validity, which is the useful signal for comparing models.
// Production (`recipe-flow.service.ts` via `runStructuredFeature`) gets one
// generic repair pass on top of whatever this reports, so a model's real
// production pass rate is at least as good as the number below.
async function runRecipeFlow(
  db: Database,
  models: SupportedChatModel[],
  limit: number,
): Promise<ModelRow[]> {
  const recipes = await loadFlowRecipes(db, limit);
  const byModel = await runModelSweep({
    models,
    items: recipes,
    feature: RECIPE_FLOW_PRIMARY_FEATURE,
    buildRequest: (recipe) =>
      buildRecipeFlowRequest(
        JSON.stringify(flowPromptInput(recipe), null, 2),
        null,
      ),
  });

  return models.map((model) => {
    const { results, usage, latenciesMs } = byModel.get(model)!;
    const samples = results.map((plan, i) => {
      const assessment = assessRecipeFlowCandidate(recipes[i]!, plan);
      return {
        index: i,
        ok: assessment.ok,
        issues: assessment.ok ? [] : assessment.issues,
      };
    });
    const passed = samples.filter((sample) => sample.ok).length;
    return buildRow({
      feature: "recipe-flow",
      model,
      n: recipes.length,
      passRate: recipes.length ? passed / recipes.length : null,
      agreement: null,
      usage,
      latenciesMs,
      samples,
    });
  });
}

// ---------------------------------------------------------------------------
// usda / merge — both always run on FAST_MODEL internally
// (suggestUsdaFood/suggestIngredientMerge build their own fastAdapter), so
// --models is informational only for these two.
// ---------------------------------------------------------------------------

async function findStoredFdcId(
  db: Database,
  ingredientName: string,
): Promise<number | null> {
  const rows = await db
    .clientForRepository()
    .select({ fdcId: product.fdc_id })
    .from(product)
    .innerJoin(ingredient, eq(product.ingredientId, ingredient.id))
    .where(
      and(
        sql`lower(${ingredient.name}) = lower(${ingredientName})`,
        isNull(ingredient.deletedAt),
        isNull(product.deletedAt),
        isNotNull(product.fdc_id),
      ),
    )
    .limit(1);
  return rows[0]?.fdcId ?? null;
}

async function findExactIngredientId(
  db: Database,
  name: string,
): Promise<string | null> {
  const rows = await db
    .clientForRepository()
    .select({ id: ingredient.id })
    .from(ingredient)
    .where(
      and(
        sql`lower(${ingredient.name}) = lower(${name})`,
        isNull(ingredient.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Shared shape for `usda`/`merge`: suggest an identifier for each fixture
 * name, compare it against a stored baseline, and report one FAST_MODEL row.
 * Neither call exposes a usage hook (each builds its own adapter
 * internally), so `usage` is always null here. */
async function runFixtureAgreementEval(args: {
  feature: string;
  names: string[];
  suggest: (name: string) => Promise<string | number | null>;
  storedLookup: (name: string) => Promise<string | number | null>;
  note: string;
}): Promise<ModelRow[]> {
  const latenciesMs: number[] = [];
  let agree = 0;

  for (const name of args.names) {
    const start = performance.now();
    const suggested = await args.suggest(name);
    latenciesMs.push(performance.now() - start);
    const stored = await args.storedLookup(name);
    if (suggested === stored) agree++;
  }

  return [
    buildRow({
      feature: args.feature,
      model: FAST_MODEL,
      n: args.names.length,
      passRate: args.names.length ? agree / args.names.length : null,
      agreement: null,
      usage: null,
      latenciesMs,
      note: args.note,
    }),
  ];
}

async function runUsda(
  db: Database,
  usdaService: USDAService,
  fixture: Fixture,
  limit: number,
): Promise<ModelRow[]> {
  return runFixtureAgreementEval({
    feature: "usda",
    names: fixture.ingredientNames.slice(0, limit),
    suggest: async (name) =>
      (await suggestUsdaFood(usdaService, db, name)).food?.fdc_id ?? null,
    storedLookup: (name) => findStoredFdcId(db, name),
    note:
      "usda-food-suggest always runs on FAST_MODEL internally; --models is informational. " +
      "passRate = agreement with the fixture name's existing linked-product fdc_id (both null counts as agreement, which dominates for generic placeholder names with no household match).",
  });
}

async function runMerge(
  db: Database,
  fixture: Fixture,
  limit: number,
): Promise<ModelRow[]> {
  return runFixtureAgreementEval({
    feature: "merge",
    names: fixture.ingredientNames.slice(0, limit),
    suggest: async (name) => {
      const syntheticId: IngredientId = parseEntityId(
        "ingredient",
        crypto.randomUUID(),
      );
      const suggestion = await suggestIngredientMerge(db, {
        id: syntheticId,
        name,
      });
      return suggestion.target?.id ?? null;
    },
    storedLookup: (name) => findExactIngredientId(db, name),
    note:
      "ingredient-merge always runs on FAST_MODEL internally; --models is informational. " +
      "The fixture has no curated merge-target ground truth; passRate only checks agreement with a trivial exact-name-match baseline. Read --out for the actual suggestions.",
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(rows: ModelRow[]): void {
  const header = [
    "feature",
    "model",
    "n",
    "passRate",
    "agreement",
    "inputTok",
    "outTok",
    "costUSD",
    "p50ms",
  ];
  const cells = rows.map((row) => [
    row.feature,
    row.model,
    String(row.n),
    row.passRate === null ? "-" : row.passRate.toFixed(2),
    row.agreement === null ? "-" : row.agreement.toFixed(2),
    row.inputTokens === null ? "-" : String(row.inputTokens),
    row.outputTokens === null ? "-" : String(row.outputTokens),
    row.costUsd === null
      ? row.costKnown
        ? "-"
        : "UNKNOWN"
      : `$${row.costUsd.toFixed(4)}`,
    row.p50Ms === null ? "-" : String(Math.round(row.p50Ms)),
  ]);
  const table = [header, ...cells];
  const widths = header.map((_, col) =>
    Math.max(...table.map((line) => line[col]!.length)),
  );
  for (const line of table) {
    console.log(line.map((cell, col) => cell.padEnd(widths[col]!)).join(" | "));
  }
  for (const row of rows) {
    if (row.note)
      console.log(`  note (${row.feature}/${row.model}): ${row.note}`);
    if (row.costUsd === null && !row.costKnown) {
      console.log(`  cost: UNKNOWN (add ${row.model} to the crate catalog)`);
    }
  }
}

function defaultOutPath(feature: string): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", "cubby-ai-eval");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${feature}-${stamp}.json`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.feature || !isFeatureName(args.feature)) {
    console.error(
      `--feature is required and must be one of: ${FEATURES.join(", ")}`,
    );
    printUsage();
    process.exit(1);
  }
  // `process.exit` is typed `never`, so every branch above that doesn't fall
  // through has already returned — args.feature is narrowed to FeatureName.
  const feature = args.feature;

  console.log(
    "READ ONLY — dev DATABASE_URL is production Neon. This script opens a read-only session and never writes.",
  );

  if (!process.env.DATABASE_URL || !process.env.AI_GATEWAY_API_KEY) {
    console.error("DATABASE_URL and AI_GATEWAY_API_KEY must both be set.");
    process.exit(1);
  }

  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 20;

  // SAFETY: `z.enum` needs a statically non-empty tuple; `catalogedChatModels()`
  // filters `supportedChatModel`'s own literal union against a registry
  // constant (`UNCATALOGED_CHAT_MODELS`) that can only ever narrow it, so it
  // is backed by at least one entry for as long as the registry itself is.
  const modelsSchema = z.array(
    z.enum(
      catalogedChatModels() as [SupportedChatModel, ...SupportedChatModel[]],
    ),
  );
  const requestedModels = args.models.length ? args.models : [FAST_MODEL];
  const modelsResult = modelsSchema.safeParse(requestedModels);
  if (!modelsResult.success) {
    console.error(
      `Unknown model in --models. Valid models: ${catalogedChatModels().join(", ")}`,
    );
    process.exit(1);
  }
  const models = modelsResult.data;

  const fixture = loadFixture();
  const { db, pool } = openReadOnlyDb(process.env.DATABASE_URL);

  let rows: ModelRow[];
  try {
    switch (feature) {
      case "category":
        rows = await runCategory(db, models, limit);
        break;
      case "detection":
        rows = await runDetection(db, models, limit);
        break;
      case "recipe-flow":
        rows = await runRecipeFlow(db, models, limit);
        break;
      case "usda":
        rows = await runUsda(db, buildUsdaService(), fixture, limit);
        break;
      case "merge":
        rows = await runMerge(db, fixture, limit);
        break;
    }
  } finally {
    await pool.end();
  }

  printTable(rows);

  const outPath = args.out ?? defaultOutPath(feature);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      { feature, generatedAt: new Date().toISOString(), limit, models, rows },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outPath}`);

  if (rows.some((row) => row.costUsd === null && !row.costKnown)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
