import { location } from "~/app/locations/location.functions";
/**
 * The state behind a location sweep: a serialized scan queue and the strays it
 * turns up.
 *
 * Two properties do the real work here.
 *
 * Serialization. The camera keeps firing while a lookup is in flight, and the
 * decoder's same-code debounce only compares the last raw value — two
 * encodings of one product (UPC-A and EAN-13 of the same item) sail straight
 * past it. Running those concurrently would let both observe "not stocked
 * here". The server converges on a single row anyway, but doing the work twice
 * is wasted, so scans drain one at a time in the order they were read.
 *
 * Location scoping. Everything is keyed to the location being swept, and a
 * change of location resets it. A stray queued against one shelf must never
 * commit against the next one. `reset()` empties the queue but cannot abort a
 * lookup already in flight, so every scan also carries the anchor it was READ
 * at and a late result against a stale anchor is discarded outright.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type {
  ResolveScanStraysOut,
  ScanAtLocationOut,
  ScanStrayOut,
} from "@cubby/schemas/scan";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ScanFeedbackEntry } from "~/app/_components/inventory/persistent-scanner";
import { inventory } from "~/app/inventory/inventory.functions";
import { entityDetailQueryOptions } from "~/entities/entity-detail.functions";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { resolveLocationScan, resolveProductScan } from "~/lib/scan-code";
import type { SweepFollowUp } from "./SweepProductFollowUp";
import type { QueuedBin, SweepBinVerdict } from "./sweep-bin-plan";
import { canGoMissing, planSweptBin } from "./sweep-bin-plan";

/** How many recently-scanned chips the viewfinder shows (newest first). */
const RECENT_SCAN_LIMIT = 5;

/**
 * `Product 012345678905` — the name the UPC cascade falls back to when neither
 * USDA nor the UPC worker recognises a code. A scan that lands one of these is
 * worth a rename while the object is still in hand.
 */
const PLACEHOLDER_PRODUCT_NAME = /^Product \d+$/;

/**
 * One product that turned up elsewhere during the sweep.
 *
 * Keyed by product: scanning two copies of the same book should not queue the
 * same decision twice.
 */
export interface QueuedStray {
  productId: string;
  productName: string;
  rows: ScanStrayOut[];
}

export interface SweepTally {
  added: number;
  /** Seen where it was expected — items and bins alike. */
  confirmed: number;
}

/**
 * What one commit actually did.
 *
 * The two halves are reported apart on purpose: bins land through a different
 * mutation and go first, so `failed: "products"` means the reparents ALREADY
 * LANDED and only the item half is worth retrying. Collapsing this into one
 * boolean reports a half-applied commit as a total failure.
 */
export interface SweepCommitOutcome {
  bins: { moved: number };
  products: { moved: number; skipped: ResolveScanStraysOut["skipped"] };
  /** Item rows left alone because the bin holding them was adopted. */
  keptInAdoptedBin: number;
  failed: "bins" | "products" | null;
}

/**
 * A direct child that could have been scanned this pass and was not.
 *
 * "Could have been" is doing real work: see `canGoMissing`. A drawer bolted
 * into a tool cart is scannable but cannot leave, so it is unscanned, never
 * absent.
 */
export interface MissingBin {
  id: QueuedBin["id"];
  name: string;
  type: QueuedBin["type"];
}

