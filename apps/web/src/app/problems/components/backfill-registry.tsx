import { Link } from "@tanstack/react-router";
import pluralize from "pluralize";
import { backfillProductUpcImagesStream } from "~/app/products/product.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { backfillLocationDescriptionsStream } from "~/lib/ai.functions";
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
 * Recompute and the two WASM parse-sweeps (re-parse lines, prune unused aliases)
 * are intentionally absent — they're Maintenance-only dry-run/fix-all actions
 * (no Problems-page section), declared at their own call site in settings.tsx.
 */
export const BACKFILL = {
  fetchUpcImages: def<{
    found: number;
    imported: number;
    failed: number;
    skipped: number;
  }>({
    run: backfillProductUpcImagesStream,
    invalidateTags: ripple.product,
    // Runs entirely inside the held-open stream (no durable queue), so warn while
    // it runs (see BackfillButton `foreground`).
    foreground: true,
    idleLabel: "Fetch images",
    pendingLabel: "Fetching…",
    toastResult: (r) => ({
      tone: r.imported > 0 ? "success" : "info",
      message: `Imported ${pluralize("image", r.imported, true)} · ${r.found} found, ${r.skipped} skipped.`,
    }),
  }),
  analyzeDescriptions: def<{
    enqueued: number;
    total: number;
    batchId: string;
  }>({
    run: backfillLocationDescriptionsStream,
    invalidateTags: ripple.location,
    idleLabel: "Analyze all",
    pendingLabel: "Enqueuing…",
    // Durable: the work runs on the background-jobs queue, so link the toast there.
    toastResult: (r) => ({
      tone: r.enqueued > 0 ? "success" : "info",
      message:
        r.enqueued > 0 ? (
          <span>
            Enqueued {r.enqueued} of {pluralize("location", r.total, true)} for
            analysis.{" "}
            <Link
              to="/background-jobs"
              search={{ batchId: r.batchId }}
              className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
            >
              View progress
            </Link>
          </span>
        ) : (
          "No locations need analysis."
        ),
    }),
  }),
};
