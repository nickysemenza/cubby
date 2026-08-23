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
 * commit against the next one.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { ScanAtLocationOut, ScanStrayOut } from "@cubby/schemas/scan";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ScanFeedbackEntry } from "~/app/_components/inventory/persistent-scanner";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { resolveScanCode } from "~/lib/scan-code";

/** How many recently-scanned chips the viewfinder shows (newest first). */
const RECENT_SCAN_LIMIT = 5;

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
  confirmed: number;
}

export function useLocationSweep({
  locationId,
  onSettled,
}: {
  locationId: LocationShortcode;
  /** Fired after any write, so the caller can invalidate its own queries. */
  onSettled: (result?: unknown) => void;
}) {
  const api = useTRPC();
  const [recentScans, setRecentScans] = useState<ScanFeedbackEntry[]>([]);
  const [strays, setStrays] = useState<QueuedStray[]>([]);
  const [tally, setTally] = useState<SweepTally>({ added: 0, confirmed: 0 });
  const [pending, setPending] = useState(0);

  const scanMutation = useMutation(
    api.inventory.scanAtLocation.mutationOptions(),
  );
  const commitMutation = useMutation(
    api.inventory.resolveScanStrays.mutationOptions(),
  );

  // The drain loop reads these through refs so a scan enqueued mid-flight is
  // picked up by the loop already running, rather than starting a second one.
  const queueRef = useRef<{ key: string; raw: string }[]>([]);
  const drainingRef = useRef(false);

  const reset = useCallback(() => {
    queueRef.current = [];
    setRecentScans([]);
    setStrays([]);
    setTally({ added: 0, confirmed: 0 });
    setPending(0);
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

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        if (!next) break;

        const parsed = resolveScanCode(next.raw);
        if (!parsed.ok || parsed.value.kind !== "product") {
          // A location QR is handled by the caller, not here; anything else is
          // simply not something a sweep can stock.
          patchChip(next.key, { status: "failed" });
          toast.error(parsed.ok ? "Not a product code." : parsed.error);
          setPending((n) => Math.max(0, n - 1));
          continue;
        }

        try {
          const result = await scanMutation.mutateAsync({
            locationId,
            code: parsed.value.code,
          });
          applyResult(next.key, result);
          onSettled(result);
        } catch (error) {
          patchChip(next.key, { status: "failed" });
          toast.error(getErrorMessage(error));
        } finally {
          setPending((n) => Math.max(0, n - 1));
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [locationId, applyResult, patchChip, scanMutation, onSettled]);

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
      queueRef.current.push({ key, raw });
      void drain();
    },
    [drain],
  );

  const dismissStray = useCallback(
    (productId: string) =>
      setStrays((prev) => prev.filter((s) => s.productId !== productId)),
    [],
  );

  /**
   * Commit the queued strays. `quantities` names the ones the user chose to
   * move partially; everything else moves whole, which is the right default
   * for the single-unit rows that dominate.
   */
  const commitStrays = useCallback(
    async (quantities: Record<string, { value: number; unit: string }>) => {
      const moves = strays.flatMap((stray) =>
        stray.rows.map((row) => ({
          entryId: row.entryId,
          ...(quantities[row.entryId]
            ? { quantity: quantities[row.entryId] }
            : {}),
        })),
      );
      if (moves.length === 0) return;

      try {
        const result = await commitMutation.mutateAsync({
          targetLocationId: locationId,
          moves,
        });
        setStrays([]);
        onSettled(result);
        const skipped = result.skipped.length;
        toast.success(
          skipped > 0
            ? `Moved ${result.moved} in · ${skipped} had already moved.`
            : `Moved ${result.moved} in.`,
        );
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [strays, locationId, commitMutation, onSettled],
  );

  return {
    scan,
    recentScans,
    strays,
    tally,
    /** Scans read but not yet resolved. Gates the caller's "done" affordance. */
    pending,
    dismissStray,
    commitStrays,
    committing: commitMutation.isPending,
    reset,
  };
}
