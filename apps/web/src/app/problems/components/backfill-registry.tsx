import { countLabel } from "~/lib/pluralize";
import type { BackfillButtonProps } from "./problem-backfill-action";

/**
 * Identity helper that pins each entry's result type explicitly, so its
 * `toastResult` is type-checked against the streamed mutation's real summary
 * shape (and the `run` call must yield that shape).
 */
const def = <TResult,>(config: BackfillButtonProps<TResult>) => config;

/**
 * The batch backfills that appear on BOTH surfaces: a section's "fix all" header
 * button on the Problems page, and a force-run row in Settings → Maintenance.
 * The mutation, invalidation, toast wording, and button labels live here once,
 * so the two surfaces can't drift; each surface keeps only its own display copy
 * (Problems: the section title/description; Maintenance: the row label + count).
 *
 * Recompute is intentionally absent — totals now recompute eagerly on every
 * write, so the only recompute surface left is Maintenance's force-rebuild-all
 * (`recipe.recomputeAll`, with a dry run), declared at its own call site.
 */
export const BACKFILL = {
  reparse: def<{ updated: number; recipesAffected: number }>({
    run: (client) => client.problems.reparseStale.mutate(),
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
  fetchUpcImages: def<{
    found: number;
    imported: number;
    failed: number;
    skipped: number;
  }>({
    run: (client) => client.product.backfillUPCImages.mutate(),
    invalidateKeys: (api) => [api.product.list.queryKey()],
    idleLabel: "Fetch images",
    pendingLabel: "Fetching…",
    toastResult: (r) => ({
      tone: r.imported > 0 ? "success" : "info",
      message: `Imported ${countLabel(r.imported, "image")} · ${r.found} found, ${r.skipped} skipped.`,
    }),
  }),
  analyzeDescriptions: def<{ analyzed: number; total: number }>({
    run: (client) => client.ai.backfillLocationDescriptions.mutate(),
    invalidateKeys: (api) => [api.location.list.queryKey()],
    idleLabel: "Analyze all",
    pendingLabel: "Analyzing…",
    toastResult: (r) => ({
      tone: r.analyzed > 0 ? "success" : "info",
      message: `Analyzed ${r.analyzed} of ${countLabel(r.total, "location")}.`,
    }),
  }),
};
