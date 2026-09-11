// AI-assisted USDA food matching
//
// Cookbook ingredients ("AP flour", "orange juice") rarely match the USDA
// description verbatim, and raw name-search is dominated by branded products.
// `usda-shortlist.ts` assembles a shortlist from a handful of WASM-derived
// query variants; this asks the fast tier to pick exactly one candidate in a
// single structured call via `runAiSelection` (no agentic search loop).

import type { Confidence } from "@cubby/schemas/ai";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";

import { getErrorMessage } from "~/lib/error-utils";
import { runAiSelection } from "~/server/ai/selection";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import type { Database } from "~/server/db";
import { getIngredientByID } from "~/server/repo/ingredient";

import {
  buildUsdaShortlist,
  usdaFoodSpec,
  type UsdaLookupPort,
  type UsdaShortlistEntry,
} from "./usda-shortlist";

export type { UsdaLookupPort } from "./usda-shortlist";

export interface UsdaMatchAiPort {
  select: typeof runAiSelection<UsdaShortlistEntry>;
}

const productionUsdaMatchAiPort: UsdaMatchAiPort = { select: runAiSelection };

export interface UsdaFoodSuggestion {
  food: FoodSummaryWithLinkedProducts | null;
  confidence: Confidence;
  reasoning: string;
}

/**
 * Shortlist USDA foods ourselves ({@link buildUsdaShortlist}), then ask the
 * fast tier to pick exactly one in a single structured call. Returns the
 * full chosen food (with inferred unit mappings) so callers can link it
 * without a re-fetch, or null when nothing fits.
 */
export async function suggestUsdaFood(
  usdaService: UsdaLookupPort,
  db: Database,
  ingredientName: string,
  opts: { ingredientId?: IngredientId } = {},
  ai: UsdaMatchAiPort = productionUsdaMatchAiPort,
): Promise<UsdaFoodSuggestion> {
  const shortlist = await buildUsdaShortlist(usdaService, ingredientName);
  if (shortlist.length === 0) {
    return {
      food: null,
      confidence: "low",
      reasoning: "No USDA candidates found.",
    };
  }

  const { selected, confidence, reasoning } = await ai.select(usdaFoodSpec, {
    subject: `Find the best USDA food for the recipe ingredient: "${ingredientName}".`,
    candidates: shortlist,
    usage: {
      db,
      operation: "suggestUsdaFood",
      cacheStatus: "none",
      entity: opts.ingredientId
        ? { entityType: "ingredient", entityId: opts.ingredientId }
        : null,
    },
  });

  if (!selected) {
    return {
      food: null,
      confidence,
      reasoning: reasoning || "No suitable match found.",
    };
  }
  return { food: selected.food, confidence, reasoning };
}

/** One batch entry: the input name plus its suggestion (food null = no match). */
interface UsdaFoodBatchSuggestion extends UsdaFoodSuggestion {
  name: string;
}

export interface UsdaMatchPorts<TDatabase> {
  dispatchRetries: (
    database: TDatabase,
    input: Parameters<typeof dispatchBackgroundJobs>[1],
  ) => Promise<void>;
  getIngredient: (
    database: TDatabase,
    id: IngredientId,
  ) => Promise<{ name: string }>;
  suggest: (
    service: UsdaLookupPort,
    database: TDatabase,
    name: string,
    options?: { ingredientId?: IngredientId },
  ) => Promise<UsdaFoodSuggestion>;
  servicesForRetry: (
    database: TDatabase,
  ) => Promise<{ usdaService: UsdaLookupPort }>;
}

const productionUsdaMatchPorts: UsdaMatchPorts<Database> = {
  dispatchRetries: async (database, input) => {
    await dispatchBackgroundJobs(database, input);
  },
  getIngredient: getIngredientByID,
  suggest: suggestUsdaFood,
  servicesForRetry: async (database) => {
    const { buildCrudServices } = await import("~/server/request-context");
    return buildCrudServices(database);
  },
};

/**
 * Batch {@link suggestUsdaFood} for the enrichment workbench's "Suggest USDA for
 * selected" action. Read-only — returns one suggestion per name for the user to
 * review and commit; it never links anything. Each name is its own shortlist +
 * select call, so concurrency is bounded and the batch is capped.
 *
 * A per-item `Promise.allSettled` rejection is an infrastructure failure
 * (network blip, AI gateway hiccup) — indistinguishable, to this function's
 * caller, from "the model genuinely found no match". The degraded
 * `{food: null, reasoning: "Lookup failed."}` entry still returns immediately
 * so the batch doesn't stall, but the failure ALSO dispatches a
 * `usda-match.retry` background job for that ingredient, so the queue's own
 * backoff/attempts absorb a transient blip instead of the human having to
 * notice a "Lookup failed" row and manually retry (Tenet 3: this is exactly
 * the unattended-retry work the queue exists for, unlike the interactive
 * search loop above it).
 */
