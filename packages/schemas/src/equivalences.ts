import { z } from "zod";
import { amount } from "./codec";
import { ingredientShortcode, recipeShortcode } from "./identifiers";

// One recipe line that expressed a candidate equivalence — the raw line plus the
// two parsed measures it pairs (e.g. "1 bunch kale (about 5 cups)" → a={1 bunch},
// b={5 cup}). Carried so the report can "show its work" per candidate.
export const equivalenceExampleSchema = z.object({
  recipeId: recipeShortcode,
  recipeName: z.string(),
  rawLine: z.string().nullable(),
  a: amount,
  b: amount,
});
export type EquivalenceExample = z.infer<typeof equivalenceExampleSchema>;

// One harvested candidate: an ingredient-scoped equivalence between two units the
// conversion engine can't derive on its own (cross-dimension — e.g. bunch↔cup,
// cup↔g density, can↔oz). Aggregated across every recipe line that expressed it.
// `unitA`/`unitB` are the canonical (sorted) unit pair; `medianRatio` is b per 1 a.
// Read-only for now — a future pass promotes accepted candidates into a live edge.
export const candidateEquivalenceSchema = z.object({
  ingredientId: ingredientShortcode,
  ingredientName: z.string(),
  unitA: z.string(),
  unitB: z.string(),
  occurrences: z.number().int().positive(),
  medianRatio: z.number(),
  ratioSpread: z.object({ min: z.number(), max: z.number() }),
  examples: z.array(equivalenceExampleSchema),
  // Set only on a candidate the ingredient's existing graph ALREADY converts but
  // whose recipe-derived `medianRatio` disagrees with what the graph predicts
  // (same unitB-per-1-unitA units) — a data-quality flag ("your mapping says 240
  // g/cup, recipes say 199"). Absent on novel candidates (no existing mapping).
  existingRatio: z.number().nullish(),
});
export type CandidateEquivalence = z.infer<typeof candidateEquivalenceSchema>;

// The harvest result. `candidates` are the NOVEL equivalences — only those the
// ingredient's existing conversion graph (products + USDA + manual mappings)
// can't already derive; ones it covers are filtered out (they add nothing) and
// tallied in `hiddenCovered` so the count is transparent.
export const equivalenceReportSchema = z.object({
  candidates: z.array(candidateEquivalenceSchema),
  hiddenCovered: z.number().int().nonnegative(),
});
export type EquivalenceReport = z.infer<typeof equivalenceReportSchema>;