/** A scan, plus the location it was read at. */
interface SweepJob {
  key: string;
  raw: string;
  anchor: LocationShortcode;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "2 items and 1 bin" — the two halves of one commit, read as one sentence. */
function countLabel(items: number, bins: number): string {
  return [
    items > 0 ? plural(items, "item") : null,
    bins > 0 ? plural(bins, "bin") : null,
  ]
    .filter(Boolean)
    .join(" and ");
}

function commitSummary(outcome: SweepCommitOutcome): string {
  // Branch on the structured reason rather than a count: "already moved" and
  // "already here" are different facts, and reporting one as the other is how
  // a caller learns to distrust the number.
  const goneElsewhere = outcome.products.skipped.filter(
    (row) => row.reason === "already-moved",
  ).length;
  const alreadyHere = outcome.products.skipped.length - goneElsewhere;
  const notes = [
    goneElsewhere > 0 ? `${goneElsewhere} had already moved` : null,
    alreadyHere > 0 ? `${alreadyHere} were already here` : null,
    outcome.keptInAdoptedBin > 0
      ? `${outcome.keptInAdoptedBin} stayed in their bin`
      : null,
  ].filter(Boolean);

  const moved = countLabel(outcome.products.moved, outcome.bins.moved);
  const head = moved ? `Moved ${moved} in` : "Nothing moved";
  return notes.length > 0 ? `${head} · ${notes.join(" · ")}.` : `${head}.`;
}

export function useLocationSweep({
  locationId,
  onSettled,
}: {
  locationId: LocationShortcode;
  /** Fired after any write, so the caller can invalidate its own queries. */
  onSettled: (result?: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const [recentScans, setRecentScans] = useState<ScanFeedbackEntry[]>([]);
  const [strays, setStrays] = useState<QueuedStray[]>([]);
  const [bins, setBins] = useState<QueuedBin[]>([]);
  // Bins accounted for this pass — confirmed where they sit, or queued to be
  // brought in. Either way they are not missing.
  const [seenBins, setSeenBins] = useState<ReadonlySet<string>>(new Set());
  // `null` until asked. Absence is never inferred from a sweep on its own: a
  // pass can legitimately stop halfway, so only an explicit "I got everything"
  // closes the world — and only over bins.
  const [missing, setMissing] = useState<MissingBin[] | null>(null);
  const [checkingMissing, setCheckingMissing] = useState(false);
  const [tally, setTally] = useState<SweepTally>({ added: 0, confirmed: 0 });
  const [pending, setPending] = useState(0);
  // Curation is QUEUED, never interrupting. The follow-up is a modal sheet, so
  // opening it per scan would put sixty modals in front of a sixty-book sweep
  // and cover the stray review besides. It waits until you ask for it.
  const [curationQueue, setCurationQueue] = useState<SweepFollowUp[]>([]);
  const [activeCuration, setActiveCuration] = useState<SweepFollowUp | null>(
    null,
  );

  const scanMutation = useMutation(inventory.scanAtLocation.mutationOptions());
  const commitMutation = useMutation(
    inventory.resolveScanStrays.mutationOptions(),
  );
  const reparentMutation = useMutation(
    location.bulkUpdateParent.mutationOptions(),
  );
  const unknownMutation = useMutation(
    location.ensureGlobalUnknown.mutationOptions(),
  );

  // The drain loop reads these through refs so a scan enqueued mid-flight is
  // picked up by the loop already running, rather than starting a second one.
  const queueRef = useRef<SweepJob[]>([]);
  const drainingRef = useRef(false);
  // Assigned during render so the drain loop always compares against the live
  // location rather than the one its closure was built with.
  const anchorRef = useRef(locationId);
  anchorRef.current = locationId;

  const reset = useCallback(() => {
    queueRef.current = [];
    setRecentScans([]);
    setStrays([]);
    setBins([]);
    setSeenBins(new Set());
    setMissing(null);
    setTally({ added: 0, confirmed: 0 });
    setPending(0);
    setCurationQueue([]);
    setActiveCuration(null);
  }, []);

  // A sweep belongs to one shelf. Moving to the next one starts over — a stray
  // queued against the old location would otherwise commit against the new.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetting ON locationId change is the point.
  useEffect(() => reset(), [locationId, reset]);

  const patchChip = useCallback(
    (key: string, patch: Partial<Omit<ScanFeedbackEntry, "key">>) =>
      setRecentScans((prev) =>
        prev.map((entry) =>
          entry.key === key ? { ...entry, ...patch } : entry,
        ),
      ),
    [],
  );

  const applyResult = useCallback(
    (key: string, result: ScanAtLocationOut) => {
      patchChip(key, {
        label: result.product.name,
        status:
          result.outcome === "queued"
            ? "queued"
            : result.outcome === "added"
              ? "added"
              : "confirmed",
      });

      if (result.outcome === "added") {
        setTally((prev) => ({ ...prev, added: prev.added + 1 }));
      }
      if (result.outcome === "confirmed") {
        setTally((prev) => ({ ...prev, confirmed: prev.confirmed + 1 }));
      }

      // Only a product the scan itself created can be in the poor state worth
      // curating; anything with existing stock has been seen before.
      const needsName =
        PLACEHOLDER_PRODUCT_NAME.test(result.product.name) ||
        isUnspecifiedManufacturer(result.product.manufacturer);
      if (result.product.created || needsName) {
        setCurationQueue((prev) =>
          prev.some((entry) => entry.id === result.product.id)
            ? prev
            : [
                ...prev,
                {
                  id: result.product.id,
                  name: result.product.name,
                  needsName,
                  needsPrice: !result.product.hasPrice,
                },
              ],
        );
      }

      if (result.strays.length > 0) {
        setStrays((prev) =>
          prev.some((s) => s.productId === result.product.id)
            ? prev
            : [
                ...prev,
                {
                  productId: result.product.id,
                  productName: result.product.name,
                  rows: result.strays,
                },
              ],
        );
      }
    },
    [patchChip],
  );

  const fetchLocation = useCallback(
    (shortcode: string) =>
      queryClient.fetchQuery(entityDetailQueryOptions("location", shortcode)),
    [queryClient],
  );

  /**
   * Both `.parent` chains come from the same read the scan needed anyway, so
   * classification costs no tree: the Location detail returns the ancestor chain
   * and the anchor's is already primed by the page that mounted the sweep.
   */
  const planBinScan = useCallback(
    async (
      anchorId: LocationShortcode,
      targetId: string,
    ): Promise<
      | { kind: "unknown" }
      | {
          kind: "verdict";
          id: string;
          name: string;
          verdict: SweepBinVerdict;
        }
    > => {
      const [anchor, target] = await Promise.all([
        fetchLocation(anchorId),
        fetchLocation(targetId),
      ]);
      if (!anchor || !target) return { kind: "unknown" };
      return {
        kind: "verdict",
        id: target.id,
        name: target.name,
        verdict: planSweptBin(anchor, target),
      };
    },
    [fetchLocation],
  );

  const applyBinVerdict = useCallback(
    (key: string, id: string, name: string, verdict: SweepBinVerdict) => {
      if (verdict.kind === "confirm") {
        setSeenBins((prev) => new Set(prev).add(id));
        // Nothing is written. A bin has no verifiedAt column, and the tally
        // says "here" rather than "confirmed" precisely so this promises no
        // durable record.
        patchChip(key, { label: name, status: "confirmed" });
        setTally((prev) => ({ ...prev, confirmed: prev.confirmed + 1 }));
        return;
      }
      if (verdict.kind === "refuse") {
        patchChip(key, { label: name, status: "failed" });
        toast.error(verdict.message);
        return;
      }
      patchChip(key, { label: name, status: "queued" });
      setSeenBins((prev) => new Set(prev).add(id));
      setBins((prev) =>
        prev.some((bin) => bin.id === verdict.bin.id)
          ? prev
          : [...prev, verdict.bin],
      );
    },
    [patchChip],
  );

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        if (!next) break;

        /**
         * A scan resolves against the location it was READ at, never the one
         * you have since walked to. A late result on a stale anchor is
         * discarded rather than merged: applied to the wrong parent, a queued
         * reparent physically misfiles a bin, and there is no undo. The
         * `pending` decrement rides inside the gate because `reset()` already
         * zeroed it for the new location.
         */
        const settle = (apply: () => void) => {
          if (next.anchor !== anchorRef.current) return;
          apply();
          setPending((n) => Math.max(0, n - 1));
        };

        const failChip = (message: string) =>
          settle(() => {
            patchChip(next.key, { status: "failed" });
            toast.error(message);
          });

        const asBin = resolveLocationScan(next.raw);
        if (asBin.ok) {
          try {
            const outcome = await planBinScan(next.anchor, asBin.value);
            if (outcome.kind === "unknown") {
              failChip("No location matches that code.");
            } else {
              settle(() =>
                applyBinVerdict(
                  next.key,
                  outcome.id,
                  outcome.name,
                  outcome.verdict,
                ),
              );
            }
          } catch (error) {
            failChip(getErrorMessage(error));
          }
          continue;
        }

        const code = resolveProductScan(next.raw);
        if (!code.ok) {
          failChip(code.error);
          continue;
        }

        try {
          const result = await scanMutation.mutateAsync({
            locationId: next.anchor,
            code: code.value,
          });
          settle(() => {
            applyResult(next.key, result);
            onSettled(result);
          });
        } catch (error) {
          failChip(getErrorMessage(error));
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [
    applyResult,
    applyBinVerdict,
    planBinScan,
    patchChip,
    scanMutation,
    onSettled,
  ]);

  const scan = useCallback(
    (raw: string) => {
      const key = `${raw}-${performance.now()}`;
      setRecentScans((prev) =>
        [{ key, label: raw, status: "pending" as const }, ...prev].slice(
          0,
          RECENT_SCAN_LIMIT,
        ),
      );
      setPending((n) => n + 1);
      queueRef.current.push({ key, raw, anchor: anchorRef.current });
      void drain();
    },
    [drain],
  );

  const dismissStray = useCallback(
    (productId: string) =>
      setStrays((prev) => prev.filter((s) => s.productId !== productId)),
    [],
  );

  const dismissBin = useCallback(
    (binId: string) => setBins((prev) => prev.filter((b) => b.id !== binId)),
    [],
  );

  /**
   * Commit everything the sweep queued, in one user action over two mutations.
   *
   * Bins go FIRST, and the order is load-bearing rather than cosmetic. Adopting
   * a bin changes what "elsewhere" means for the items inside it: scan a drill
   * sitting in a garage bin, then scan that bin, and committing the item first
   * yanks the drill onto the shelf so the bin you just correctly adopted
   * arrives empty. Moving the bin first means the drill is already where it
   * belongs, so its queued move is dropped instead.
   *
   * `quantities` names the item rows the user chose to move partially;
   * everything else moves whole, the right default for the single-unit rows
   * that dominate.
   */
  const commitQueued = useCallback(
    async (
      quantities: Record<string, { value: number; unit: string }>,
    ): Promise<SweepCommitOutcome> => {
      const outcome: SweepCommitOutcome = {
        bins: { moved: 0 },
        products: { moved: 0, skipped: [] },
        keptInAdoptedBin: 0,
        failed: null,
      };

      const adoptedIds = bins.map((bin) => bin.id);
      if (adoptedIds.length > 0) {
        try {
          await reparentMutation.mutateAsync({
            ids: adoptedIds,
            parentId: locationId,
          });
          // Count from the queue, not the response: bulkUpdateParent reports
          // the number of ids REQUESTED, which is not evidence of a change.
          outcome.bins.moved = adoptedIds.length;
          setBins([]);
          onSettled();
        } catch (error) {
          // The item filter below assumes the reparents landed, so a bin
          // failure aborts the whole commit. Both queues stay intact and the
          // retry is free — bulkUpdateParent is idempotent.
          toast.error(`Nothing moved. ${getErrorMessage(error)}`);
          return { ...outcome, failed: "bins" };
        }
      }

      const adopted = new Set<string>(adoptedIds);
      const moves: Array<{
        entryId: string;
        quantity?: { value: number; unit: string };
      }> = [];
      for (const stray of strays) {
        for (const row of stray.rows) {
          // The row travelled in with its bin, so moving it now would empty
          // the bin we just adopted. ScanStrayOut carries only the immediate
          // location, so a row nested deeper inside an adopted bin is not
          // detectable here and is still pulled out.
          if (adopted.has(row.location.id)) {
            outcome.keptInAdoptedBin += 1;
            continue;
          }
          const quantity = quantities[row.entryId];
          moves.push({
            entryId: row.entryId,
            ...(quantity ? { quantity } : {}),
          });
        }
      }

      if (moves.length > 0) {
        try {
          const result = await commitMutation.mutateAsync({
            targetLocationId: locationId,
            moves,
          });
          onSettled(result);
          outcome.products = { moved: result.moved, skipped: result.skipped };
        } catch (error) {
          toast.error(
            outcome.bins.moved > 0
              ? `Moved ${countLabel(0, outcome.bins.moved)} in. Items couldn't move: ${getErrorMessage(error)}`
              : getErrorMessage(error),
          );
          return { ...outcome, failed: "products" };
        }
      }

      // Unconditional, and symmetric with the bin queue above. The loop
      // resolves EVERY queued row — each one either joined `moves` or was
      // deliberately left in the bin that came with it — so a commit carrying
      // only kept-in-bin rows still empties the queue. Clearing this inside
      // the `moves.length > 0` branch instead would leave those rows behind,
      // and the next click would see no adopted bins to filter against and
      // yank them out of the bin this ordering exists to protect.
      setStrays([]);

      toast.success(commitSummary(outcome));
      return outcome;
    },
    [strays, bins, locationId, commitMutation, reparentMutation, onSettled],
  );

  /**
   * Close the world, on request, over bins only.
   *
   * Items are left to the recount, which reconciles an expected snapshot with
   * a staleness check and four per-row resolutions. Reporting them here badly
   * would be worse than not reporting them, so the panel says so out loud
   * rather than staying silent — silence reads as "nothing else is missing".
   */
  const checkMissing = useCallback(async () => {
    setCheckingMissing(true);
    try {
      const anchor = await fetchLocation(locationId);
      const absent = (anchor?.children ?? [])
        .filter((child) => canGoMissing(child) && !seenBins.has(child.id))
        .map((child) => ({
          id: child.id,
          name: child.name,
          type: child.type,
        }));
      setMissing(absent);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setCheckingMissing(false);
    }
  }, [fetchLocation, locationId, seenBins]);

  /**
   * Absence never writes on its own — every repair here is an explicit,
   * per-row choice, which is what makes the opt-in bucket safe on a pass that
   * genuinely was partial.
   */
  const relocateMissing = useCallback(
    async (binId: string, parentId: string) => {
      try {
        await reparentMutation.mutateAsync({ ids: [binId], parentId });
        setMissing((prev) => prev?.filter((bin) => bin.id !== binId) ?? null);
        onSettled();
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [reparentMutation, onSettled],
  );

  const sendMissingToUnknown = useCallback(
    async (binId: string) => {
      try {
        // Idempotent: it returns the one global Unknown, creating it only if
        // this household has never parked anything before.
        const unknown = await unknownMutation.mutateAsync(undefined);
        await relocateMissing(binId, unknown.id);
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [unknownMutation, relocateMissing],
  );

  const finishCuration = useCallback((id: string) => {
    setCurationQueue((prev) => prev.filter((entry) => entry.id !== id));
    setActiveCuration(null);
  }, []);

  return {
    scan,
    curationQueue,
    activeCuration,
    openCuration: () => setActiveCuration(curationQueue[0] ?? null),
    finishCuration,
    recentScans,
    strays,
    tally,
    /** Everything waiting on the one end-of-sweep decision. */
    queuedCount: strays.length + bins.length,
    /** Scans read but not yet resolved. Gates the caller's "done" affordance. */
    pending,
    bins,
    missing,
    checkingMissing,
    checkMissing,
    relocateMissing,
    sendMissingToUnknown,
    dismissStray,
    dismissBin,
    commitQueued,
    committing: commitMutation.isPending || reparentMutation.isPending,
    reset,
  };
}
