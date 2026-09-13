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
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { householdDateTime } from "~/lib/household-date";

import { EntryForm } from "./entry-form";
import { garden } from "./garden.functions";

export function GardenEntryContent({ entry }: { entry: GardenEntryOut }) {
  const [preview, setPreview] = useState<number | null>(null);
  const kind =
    entry.kind === "observation"
      ? "Observation"
      : entry.kind === "harvest"
        ? "Harvest"
        : "Move";
  const date = householdDateTime(entry.observedOn).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });
  return (
    <Stack gap="md">
      <Row gap="sm" align="center" justify="between">
        <Link
          to="/garden-entries/$shortcode"
          params={{ shortcode: gardenEntryShortcode.parse(entry.id) }}
          className="min-h-11 content-center font-medium hover:underline"
        >
          {date} · {entry.plantingId ? kind : `Whole-bed ${kind.toLowerCase()}`}
        </Link>
        <Link
          to="/locations/$shortcode"
          params={{ shortcode: entry.locationId }}
          className="text-sm underline"
        >
          {entry.locationName}
        </Link>
      </Row>
      {entry.plantingId && (
        <Link
          to="/plantings/$shortcode"
          params={{ shortcode: entry.plantingId }}
          className="text-sm font-medium underline"
        >
          {entry.plantingName ?? "View planting"}
        </Link>
      )}
      {entry.harvestAmount && <p>{entry.harvestAmount}</p>}
      {entry.note && (
        <p className="text-sm whitespace-pre-wrap">{entry.note}</p>
      )}
      {entry.images.length > 0 && (
        <PhotoGrid
          images={entry.images}
          fit="contain"
          className={
            entry.images.length === 1
              ? "max-w-md grid-cols-1 sm:grid-cols-1 md:grid-cols-1"
              : "grid-cols-2 sm:grid-cols-2 md:grid-cols-2"
          }
          tileClassName="aspect-[4/3]"
          onSelect={(_, index) => setPreview(index)}
        />
      )}
      <PhotoViewer
        images={entry.images}
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
}: {
  locationId?: string;
  plantingId?: string;
}) {
  return plantingId ? (
    <PlantingTimeline key={plantingId} plantingId={plantingId} />
  ) : (
    <LocationTimeline key={locationId ?? "all"} locationId={locationId} />
  );
}

function PlantingTimeline({ plantingId }: { plantingId: string }) {
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

function GardenTimelineContent({
  entries,
  page,
  setPage,
  plantingId,
}: {
  entries: UseQueryResult<{ items: GardenEntryOut[]; hasMore: boolean }>;
  page: number;
  setPage: (page: number) => void;
  plantingId?: string;
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
  return (
    <Stack gap="lg" className="w-full max-w-3xl">
      {plantingId && (
        <p className="text-sm text-muted-foreground">
          Includes whole-bed entries from dates when this planting was known to
          be there.
        </p>
      )}
      {entries.data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No entries yet. A photo or short note is a good place to start.
        </p>
      )}
      {entries.data.items.map((entry) => (
        <section key={entry.id} className="border-b pb-4">
          <Stack gap="md">
            <GardenEntryContent entry={entry} />
            <Row justify="end">
              <Button variant="ghost" onClick={() => setEditing(entry)}>
                Edit entry
              </Button>
            </Row>
          </Stack>
        </section>
      ))}
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
      {editing && (
        <ResponsiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          title="Edit garden entry"
          size="lg"
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
