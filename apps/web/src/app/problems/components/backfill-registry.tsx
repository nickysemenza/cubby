import { countLabel } from "~/lib/pluralize";
import type { BackfillButtonProps } from "./problem-backfill-action";
import type { MutationOptionsFn } from "./use-problem-backfill";

/**
 * Identity helper that pins `TFn` from `selectMutation`, so each entry's
 * `toastResult` is type-checked against that mutation's real result shape.
 * Keep every entry an object literal — the tsgo inference over `TFn` collapses
 * to `unknown` if an entry is widened or annotated.
 */
const def = <TFn extends MutationOptionsFn>(config: BackfillButtonProps<TFn>) =>
  config;

/**
 * The batch backfills that appear on BOTH surfaces: a section's "fix all" header
 * button on the Problems page, and a force-run row in Settings → Maintenance.
 * The mutation, invalidation, toast wording, and button labels live here once,
 * so the two surfaces can't drift; each surface keeps only its own display copy
 * (Problems: the section title/description; Maintenance: the row label + count).
 *
 * Recompute is intentionally absent — Problems recomputes stale-only
 * (`recipe.recomputeStale`, with `{ limit: 500 }`) while Maintenance
 * force-recomputes all (`recipe.recomputeAll`, with a dry run). Different
 * mutations and intent, so each stays declared at its own call site.
 */
export const BACKFILL = {
  reparse: def({
    selectMutation: (api) => api.problems.reparseStale.mutationOptions,
    invalidateKeys: (api) => [api.recipe.list.queryKey()],
    idleLabel: "Re-parse all",
    pendingLabel: "Re-parsing…",
    toastResult: (r) => ({
      tone: r.updated > 0 ? "success" : "info",
      message:
        r.updated > 0
          ? `Re-parsed ${countLabel(r.updated, "line")} across ${countLabel(r.recipesAffected, "recipe")}.`
          : "Nothing to re-parse.",
    }),
  }),
  fetchUpcImages: def({
    selectMutation: (api) => api.product.backfillUPCImages.mutationOptions,
    invalidateKeys: (api) => [api.product.list.queryKey()],
    idleLabel: "Fetch images",
    pendingLabel: "Fetching…",
    toastResult: (r) => ({
      tone: r.imported > 0 ? "success" : "info",
      message: `Imported ${countLabel(r.imported, "image")} · ${r.found} found, ${r.skipped} skipped.`,
    }),
  }),
  analyzeDescriptions: def({
    selectMutation: (api) =>
      api.ai.backfillLocationDescriptions.mutationOptions,
    invalidateKeys: (api) => [api.location.list.queryKey()],
    idleLabel: "Analyze all",
    pendingLabel: "Analyzing…",
    toastResult: (r) => ({
      tone: r.analyzed > 0 ? "success" : "info",
      message: `Analyzed ${r.analyzed} of ${countLabel(r.total, "location")}.`,
    }),
  }),
};
