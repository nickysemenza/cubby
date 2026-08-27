import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { EntityMergeDialog } from "~/app/_components/merge/entity-merge-dialog";
import { useQueuePass } from "~/app/_components/queue-pass/useQueuePass";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Empty, EmptyActions, EmptyDescription } from "~/components/ui/empty";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import type { EnrichmentEditorHandle } from "./enrichment-editor";
import { ingredient } from "./ingredient.functions";
import { type MergeOption, ReviewCard } from "./review-card";
import { useProposalCache } from "./use-proposal-cache";
import { hasUsdaLink } from "./workbench-editor-core";

// How many rows ahead of the cursor to pre-compute. Bounds AI spend to roughly
// (rows reviewed + LOOKAHEAD) — we never precompute far past where the user is.
const LOOKAHEAD = 5;

/**
 * The queue's scope never changes while mounted — entering review IS the scope,
 * and exiting unmounts. A constant key freezes membership once, on the first
 * render that has rows.
 */
const REVIEW_SCOPE = "review";

type MergePair = { id: string; name: string };

/**
 * Keyboard-first review queue: walks a worklist one ingredient at a time. Each
 * card is the shared {@link EnrichmentEditor} (so it shows only the inputs a row
 * needs) wrapped in queue chrome — AI proposal, alternatives, merge list. The
 * human approves every write (Apply saves; or merge/skip/flag). A session-only
 * `processed` set removes a handled row immediately.
 */
