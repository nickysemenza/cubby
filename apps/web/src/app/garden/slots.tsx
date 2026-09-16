import type { GardenEntryOut, GardenPlantingOut } from "@cubby/schemas/garden";
import type { GardenLocationKind } from "@cubby/schemas/garden-fields";
import { plantingShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { formatDateWithYear } from "~/app/projects/project-formatting";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { householdDateTime } from "~/lib/household-date";

import { EntryForm } from "./entry-form";
import { GardenDialogFooterSlot } from "./garden-fields";
import { GardenGuide } from "./garden-guide";
import { gardenEntryKindLabel } from "./garden-photos";
import { garden } from "./garden.functions";
import { PlantingLocationHistory as LocationHistoryPanel } from "./location-history";

/**
 * The garden's fills for the Location, Ingredient, Product and Planting
 * detail slots. The first three keep those pages inventory/product-shaped:
 * each slot's `applies` predicate in `detail-slots.tsx` hides the section on
 * a location that is no bed, an ingredient with no guide, a product that
 * grows nothing.
 */

const GARDEN_LOCATION_KIND_LABELS = {
  bed: "Raised bed",
  tray: "Seed tray",
  other: "Other",
} satisfies Record<GardenLocationKind, string>;

interface OverviewPlantingsSource {
  locations: Array<{ plantings: GardenPlantingOut[] }>;
  unassigned: GardenPlantingOut[];
  finished: GardenPlantingOut[];
}

function allOverviewPlantings(
  overview: OverviewPlantingsSource | undefined,
): GardenPlantingOut[] {
  if (!overview) return [];
  return [
    ...overview.locations.flatMap((location) => location.plantings),
    ...overview.unassigned,
    ...overview.finished,
  ];
}

/** "Sowed 2026-03-01" / "Transplanted …" / "Planned …" — the same date
 * precedence `garden-home.tsx`'s `PlantingRow` uses, read here as "how long
 * this planting has been in this bed." */
function plantingHereSince(planting: GardenPlantingOut): string | null {
  if (planting.transplantedOn)
    return `Transplanted ${formatDateWithYear(planting.transplantedOn)}`;
  if (planting.sowedOn) return `Sowed ${formatDateWithYear(planting.sowedOn)}`;
  if (planting.plannedDate)
    return `Planned ${formatDateWithYear(planting.plannedDate)}`;
  return null;
}

/** First line of the note, falling back to the harvest amount — enough to
 * recognize an entry in a compact list without rendering its full body. */
function entryFirstLine(entry: GardenEntryOut): string | null {
  const noteLine = entry.note?.split("\n")[0]?.trim();
  if (noteLine) return noteLine;
  return entry.harvestAmount ?? null;
}

function GardenPlantingRow({ planting }: { planting: GardenPlantingOut }) {
  const hereSince = plantingHereSince(planting);
  return (
    <Row
      gap="sm"
      align="center"
      justify="between"
      className="border-b py-2 last:border-b-0"
    >
      <Stack gap="xs" className="min-w-0">
        <EntityInlineLink
          entity="planting"
          displayImage={undefined}
          data={{ id: planting.id, name: planting.displayName }}
        />
        {hereSince && <Description size="xs">{hereSince}</Description>}
      </Stack>
      <Badge variant="secondary">{planting.status}</Badge>
    </Row>
  );
}

function GardenRecentEntries({ locationId }: { locationId: string }) {
  const entries = useQuery(
    // SAFETY: the location detail's own shortcode; the query input parses it.
    garden.entries.queryOptions({ locationId: locationId as never, page: 1 }),
  );
  if (entries.isPending)
    return <Description size="xs">Loading recent activity…</Description>;
  if (entries.isError)
    return <Description size="xs">Could not load recent activity.</Description>;
  const recent = entries.data.items.slice(0, 3);
  if (recent.length === 0)
    return <Description size="xs">No entries yet.</Description>;
  return (
    <Stack gap="xs">
      {recent.map((entry) => {
        const date = householdDateTime(entry.observedOn).toLocaleDateString(
          "en-US",
          {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "America/Los_Angeles",
          },
        );
        const line = entryFirstLine(entry);
        return (
          <p key={entry.id} className="text-sm">
            {date} · {gardenEntryKindLabel(entry.kind)}
            {line ? ` · ${line}` : ""}
          </p>
        );
      })}
    </Stack>
  );
}

/** A bed/tray's plantings, recent journal lines and a "Log entry" capture. */
export const LocationGarden: DetailSlotComponent<"location"> = ({
  record: location,
}) => {
  const overview = useQuery(garden.overview.queryOptions(undefined));
  const [loggingEntry, setLoggingEntry] = useState(false);
  const summary = overview.data?.locations.find(
    (candidate) => candidate.id === location.id,
  );
  const kindLabel = location.gardenKind
    ? GARDEN_LOCATION_KIND_LABELS[location.gardenKind]
    : null;
  return (
    <Stack gap="md">
      <Row gap="sm" wrap align="center" justify="between">
        <Stack gap="xs">
          {kindLabel && <Badge variant="secondary">{kindLabel}</Badge>}
          {location.gardenConditions && (
            <Description size="xs">{location.gardenConditions}</Description>
          )}
        </Stack>
        <Row gap="sm" wrap>
          <Button size="sm" onClick={() => setLoggingEntry(true)}>
            Log entry
          </Button>
          <Link
            to="/garden-entries"
            search={{ locationId: location.id }}
            className="content-center text-sm underline"
          >
            {location.name} journal
          </Link>
        </Row>
      </Row>
      {overview.isPending ? (
        <Description size="xs">Loading plantings…</Description>
      ) : overview.isError ? (
        <Description size="xs">Could not load plantings.</Description>
      ) : (summary?.plantings.length ?? 0) === 0 ? (
        <Description size="xs">
          No current or planned plantings here.
        </Description>
      ) : (
        <Stack gap="xs">
          {summary?.plantings.map((planting) => (
            <GardenPlantingRow key={planting.id} planting={planting} />
          ))}
        </Stack>
      )}
      <Stack gap="xs">
        <Description size="xs">Recent activity</Description>
        <GardenRecentEntries locationId={location.id} />
      </Stack>
      {loggingEntry && (
        <ResponsiveDialog
          open
          title="Log garden entry"
          size="lg"
          onOpenChange={setLoggingEntry}
          footer={<GardenDialogFooterSlot />}
        >
          <EntryForm
            locationId={location.id}
            onCancel={() => setLoggingEntry(false)}
            onSaved={() => setLoggingEntry(false)}
          />
        </ResponsiveDialog>
      )}
    </Stack>
  );
};

function GuideDisplayName({ guideKey }: { guideKey: string }) {
  const guides = useQuery(garden.guides.queryOptions(undefined));
  const name = guides.data?.guides.find(
    (candidate) => candidate.key === guideKey,
  )?.name;
  return <>{name ?? guideKey}</>;
}

/** An ingredient's guide and the plantings that grow it. */
export const IngredientGarden: DetailSlotComponent<"ingredient"> = ({
  record: ingredient,
}) => {
  const overview = useQuery(garden.overview.queryOptions(undefined));
  const plantings = allOverviewPlantings(overview.data).filter(
    (planting) => planting.ingredientId === ingredient.id,
  );
  return (
    <Stack gap="sm">
      {ingredient.gardenGuideKey && (
        <p className="text-sm">
          Guide: <GuideDisplayName guideKey={ingredient.gardenGuideKey} />
        </p>
      )}
      {plantings.length > 0 && (
        <Stack gap="xs">
          <Description size="xs">Plantings ({plantings.length})</Description>
          {plantings.slice(0, 5).map((planting) => (
            <EntityInlineLink
              key={planting.id}
              entity="planting"
              displayImage={undefined}
              data={{ id: planting.id, name: planting.displayName }}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};

/** What a seed/starts product grows and the plantings sourced from it. */
export const ProductGarden: DetailSlotComponent<"product"> = ({
  record: product,
}) => {
  const options = useQuery(garden.options.queryOptions({}));
  const overview = useQuery(garden.overview.queryOptions(undefined));
  const ingredient = options.data?.ingredients.find(
    (candidate) => candidate.id === product.growsIngredientId,
  );
  const plantings = allOverviewPlantings(overview.data).filter(
    (planting) => planting.sourceProductId === product.id,
  );
  return (
    <Stack gap="sm">
      <p className="text-sm">
        Grows{" "}
        {ingredient ? (
          <EntityInlineLink
            entity="ingredient"
            displayImage={undefined}
            data={{ id: ingredient.id, name: ingredient.name }}
          />
        ) : options.isPending ? (
          "…"
        ) : (
          "an ingredient"
        )}
      </p>
      {plantings.length > 0 && (
        <Stack gap="xs">
          <Description size="xs">Plantings ({plantings.length})</Description>
          {plantings.slice(0, 5).map((planting) => (
            <EntityInlineLink
              key={planting.id}
              entity="planting"
              displayImage={undefined}
              data={{ id: planting.id, name: planting.displayName }}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};

/**
 * Where a planting has been and since when, with the confirm/correct-dates
 * dialog the panel owns.
 */
export const PlantingLocationHistory: DetailSlotComponent<"planting"> = ({
  record: planting,
}) => {
  const history = useQuery(
    garden.locationHistory.queryOptions({
      plantingId: plantingShortcode.parse(planting.id),
    }),
  );
  if (history.isPending) return <p>Loading location history…</p>;
  if (history.isError) {
    return (
      <Stack gap="sm">
        <p role="alert">
          Could not load location history: {getErrorMessage(history.error)}
        </p>
        <Button variant="outline" onClick={() => void history.refetch()}>
          Retry
        </Button>
      </Stack>
    );
  }
  return (
    <LocationHistoryPanel
      planting={planting}
      locationName={planting.locationName ?? undefined}
      periods={history.data.periods}
      onSaved={() => void history.refetch()}
    />
  );
};

/** The crop's local planting windows and sources, folded by default. */
export const PlantingGuide: DetailSlotComponent<"planting"> = ({
  record: planting,
}) => (
  <details>
    <summary className="cursor-pointer py-2 text-sm font-medium">
      View planting windows and sources
    </summary>
    <div className="pt-3">
      <GardenGuide guideKey={planting.gardenGuideKey ?? undefined} />
    </div>
  </details>
);
