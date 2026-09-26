// AI-assisted ingredient merge suggestions
//
// EPUB imports create near-duplicate ingredients that string matching can't
// catch (scallion≈green onion, cilantro≈coriander, garbanzo≈chickpea).
// `merge-shortlist.ts` assembles a lexical+semantic shortlist; this asks the
// decision tier to pick exactly one target in a single call via
// `runAiSelection` (no agentic search loop). Suggestions only — merge is
// destructive, so the user confirms.

import type { Confidence } from "@cubby/schemas/ai";
import {
  type RunId,
  type IngredientId,
  type IngredientShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";

import { runAiSelection } from "~/server/ai/selection";
import type { Database } from "~/server/db";

import {
  buildMergeShortlist,
  ingredientMergeSpec,
  type MergeShortlistEntry,
  type MergeShortlistPort,
} from "./merge-shortlist";

export interface IngredientMergeAiPort {
  select: typeof runAiSelection<MergeShortlistEntry>;
}

const productionIngredientMergeAiPort: IngredientMergeAiPort = {
  select: runAiSelection,
};

export interface IngredientMergeSuggestion {
  target: {
    id: IngredientId;
    shortcode: IngredientShortcode;
    name: string;
  } | null;
  confidence: Confidence;
  reasoning: string;
}

/**
 * Suggest an existing ingredient to merge a bare/imported one into. Read-only —
 * returns a candidate (or null) for the user to confirm; merges nothing.
 *
 * `shortlistPort` is a test-only seam over {@link buildMergeShortlist}'s own
 * lexical/semantic ports; production callers never pass it.
 */
export async function suggestIngredientMerge(
  db: Database,
  source: { id: IngredientId; name: string },
  runId: RunId,
  ai: IngredientMergeAiPort = productionIngredientMergeAiPort,
  shortlistPort?: MergeShortlistPort,
): Promise<IngredientMergeSuggestion> {
  const shortlist = await buildMergeShortlist(
    db,
    source,
    runId,
    20,
    shortlistPort,
  );
  if (shortlist.length === 0) {
    return {
      target: null,
      confidence: "low",
      reasoning: "No duplicate found.",
    };
  }

  const { selected, confidence, reasoning } = await ai.select(
    ingredientMergeSpec,
    {
      subject: `Is the recipe ingredient "${source.name}" the same purchasable item as an existing ingredient?`,
      candidates: shortlist,
      usage: {
        db,
        runId,
        operation: "suggestIngredientMerge",
        cacheStatus: "none",
        entity: { entityKind: "ingredient", entityId: source.id },
      },
    },
  );

  if (!selected) {
    return {
      target: null,
      confidence,
      reasoning: reasoning || "No duplicate found.",
    };
  }
  return {
    target: {
      id: selected.id,
      shortcode: parseShortcodeFor("ingredient", selected.shortcode),
      name: selected.name,
    },
    confidence,
    reasoning,
  };
}

interface IngredientMergeBatchSuggestion extends IngredientMergeSuggestion {
  source: { id: IngredientId; shortcode: IngredientShortcode; name: string };
}

/** Batch {@link suggestIngredientMerge} for the workbench's "Suggest merges". */
export async function suggestIngredientMergeBatch(
  db: Database,
  sources: { id: IngredientId; shortcode: IngredientShortcode; name: string }[],
  runId: RunId,
): Promise<IngredientMergeBatchSuggestion[]> {
  const capped = sources.slice(0, 20);
  const out: IngredientMergeBatchSuggestion[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((s) => suggestIngredientMerge(db, s, runId)),
    );
    results.forEach((result, j) => {
      const source = batch[j]!;
      if (result.status === "fulfilled") {
        out.push({ source, ...result.value });
      } else {
        console.error(
          `[suggestIngredientMergeBatch] ${source.name} failed:`,
          result.reason,
        );
        out.push({
          source,
          target: null,
          confidence: "low",
          reasoning: "Lookup failed.",
        });
      }
    });
  }
  return out;
}