export function ReviewQueue({
  rows,
  onExit,
}: {
  rows: EnrichmentRow[];
  onExit: () => void;
}) {
  const cache = useProposalCache();

  // Membership is frozen for the life of this review session and the cursor is
  // stable, so handling a row no longer removes it and renumbers everything
  // after it. The component unmounts on exit, so re-entering review re-freezes
  // against the browse filter as it stands then.
  const stopsById = useMemo(
    () => new Map<string, EnrichmentRow>(rows.map((r) => [r.id, r])),
    [rows],
  );
  const candidateIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const pass = useQueuePass<EnrichmentRow>({
    scopeKey: REVIEW_SCOPE,
    candidateIds,
    stopsById,
  });
  const { counts, current, currentIndex: idx } = pass;
  const queue = pass.stops;

  const editorRef = useRef<EnrichmentEditorHandle>(null);
  const [mergeConfirm, setMergeConfirm] = useState<MergePair[] | null>(null);
  const mergeSourceRef = useRef<string | null>(null);
  const flaggedIdRef = useRef<string | null>(null);

  const markProcessed = (id: string | null) => {
    if (!id) return;
    pass.settle(id, "completed");
  };

  // Keep the lookahead window pre-computed as the cursor advances. Linked rows
  // with no merge candidate have nothing to fetch, so they're skipped (no AI).
  const ensureProposals = cache.ensure;
  useEffect(() => {
    if (queue.length === 0) return;
    ensureProposals(
      queue
        .slice(idx)
        .filter((r) => !pass.settled.has(r.id))
        .slice(0, LOOKAHEAD + 1)
        .map((r) => ({
          id: r.id,
          name: r.name,
          wantUsda: !hasUsdaLink(r),
          wantMerge: r.mergeCandidates.length > 0,
        }))
        .filter((it) => it.wantUsda || it.wantMerge),
    );
  }, [idx, queue, ensureProposals, pass.settled]);

  const markNoUsdaMut = useActionMutation({
    entity: "product",
    operation: "update",
    intent: "full",
    mutationFn: entityMutationOptionsFactory("product", "update"),
    success: "Marked: no USDA entry.",
    onSuccess: () => markProcessed(flaggedIdRef.current),
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const mergeMutation = useActionMutation({
    mutationFn: ingredient.merge.mutationOptions,
    success: (d) => savedWithBackgroundWork(d.sideEffects, "Merged"),
    onSuccess: () => markProcessed(mergeSourceRef.current),
    error: (err) => `Merge failed: ${getErrorMessage(err)}`,
  });

  const busy = markNoUsdaMut.isPending || mergeMutation.isPending;

  // A skip defers rather than discards: the row keeps its place and the cursor
  // wraps back to it once everything else is settled.
  const skip = () => current && pass.settle(current.id, "skipped");

  const canMarkNoUsda =
    !!current && current.product.length > 0 && !hasUsdaLink(current);
  const markNoUsda = () => {
    const pid = current?.product[0]?.id;
    if (!current || !pid || busy || hasUsdaLink(current)) return;
    flaggedIdRef.current = current.id;
    markNoUsdaMut.mutate({ id: pid, data: { usdaUnavailable: true } });
  };

  // All merge targets on offer: the AI pick first (if any), then the trigram
  // candidates (deduped against the AI one). Each is the user's to confirm.
  const mergeOptions = useMemo<MergeOption[]>(() => {
    if (!current) return [];
    const out: MergeOption[] = [];
    const seen = new Set<string>();
    const ai = cache.get(current.id)?.merge?.target;
    if (ai) {
      out.push({
        id: ai.id,
        name: ai.name,
        source: "ai",
      });
      seen.add(ai.id);
    }
    for (const c of current.mergeCandidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({
        id: c.id,
        name: c.name,
        source: "fuzzy",
        similarity: c.similarity,
      });
    }
    return out;
  }, [current, cache]);

  const openMerge = (option?: MergeOption) => {
    if (!current || busy) return;
    const target = option ?? mergeOptions[0];
    if (!target) {
      toast.message("No merge candidate for this ingredient.");
      return;
    }
    mergeSourceRef.current = current.id;
    // Candidate first → the default keeper (likelier to already have a product).
    setMergeConfirm([
      { id: target.id, name: target.name },
      { id: current.id, name: current.name },
    ]);
  };
  const confirmMerge = (keepId: string, aliasIds: string[]) => {
    mergeMutation.mutate({ keepId, mergeIds: aliasIds });
    setMergeConfirm(null);
  };

  // Keyboard model. Bound once; reads the latest handlers/flags through a ref so
  // the listener isn't re-attached on every keystroke.
  const kbd = {
    apply: () => editorRef.current?.save(),
    skip,
    openMerge,
    markNoUsda,
    next: () => pass.jumpTo(Math.min(queue.length - 1, idx + 1)),
    prev: () => pass.jumpTo(Math.max(0, idx - 1)),
    mergeOpen: mergeConfirm != null,
    exit: onExit,
  };
  const kbdRef = useRef(kbd);
  kbdRef.current = kbd;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = kbdRef.current;
      const t = e.target as HTMLElement | null;
      const isText =
        !!t &&
        (t.tagName === "TEXTAREA" ||
          (t.tagName === "INPUT" &&
            (t as HTMLInputElement).type !== "number") ||
          t.isContentEditable);

      if (e.key === "Escape") {
        if (k.mergeOpen) return; // dialog owns Escape
        k.exit();
        return;
      }
      if (k.mergeOpen) return;
      // Enter applies — but not while typing in a text field (the USDA search
      // combobox owns Enter).
      if (e.key === "Enter" && !isText) {
        e.preventDefault();
        k.apply();
        return;
      }
      if (isText) return;
      switch (e.key) {
        case "s":
          e.preventDefault();
          k.skip();
          break;
        case "m":
          e.preventDefault();
          k.openMerge();
          break;
        case "n":
          e.preventDefault();
          k.markNoUsda();
          break;
        case "j":
        case "ArrowDown":
          e.preventDefault();
          k.next();
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          k.prev();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reviewedThisSession = counts.completed;

  if (queue.length === 0) {
    return (
      <Empty>
        <EmptyDescription>Nothing to review in this filter.</EmptyDescription>
        <EmptyActions>
          <Button variant="outline" size="sm" onClick={onExit}>
            Back to browse
          </Button>
        </EmptyActions>
      </Empty>
    );
  }

  if (pass.complete) {
    return (
      <Empty>
        <EmptyDescription>
          Reviewed {reviewedThisSession} this session
          {counts.skipped > 0 && `, skipped ${counts.skipped}`}.
        </EmptyDescription>
        <EmptyActions>
          {counts.skipped > 0 && (
            <Button variant="outline" size="sm" onClick={pass.revisitSkipped}>
              Revisit skipped
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onExit}>
            Back to browse
          </Button>
        </EmptyActions>
      </Empty>
    );
  }

  return (
    // Centered, bounded column — a focused single-card review shouldn't span full width.
    <Stack gap="sm" className="mx-auto w-full max-w-4xl">
      <Row
        align="center"
        justify="between"
        wrap
        gap="sm"
        className="text-muted-foreground text-xs"
      >
        <span>
          {counts.outstanding} left · {reviewedThisSession} reviewed
          {counts.skipped > 0 && ` · ${counts.skipped} skipped`}
        </span>
        <Row as="span" align="center" gap="sm">
          <span>
            precomputed {cache.stats.ready}/{cache.stats.requested}
            {cache.running && " · working…"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => cache.setPaused(!cache.paused)}
          >
            {cache.paused ? "Resume AI" : "Pause AI"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={onExit}
          >
            Browse
          </Button>
        </Row>
      </Row>

      {current && (
        <ReviewCard
          key={current.id}
          row={current}
          proposal={cache.get(current.id)}
          proposalPending={cache.running && cache.get(current.id) === undefined}
          editorRef={editorRef}
          onSaved={() => markProcessed(current.id)}
          mergeOptions={mergeOptions}
          onMerge={openMerge}
          canMarkNoUsda={canMarkNoUsda}
          onMarkNoUsda={markNoUsda}
          position={{ index: idx, total: counts.total }}
        />
      )}

      <EntityMergeDialog
        entity="ingredient"
        rows={mergeConfirm ?? []}
        open={mergeConfirm != null}
        onOpenChange={(o) => {
          if (!o) setMergeConfirm(null);
        }}
        onConfirm={confirmMerge}
        isPending={mergeMutation.isPending}
      />
    </Stack>
  );
}
