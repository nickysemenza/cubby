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
import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import type {
  ScanAtLocationCode,
  ScanAtLocationOut,
  ScanStrayOut,
} from "@cubby/schemas/scan";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ScanFeedbackEntry } from "~/app/_components/inventory/persistent-scanner";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { resolveScanCode } from "~/lib/scan-code";
import type { SweepFollowUp } from "./SweepProductFollowUp";

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
  confirmed: number;
}

/**
 * Narrow a scanned string to something a sweep can stock.
 *
 * Cubby's own product labels are QR, and the sweep reads QR, so a printed
 * `PRD-` label has to work here — rejecting it would make the label useless on
 * the one screen most likely to see it. A location QR is the caller's business
 * (it re-parents bins), and any other entity simply isn't stock.
 */
function toSweepCode(
  raw: string,
): { ok: true; value: ScanAtLocationCode } | { ok: false; error: string } {
  const parsed = resolveScanCode(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value.kind === "product") {
    return { ok: true, value: parsed.value.code };
  }
  if (parsed.value.type === "product") {
    return {
      ok: true,
      value: {
        kind: "product",
        value: unsafeProductShortcode(parsed.value.shortcode),
      },
    };
  }
  if (parsed.value.type === "location") {
    return {
      ok: false,
      error: "That's a location label — use the bin scanner to move it.",
    };
  }
  return {
    ok: false,
    error: `That's a ${parsed.value.type} label, not stock.`,
  };
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
  // Curation is QUEUED, never interrupting. The follow-up is a modal sheet, so
  // opening it per scan would put sixty modals in front of a sixty-book sweep
  // and cover the stray review besides. It waits until you ask for it.
  const [curationQueue, setCurationQueue] = useState<SweepFollowUp[]>([]);
  const [activeCuration, setActiveCuration] = useState<SweepFollowUp | null>(
    null,
  );

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

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        if (!next) break;

        const code = toSweepCode(next.raw);
        if (!code.ok) {
          patchChip(next.key, { status: "failed" });
          toast.error(code.error);
          setPending((n) => Math.max(0, n - 1));
          continue;
        }

        try {
          const result = await scanMutation.mutateAsync({
            locationId,
            code: code.value,
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
        // Branch on the structured reason rather than a count: "already moved"
        // and "already here" are different facts, and reporting one as the
        // other is how a caller learns to distrust the number.
        const goneElsewhere = result.skipped.filter(
          (row) => row.reason === "already-moved",
        ).length;
        const alreadyHere = result.skipped.length - goneElsewhere;
        const notes = [
          goneElsewhere > 0 ? `${goneElsewhere} had already moved` : null,
          alreadyHere > 0 ? `${alreadyHere} were already here` : null,
        ].filter(Boolean);
        toast.success(
          notes.length > 0
            ? `Moved ${result.moved} in · ${notes.join(" · ")}.`
            : `Moved ${result.moved} in.`,
        );
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [strays, locationId, commitMutation, onSettled],
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
    /** Scans read but not yet resolved. Gates the caller's "done" affordance. */
    pending,
    dismissStray,
    commitStrays,
    committing: commitMutation.isPending,
    reset,
  };
}
