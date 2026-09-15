import type { GardenEntryOut } from "@cubby/schemas/garden";
import {
  gardenEntryShortcode,
  locationShortcode,
  plantingShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { PhotoGrid } from "~/app/_components/photos/photo-grid";
import { PhotoViewer } from "~/app/_components/photos/photo-viewer";
import { formatDateWithYear } from "~/app/projects/project-formatting";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { householdDateTime } from "~/lib/household-date";

import { EntryForm } from "./entry-form";
import { GardenDialogFooterSlot } from "./garden-fields";
import { gardenEntryKindLabel, JournalPhotoStrip } from "./garden-photos";
import { garden } from "./garden.functions";

/**
 * `variant="detail"` (the default — matches the entry's own canonical detail
 * route, `garden-entries.$shortcode.tsx`, which renders this with no variant)
 * omits the "date · kind" heading: that route's page title already spells out
 * kind, date, and location (`GardenEntryOut.displayName`), so the heading
 * would just be a self-link back to the page already on screen. `variant="list"`
 * is the journal-list presentation and renders it — every timeline call site
 * below passes it explicitly.
 */
export function GardenEntryContent({
  entry,
  variant = "detail",
}: {
  entry: GardenEntryOut;
  variant?: "list" | "detail";
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const kindLabel = gardenEntryKindLabel(entry.kind);
  const kindLine = entry.plantingId ? kindLabel : `Whole area · ${kindLabel}`;
  const date = householdDateTime(entry.observedOn).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });
  // Accessible name mirrors the journal card strip's: "<Kind> photo, <date>",
  // not the raw filename.
  const images = entry.images.map((image) => ({
    ...image,
    filename: `${kindLabel} photo, ${formatDateWithYear(entry.observedOn)}`,
  }));
  return (
    <Stack gap="md">
      {variant === "list" && (
        <Row gap="sm" align="center" justify="between">
          <Row gap="sm" align="center">
            <Link
              to="/garden-entries/$shortcode"
              params={{ shortcode: gardenEntryShortcode.parse(entry.id) }}
              className="min-h-11 content-center font-medium hover:underline"
            >
              {date} · {kindLine}
            </Link>
            {entry.anchorsPeriod && (
              <Badge variant="secondary">Started here</Badge>
            )}
          </Row>
          <Link
            to="/locations/$shortcode"
            params={{ shortcode: entry.locationId }}
            className="text-sm underline"
          >
            {entry.locationName}
          </Link>
        </Row>
      )}
      {entry.plantingId && (
        <Link
          to="/plantings/$shortcode"
          params={{ shortcode: entry.plantingId }}
          className="text-sm font-medium underline"
        >
          {entry.plantingName ?? "View planting"}
        </Link>
      )}
      {entry.harvestAmount && <p>Harvest: {entry.harvestAmount}</p>}
      {entry.note && (
        <p className="text-sm whitespace-pre-wrap">{entry.note}</p>
      )}
      {images.length > 0 && (
        <PhotoGrid
          images={images}
          fit="contain"
          className={
            images.length === 1
              ? "max-w-md grid-cols-1 sm:grid-cols-1 md:grid-cols-1"
              : "grid-cols-2 sm:grid-cols-2 md:grid-cols-2"
          }
          tileClassName="aspect-[4/3]"
          onSelect={(_, index) => setPreview(index)}
        />
      )}
      <PhotoViewer
        images={images}
        index={preview}
        onIndexChange={setPreview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        detailLink={(image) => ({ shortcode: image.id })}
      />
    </Stack>
  );
}

export function GardenTimeline({
  locationId,
  plantingId,
  hasConfirmedLocationPeriod = false,
}: {
  locationId?: string;
  plantingId?: string;
  /** Only meaningful with `plantingId`: gates the whole-area entries hint. */
  hasConfirmedLocationPeriod?: boolean;
}) {
  return plantingId ? (
    <PlantingTimeline
      key={plantingId}
      plantingId={plantingId}
      hasConfirmedLocationPeriod={hasConfirmedLocationPeriod}
    />
  ) : (
    <LocationTimeline key={locationId ?? "all"} locationId={locationId} />
  );
}

function PlantingTimeline({
  plantingId,
  hasConfirmedLocationPeriod,
}: {
  plantingId: string;
  hasConfirmedLocationPeriod: boolean;
}) {
  const [page, setPage] = useState(1);
  const entries = useQuery(
    garden.journal.queryOptions({
      plantingId: plantingShortcode.parse(plantingId),
      includeBedContext: true,
      page,
    }),
  );
  return (
    <GardenTimelineContent
      entries={entries}
      page={page}
      setPage={setPage}
      plantingId={plantingId}
      hasConfirmedLocationPeriod={hasConfirmedLocationPeriod}
    />
  );
}

function LocationTimeline({ locationId }: { locationId?: string }) {
  const [page, setPage] = useState(1);
  const entries = useQuery(
    garden.entries.queryOptions({
      locationId: locationId ? locationShortcode.parse(locationId) : undefined,
      page,
    }),
  );
  return (
    <GardenTimelineContent entries={entries} page={page} setPage={setPage} />
  );
}

export function GardenTimelineContent({
  entries,
  page,
  setPage,
  plantingId,
  hasConfirmedLocationPeriod,
}: {
  entries: UseQueryResult<{ items: GardenEntryOut[]; hasMore: boolean }>;
  page: number;
  setPage: (page: number) => void;
  plantingId?: string;
  hasConfirmedLocationPeriod?: boolean;
}) {
  const [editing, setEditing] = useState<GardenEntryOut | null>(null);
  if (entries.isPending) return <p>Loading history…</p>;
  if (entries.isError)
    return (
      <Stack gap="md">
        <p role="alert">
          Could not load history: {getErrorMessage(entries.error)}
        </p>
        <Button onClick={() => void entries.refetch()}>Retry</Button>
      </Stack>
    );
  const singlePage = page === 1 && !entries.data.hasMore;
  return (
    <Stack gap="lg" className="w-full max-w-3xl">
      <JournalPhotoStrip entries={entries.data.items} />
      {plantingId &&
        (hasConfirmedLocationPeriod ? (
          <p className="text-sm text-muted-foreground">
            Includes whole-area entries from dates when this planting was known
            to be there.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Whole-area entries appear here once you confirm this planting’s
            location dates.{" "}
            <a href="#location-history" className="underline">
              Confirm in Location history
            </a>
          </p>
        ))}
      {entries.data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No entries yet. A photo or short note is a good place to start.
        </p>
      )}
      {entries.data.items.map((entry) => (
        <section key={entry.id} className="border-b pb-4">
          <Stack gap="md">
            <GardenEntryContent entry={entry} variant="list" />
            <Row justify="end">
              <Button
                variant="ghost"
                onClick={() => setEditing(entry)}
                title={
                  entry.anchorsPeriod
                    ? "This entry’s date is corrected in Location history, not here."
                    : undefined
                }
              >
                {entry.anchorsPeriod ? "Edit note" : "Edit entry"}
              </Button>
            </Row>
          </Stack>
        </section>
      ))}
      {!singlePage && (
        <Row gap="sm" justify="between">
          <Button
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Newer entries
          </Button>
          <Button
            variant="outline"
            disabled={!entries.data.hasMore}
            onClick={() => setPage(page + 1)}
          >
            Older entries
          </Button>
        </Row>
      )}
      {editing && (
        <ResponsiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          title="Edit garden entry"
          size="lg"
          footer={<GardenDialogFooterSlot />}
        >
          <EntryForm
            entry={editing}
            locationId={editing.locationId}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void entries.refetch();
            }}
          />
        </ResponsiveDialog>
      )}
    </Stack>
  );
}