async function suggestUsdaFoodBatchWithPorts<TDatabase>(
  usdaService: UsdaLookupPort,
  db: TDatabase,
  ingredients: { id: IngredientId; name: string }[],
  ports: UsdaMatchPorts<TDatabase>,
): Promise<UsdaFoodBatchSuggestion[]> {
  const capped = ingredients.slice(0, 20);
  const out: UsdaFoodBatchSuggestion[] = [];
  const failed: { id: IngredientId; name: string }[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((item) => ports.suggest(usdaService, db, item.name)),
    );
    for (const [j, result] of results.entries()) {
      const item = batch[j]!;
      if (result.status === "fulfilled") {
        out.push({ name: item.name, ...result.value });
      } else {
        console.error(
          `[suggestUsdaFoodBatch] ${item.name} failed:`,
          result.reason,
        );
        out.push({
          name: item.name,
          food: null,
          confidence: "low",
          reasoning: "Lookup failed.",
        });
        failed.push(item);
      }
    }
  }

  // Retry scheduling is deliberately BEST-EFFORT and happens after the read
  // loop, never inside it. Two reasons, both learned the hard way:
  //
  //  1. `out` already holds every degraded and matched entry by this point. An
  //     unguarded `await dispatchBackgroundJobs(...)` inside the loop meant a
  //     rejecting dispatch (DB insert, queue.sendBatch) threw straight out of
  //     this function and discarded ALL of them — turning "some matched, some
  //     degraded" into a total failure, the exact opposite of the degrade
  //     path's purpose.
  //  2. With no queue bound (dev, test, self-host), `dispatchBackgroundJobs`
  //     falls through to `processInlineJobs`, which loops
  //     `while (outcome === "retry")` with no backoff and no bound. Dispatching
  //     per failed item ran a full extra agent lookup, synchronously, inside
  //     the user's request — once per failure, precisely during the upstream
  //     outage that caused the failures. One dispatch of N jobs replaces N
  //     dispatches, and the try/catch keeps a queue problem from ever reaching
  //     the caller.
  if (failed.length > 0) {
    try {
      await ports.dispatchRetries(db, {
        kind: "usda-match.retry",
        source: "mutation",
        jobs: failed.map((item) => ({
          kind: "usda-match.retry" as const,
          dedupeKey: `usda-match.retry:${item.id}`,
          payload: { ingredientId: item.id },
        })),
      });
    } catch (error) {
      console.error(
        "[suggestUsdaFoodBatch] could not schedule retries:",
        getErrorMessage(error),
      );
    }
  }

  return out;
}

/**
 * Background-job retry for a `suggestUsdaFoodBatch` item that failed at the
 * infra level (see that function's doc comment). Re-fetches the ingredient's
 * current name — the dispatching batch may be stale by the time this job
 * runs — and re-attempts the single-item lookup directly, bypassing
 * `suggestUsdaFoodBatch`'s swallow-and-degrade catch so a real failure here
 * throws and lets `processBackgroundJob`'s retry/backoff take over.
 *
 * Deliberately read-only, same as `suggestUsdaFood` itself: it does not set
 * `product.usdaUnavailable` (that column is a human's "I checked, no USDA
 * food exists" assertion — conflating it with an automated retry, successful
 * or not, would misrepresent what a person decided) and does not link a
 * product to this food. Tenet 2's `ingredient → product → fdc_id` commit
 * stays a deliberate, reviewed write in the interactive workbench; a
 * successful retry's only visible effect is the job finishing "succeeded"
 * rather than "failed", confirming the transient failure has cleared.
 */
async function retryUsdaMatchWithPorts<TDatabase>(
  db: TDatabase,
  ingredientId: IngredientId,
  ports: UsdaMatchPorts<TDatabase>,
): Promise<void> {
  const { usdaService } = await ports.servicesForRetry(db);
  const ingredient = await ports.getIngredient(db, ingredientId);
  await ports.suggest(usdaService, db, ingredient.name, { ingredientId });
}

export function createUsdaMatchService<TDatabase>(
  ports: UsdaMatchPorts<TDatabase>,
) {
  return {
    retryUsdaMatch: (database: TDatabase, ingredientId: IngredientId) =>
      retryUsdaMatchWithPorts(database, ingredientId, ports),
    suggestUsdaFoodBatch: (
      service: UsdaLookupPort,
      database: TDatabase,
      ingredients: { id: IngredientId; name: string }[],
    ) => suggestUsdaFoodBatchWithPorts(service, database, ingredients, ports),
  };
}

const productionUsdaMatch = createUsdaMatchService(productionUsdaMatchPorts);
export const retryUsdaMatch = productionUsdaMatch.retryUsdaMatch;
export const suggestUsdaFoodBatch = productionUsdaMatch.suggestUsdaFoodBatch;
