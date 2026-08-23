/**
 * Sweep a shelf: point the camera at everything on it.
 *
 * New products are created and stocked here, things already here are confirmed
 * without touching their counts, and anything on record somewhere else collects
 * in the review panel at the bottom. The camera never goes down for a decision —
 * that is the difference between a sixty-book sweep and sixty prompts.
 *
 * Mounted standalone from a location's detail page (so a brand-new empty shelf
 * can be swept) and from inside the recount at its current stop.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";
import {
  PersistentScanner,
  UNIVERSAL_SCAN_FORMATS,
} from "~/app/_components/inventory/persistent-scanner";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { SweepStrayReview } from "./SweepStrayReview";
import { useLocationSweep } from "./useLocationSweep";

export function LocationSweep({
  locationId,
  locationName,
  onSettled,
}: {
  locationId: LocationShortcode;
  locationName: string;
  onSettled: (result?: unknown) => void;
}) {
  const [manualValue, setManualValue] = useState("");
  const {
    scan,
    recentScans,
    strays,
    tally,
    pending,
    dismissStray,
    commitStrays,
    committing,
  } = useLocationSweep({ locationId, onSettled });

  const submitManual = () => {
    const value = manualValue.trim();
    if (!value) return;
    scan(value);
    setManualValue("");
  };

  return (
    <Stack gap="sm">
      <PersistentScanner
        onScan={scan}
        // Universal, so one pass takes book barcodes and bin labels without a
        // mode switch. QR is checksummed, so the extra format costs a decode
        // attempt per frame, not accuracy.
        formatsToSupport={UNIVERSAL_SCAN_FORMATS}
        scanHintText={`Point at anything on ${locationName}`}
        debounceMs={2500}
        addedCount={tally.added + tally.confirmed}
        recentScans={recentScans}
      />

      <Row align="center" justify="between" gap="sm" className="min-w-0">
        <Description>
          {tally.added} added · {tally.confirmed} confirmed
          {pending > 0 ? ` · ${pending} reading…` : ""}
        </Description>
      </Row>

      {/* A smudged barcode is a real failure mode, and this is also the only
          path an end-to-end test can drive. */}
      <Row
        as="form"
        align="center"
        gap="sm"
        onSubmit={(event) => {
          event.preventDefault();
          submitManual();
        }}
      >
        <Input
          value={manualValue}
          onChange={(event) => setManualValue(event.target.value)}
          placeholder="Can't scan? Type a code"
          className="h-9 flex-1 text-xs"
          aria-label="Enter a barcode, ISBN, or Cubby code"
        />
        <Button
          type="submit"
          variant="outline"
          className="min-h-9 px-3 text-xs" /* tight: manual scan fallback */
          disabled={manualValue.trim().length === 0}
        >
          Add
        </Button>
      </Row>

      <SweepStrayReview
        strays={strays}
        locationName={locationName}
        committing={committing}
        onCommit={commitStrays}
        onDismiss={dismissStray}
      />
    </Stack>
  );
}
