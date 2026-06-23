import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { MergeConfirmation } from "~/app/_components/ingredient/merge-confirmation";
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
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithRecompute } from "~/lib/recompute-summary";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { type MergeOption, ReviewCard } from "./review-card";
import { useProposalCache } from "./use-proposal-cache";
import {
  buildPackagePrice,
  buildProductWrite,
  defaultPriceUnit,
  hasUsdaLink,
} from "./workbench-editor-core";

// How many rows ahead of the cursor to pre-compute. Bounds AI spend to roughly
// (rows reviewed + LOOKAHEAD) — we never precompute far past where the user is.
const LOOKAHEAD = 5;

type MergePair = { id: string; name: string };

/**
 * Keyboard-first review queue: walks a worklist one ingredient at a time, each
 * card pre-loaded with its AI USDA (and merge) proposal. The human approves
 * every write — Apply creates/updates a product, or merges/skips/flags. A
 * session-only `processed` set removes a handled row immediately (so skips don't
 * resurface and the next card shows without waiting on the refetch).
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

  // Per-card draft. `unit` persists across cards (the price accelerator): a
  // measure unit you pick sticks; count items snap back to "each".
  const [draftFood, setDraftFood] =
    useState<FoodSummaryWithLinkedProducts | null>(null);
  const [dollars, setDollars] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("lb");
  const [showReplace, setShowReplace] = useState(false);

  const [mergeConfirm, setMergeConfirm] = useState<MergePair[] | null>(null);
  const mergeTargetRef = useRef<string | null>(null);
  const mergeSourceRef = useRef<string | null>(null);
  const appliedIdRef = useRef<string | null>(null);
  // Whether the user manually chose a food for the current card — so a
  // late-arriving proposal doesn't overwrite their pick.
  const pickedRef = useRef(false);

  const markProcessed = (id: string | null) => {
    if (!id) return;
    setProcessed((prev) => new Set(prev).add(id));
  };

  const pickFood = (f: FoodSummaryWithLinkedProducts) => {
    pickedRef.current = true;
    setDraftFood(f);
  };

  // Reset the draft when the current ingredient changes; seed the food from its
  // cached proposal and auto-open manual search when there's no link/proposal.
  // Reads `current`/`cache` through a ref so the effect fires only on id change.
  const currentId = current?.id ?? null;
  const seedRef = useRef({ current, get: cache.get });
  seedRef.current = { current, get: cache.get };
  useEffect(() => {
    if (!currentId) return;
    const { current: cur, get } = seedRef.current;
    if (!cur) return;
    const prop = get(cur.id);
    pickedRef.current = false;
    setDraftFood(prop?.usda.food ?? null);
    setDollars("");
    setQty("1");
    setUnit((prev) => {
      const def = defaultPriceUnit(cur);
      if (def === "each") return "each";
      return prev && prev.toLowerCase() !== "each" ? prev : def;
    });
    setShowReplace(false);
  }, [currentId]);

  // The proposal can land after the card mounts (async precompute). Seed the food
  // from it once it arrives, unless the user already picked one.
  const proposalFood = currentId
    ? (cache.get(currentId)?.usda.food ?? null)
    : null;
  useEffect(() => {
    if (!proposalFood || pickedRef.current) return;
    setDraftFood((prev) => prev ?? proposalFood);
  }, [proposalFood]);

  // Keep the lookahead window pre-computed as the cursor advances. `ensure` is
  // stable, so this fires only when the cursor or worklist moves.
  const ensureProposals = cache.ensure;
  useEffect(() => {
    if (queue.length === 0) return;
    ensureProposals(
      queue.slice(idx, idx + LOOKAHEAD + 1).map((r) => ({
        id: r.id,
        name: r.name,
        wantMerge: r.mergeCandidates.length > 0,
      })),
    );
  }, [idx, queue, ensureProposals]);

  const createProduct = useActionMutation({
    mutationFn: api.product.create.mutationOptions,
    success: (d) => savedWithRecompute(d.sideEffects, `Enriched ${d.name}`),
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: () => markProcessed(appliedIdRef.current),
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const updateProduct = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    success: (d) => savedWithRecompute(d.sideEffects, `Updated ${d.name}`),
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: () => markProcessed(appliedIdRef.current),
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const markNoUsdaMut = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Marked: no USDA entry.",
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: () => markProcessed(appliedIdRef.current),
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const mergeMutation = useActionMutation({
    mutationFn: api.ingredient.merge.mutationOptions,
    success: (d) => savedWithRecompute(d.sideEffects, "Merged"),
    invalidateKeys: [["ingredient"], ["recipe"]],
    onSuccess: () => markProcessed(mergeSourceRef.current),
    error: (err) => `Merge failed: ${getErrorMessage(err)}`,
  });

  const busy =
    createProduct.isPending ||
    updateProduct.isPending ||
    markNoUsdaMut.isPending ||
    mergeMutation.isPending;

  const apply = (withPrice: boolean) => {
    if (!current || busy) return;
    const { eachPrice, mapping } = withPrice
      ? buildPackagePrice(dollars, qty, unit)
      : { eachPrice: null, mapping: null };
    const newMappings = mapping ? [mapping] : [];
    if (draftFood == null && eachPrice == null && newMappings.length === 0) {
      toast.error("Pick a USDA food or enter a price first.");
      return;
    }
    const write = buildProductWrite(current, {
      food: draftFood,
      eachPrice,
      newMappings,
    });
    appliedIdRef.current = current.id;
    if (write.kind === "create") createProduct.mutate(write.input);
    else updateProduct.mutate({ id: write.id, data: write.data });
  };

  const skip = () => {
    if (!current) return;
    markProcessed(current.id);
  };

  const canMarkNoUsda =
    !!current && current.product.length > 0 && !hasUsdaLink(current);
  const markNoUsda = () => {
    const pid = current?.product[0]?.id;
    if (!current || !pid || busy || hasUsdaLink(current)) return;
    appliedIdRef.current = current.id;
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
    apply,
    skip,
    openMerge,
    markNoUsda,
    next: () => setCursor((c) => Math.min(queue.length - 1, c + 1)),
    prev: () => setCursor((c) => Math.max(0, c - 1)),
    toggleReplace: () => setShowReplace((v) => !v),
    mergeOpen: mergeConfirm != null,
    replaceOpen: showReplace,
    exit: onExit,
    closeReplace: () => setShowReplace(false),
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
        if (k.replaceOpen) {
          k.closeReplace();
          return;
        }
        k.exit();
        return;
      }
      if (k.mergeOpen) return;
      // Enter applies — but not while typing in a text field (the USDA search
      // combobox owns Enter; the unit field has its own handler).
      if (e.key === "Enter" && !isText) {
        e.preventDefault();
        k.apply(!e.shiftKey);
        return;
      }
      if (isText) return;
      switch (e.key) {
        case "s":
          e.preventDefault();
          k.skip();
          break;
        case "u":
          e.preventDefault();
          k.toggleReplace();
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
      <div className="space-y-3 rounded-lg border border-dashed p-8 text-center">
        <p className="text-muted-foreground text-sm">
          {reviewedThisSession > 0
            ? `Reviewed ${reviewedThisSession} this session — nothing left in this filter.`
            : "Nothing to review in this filter."}
        </p>
        <Button variant="outline" size="sm" onClick={onExit}>
          Back to browse
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-xs">
        <span>
          {queue.length} left · {reviewedThisSession} reviewed
        </span>
        <span className="flex items-center gap-2">
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
        </span>
      </div>

      {current && (
        <ReviewCard
          key={current.id}
          row={current}
          proposal={cache.get(current.id)}
          proposalPending={cache.running && cache.get(current.id) === undefined}
          food={draftFood}
          onPickFood={pickFood}
          dollars={dollars}
          qty={qty}
          unit={unit}
          onPrice={(patch) => {
            if (patch.dollars !== undefined) setDollars(patch.dollars);
            if (patch.qty !== undefined) setQty(patch.qty);
            if (patch.unit !== undefined) setUnit(patch.unit);
          }}
          showReplace={showReplace}
          onToggleReplace={() => setShowReplace((v) => !v)}
          onApply={apply}
          mergeOptions={mergeOptions}
          onMerge={openMerge}
          canMarkNoUsda={canMarkNoUsda}
          onMarkNoUsda={markNoUsda}
          isPending={busy}
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
    </div>
  );
}
