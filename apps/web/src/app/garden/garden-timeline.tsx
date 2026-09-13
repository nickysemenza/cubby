import type { GardenEntryOut } from "@cubby/schemas/garden";
import {
  gardenEntryShortcode,
  locationShortcode,
  plantingShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Grid, Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { getErrorMessage } from "~/lib/error-utils";

import { EntryForm } from "./entry-form";
import { garden } from "./garden.functions";

export function GardenEntryContent({ entry }: { entry: GardenEntryOut }) {
  return (
    <Stack gap="md">
      <Row gap="sm" align="center" justify="between">
        <Link
          to="/garden-entries/$shortcode"
          params={{ shortcode: gardenEntryShortcode.parse(entry.id) }}
          className="min-h-11 content-center font-medium hover:underline"
        >
          {entry.observedOn} · {entry.kind}
        </Link>
        <Link
          to="/locations/$shortcode"
          params={{ shortcode: entry.locationId }}
          className="text-sm underline"
        >
          Event location
        </Link>
      </Row>
      {entry.harvestAmount && <p>{entry.harvestAmount}</p>}
      {entry.note && (
        <p className="text-sm whitespace-pre-wrap">{entry.note}</p>
      )}
      {entry.images.length > 0 && (
        <Grid cols="pair" gap="md">
          {entry.images.map((image) => (
            <a key={image.id} href={image.url} target="_blank" rel="noreferrer">
              <Image
                src={image.url}
                alt={`Garden observation on ${entry.observedOn}`}
                displayWidth={480}
                className="max-h-80 w-full rounded-md object-contain"
              />
            </a>
          ))}
        </Grid>
      )}
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
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<GardenEntryOut | null>(null);
  const entries = useQuery(
    garden.entries.queryOptions({
      locationId: locationId ? locationShortcode.parse(locationId) : undefined,
      plantingId: plantingId ? plantingShortcode.parse(plantingId) : undefined,
      page,
    }),
  );
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
    <Stack gap="lg">
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
