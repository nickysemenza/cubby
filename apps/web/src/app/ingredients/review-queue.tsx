import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { MergeConfirmation } from "~/app/_components/ingredient/merge-confirmation";
import { Row, Stack } from "~/components/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Empty, EmptyActions, EmptyDescription } from "~/components/ui/empty";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithRecompute } from "~/lib/recompute-summary";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import type { EnrichmentEditorHandle } from "./enrichment-editor";
import { type MergeOption, ReviewCard } from "./review-card";
import { useProposalCache } from "./use-proposal-cache";
import { hasUsdaLink } from "./workbench-editor-core";

// How many rows ahead of the cursor to pre-compute. Bounds AI spend to roughly
// (rows reviewed + LOOKAHEAD) — we never precompute far past where the user is.
const LOOKAHEAD = 5;

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
  const api = useTRPC();
  const cache = useProposalCache();

  const [processed, setProcessed] = useState<Set<string>>(() => new Set());
  const queue = useMemo(
    () => rows.filter((r) => !processed.has(r.id)),
    [rows, processed],
  );
  const [cursor, setCursor] = useState(0);
  const idx = Math.min(cursor, Math.max(0, queue.length - 1));
  const current = queue[idx] ?? null;

  const editorRef = useRef<EnrichmentEditorHandle>(null);
  const [mergeConfirm, setMergeConfirm] = useState<MergePair[] | null>(null);
  const mergeTargetRef = useRef<string | null>(null);
  const mergeSourceRef = useRef<string | null>(null);
  const flaggedIdRef = useRef<string | null>(null);

  const markProcessed = (id: string | null) => {
    if (!id) return;
    setProcessed((prev) => new Set(prev).add(id));
  };

  // Keep the lookahead window pre-computed as the cursor advances. Linked rows
  // with no merge candidate have nothing to fetch, so they're skipped (no AI).
  const ensureProposals = cache.ensure;
  useEffect(() => {
    if (queue.length === 0) return;
    ensureProposals(
      queue
        .slice(idx, idx + LOOKAHEAD + 1)
        .map((r) => ({
          id: r.id,
          name: r.name,
          wantUsda: !hasUsdaLink(r),
          wantMerge: r.mergeCandidates.length > 0,
        }))
        .filter((it) => it.wantUsda || it.wantMerge),
    );
  }, [idx, queue, ensureProposals]);

  const markNoUsdaMut = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Marked: no USDA entry.",
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: () => markProcessed(flaggedIdRef.current),
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const mergeMutation = useActionMutation({
    mutationFn: api.ingredient.merge.mutationOptions,
    success: (d) => savedWithRecompute(d.sideEffects, "Merged"),
    invalidateKeys: [["ingredient"], ["recipe"]],
    onSuccess: () => markProcessed(mergeSourceRef.current),
    error: (err) => `Merge failed: ${getErrorMessage(err)}`,
  });

  const busy = markNoUsdaMut.isPending || mergeMutation.isPending;

  const skip = () => current && markProcessed(current.id);

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
      out.push({ id: ai.id, name: ai.name, source: "ai" });
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
  const confirmMerge = () => {
    const pair = mergeConfirm;
    if (!pair || pair.length < 2) return;
    const target =
      pair.find((i) => i.id === mergeTargetRef.current) ?? pair[0]!;
    const alias = pair.find((i) => i.id !== target.id);
    if (!alias) return;
    mergeMutation.mutate({ target: target.id, aliases: [alias.id] });
    setMergeConfirm(null);
  };

  // Keyboard model. Bound once; reads the latest handlers/flags through a ref so
  // the listener isn't re-attached on every keystroke.
  const kbd = {
    apply: () => editorRef.current?.save(),
    skip,
    openMerge,
    markNoUsda,
    next: () => setCursor((c) => Math.min(queue.length - 1, c + 1)),
    prev: () => setCursor((c) => Math.max(0, c - 1)),
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

  const reviewedThisSession = processed.size;

  if (queue.length === 0) {
    return (
      <Empty>
        <EmptyDescription>
          {reviewedThisSession > 0
            ? `Reviewed ${reviewedThisSession} this session — nothing left in this filter.`
            : "Nothing to review in this filter."}
        </EmptyDescription>
        <EmptyActions>
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
          {queue.length} left · {reviewedThisSession} reviewed
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
          position={{ index: idx, total: queue.length }}
        />
      )}

      <AlertDialog
        open={mergeConfirm != null}
        onOpenChange={(o) => {
          if (!o) setMergeConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge ingredients?</AlertDialogTitle>
          </AlertDialogHeader>
          {mergeConfirm && (
            <MergeConfirmation
              ingredients={mergeConfirm}
              targetRef={mergeTargetRef}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={mergeMutation.isPending}
              onClick={confirmMerge}
            >
              Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Stack>
  );
}
