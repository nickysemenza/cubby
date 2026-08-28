/**
 * Sweep a shelf: point the camera at everything on it.
 *
 * One camera, two kinds of thing. A product barcode and a bin's QR label are
 * answered by the same rule: already directly here means it is confirmed
 * without touching anything, and living elsewhere collects in the review panel
 * at the bottom for one decision. New products are created and stocked here.
 * The camera never goes down for a decision — that is the difference between a
 * sixty-book sweep and sixty prompts.
 *
 * Mounted standalone from a location's detail page (so a brand-new empty shelf
 * can be swept) and from inside the recount at its current stop.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";

import {
  PersistentScanner,
  UNIVERSAL_SCAN_FORMATS,
} from "~/app/_components/inventory/persistent-scanner";
import { ScanManualEntry } from "~/app/_components/inventory/scan-sheet";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";

import { SweepMissingReview } from "./SweepMissingReview";
import { SweepProductFollowUp } from "./SweepProductFollowUp";
import { SweepStrayReview } from "./SweepStrayReview";
import { type SweepSettledResult, useLocationSweep } from "./useLocationSweep";

export function LocationSweep({
  locationId,
  locationName,
  hasItems = false,
  onSettled,
}: {
  locationId: LocationShortcode;
  locationName: string;
  /** Drives the missing panel's "items aren't checked here" disclosure. */
  hasItems?: boolean;
  onSettled: (result?: SweepSettledResult) => void;
}) {
  const {
    scan,
    curationQueue,
    activeCuration,
    openCuration,
    finishCuration,
    recentScans,
    strays,
    bins,
    tally,
    queuedCount,
    pending,
    missing,
    checkingMissing,
    checkMissing,
    relocateMissing,
    sendMissingToUnknown,
    dismissStray,
    dismissBin,
    commitQueued,
    committing,
  } = useLocationSweep({ locationId, onSettled });

  const swept = tally.added + tally.confirmed;
  // Eyes-free, so it must not overstate: "swept" covers items stocked and
  // everything merely seen, and the queue rides along because the review panel
  // sits below a full-height viewfinder where it cannot be noticed.
  const hudText = [
    swept > 0 ? `${swept} swept` : null,
    queuedCount > 0 ? `${queuedCount} to bring in` : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
        hudText={hudText}
        recentScans={recentScans}
      />

      <Row align="center" justify="between" gap="sm" className="min-w-0">
        <Description>
          {/* "here" rather than "confirmed": a confirmed bin writes nothing at
              all, and the word has to stay true for both kinds. Before the
              first scan the line teaches instead of printing dead zeros. */}
          {swept === 0 && pending === 0 && queuedCount === 0
            ? "Scan anything that sits here — items by barcode, bins by their label."
            : `${tally.added} added · ${tally.confirmed} here` +
              (queuedCount > 0 ? ` · ${queuedCount} to bring in` : "") +
              (pending > 0 ? ` · ${pending} reading…` : "")}
        </Description>
        {/* Curation waits for you to ask. Opening it per scan would put a modal
            in front of every new item and cover the review below. */}
        {curationQueue.length > 0 && (
          <Button
            type="button"
            variant="outline"
            className="min-h-9 shrink-0 px-3 text-xs" /* tight: sits inline with the tally line */
            onClick={openCuration}
          >
            {curationQueue.length === 1
              ? "1 item needs details"
              : `${curationQueue.length} items need details`}
          </Button>
        )}
      </Row>

      <ScanManualEntry
        ariaLabel="Enter a barcode, ISBN, or Cubby code"
        placeholder="Can't scan? Type a code"
        submitLabel="Add"
        onSubmit={scan}
      />

      {/* Absence is asked for, never assumed: a pass can legitimately stop
          halfway, so nothing computes what is missing until you say you got
          everything. */}
      {missing === null && (
        <Button
          type="button"
          variant="outline"
          className="min-h-10 self-start px-3 text-xs" /* tight: sits with the manual-entry row */
          disabled={checkingMissing || pending > 0}
          onClick={() => void checkMissing()}
        >
          {checkingMissing ? <Spinner /> : null}
          Done — what's missing?
        </Button>
      )}

      <SweepMissingReview
        missing={missing}
        locationId={locationId}
        locationName={locationName}
        hasItems={hasItems}
        busy={committing}
        onRelocate={relocateMissing}
        onSendToUnknown={sendMissingToUnknown}
      />

      <SweepStrayReview
        strays={strays}
        bins={bins}
        locationName={locationName}
        committing={committing}
        onCommit={commitQueued}
        onDismiss={dismissStray}
        onDismissBin={dismissBin}
      />

      <SweepProductFollowUp
        followUp={activeCuration}
        locationName={locationName}
        onClose={finishCuration}
        onSaved={onSettled}
      />
    </Stack>
  );
}
