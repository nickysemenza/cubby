import type { GardenEntryOut, GardenPlantingOut } from "@cubby/schemas/garden";
import type { GardenLocationKind } from "@cubby/schemas/garden-fields";
import type { IngredientWithFoodOut } from "@cubby/schemas/ingredient";
import type { InfLocation } from "@cubby/schemas/location";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sprout } from "lucide-react";
import { useState } from "react";

import { type DetailSection } from "~/app/_components/data-table/detail-page";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { householdDateTime } from "~/lib/household-date";

import { EntryForm } from "./entry-form";
import { GardenDialogFooterSlot } from "./garden-fields";
import { garden } from "./garden.functions";

/**
 * The seam between the garden domain and the three entity detail pages
 * (Location, Ingredient, Product) that otherwise stay entirely
 * inventory/product-shaped. Every export here is a section *builder* — a
 * plain function returning zero or one `DetailSection` — rather than a hook,
 * because it runs inline while a detail page assembles its `sections` array
 * (see `location-detail.tsx`), not inside a component body. Each builder's
 * own data fetching therefore lives in a small PascalCase content component
 * so `react/rules-of-hooks` still sees a real component calling the hooks.
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

/** "Sowed 2026-03-01" / "Transplanted …" / "Planned …" — same precedence
 * `garden-home.tsx`'s `PlantingRow` uses for a planting's most relevant date,
 * read here as "how long this planting has been in this bed." */
function plantingHereSince(planting: GardenPlantingOut): string | null {
  if (planting.transplantedOn) return `Transplanted ${planting.transplantedOn}`;
  if (planting.sowedOn) return `Sowed ${planting.sowedOn}`;
  if (planting.plannedDate) return `Planned ${planting.plannedDate}`;
  return null;
}

function entryKindLabel(kind: GardenEntryOut["kind"]): string {
  if (kind === "harvest") return "Harvest";
  if (kind === "move") return "Move";
  return "Observation";
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

function GardenRecentEntries({
  locationId,
}: {
  locationId: GardenLocationFields["id"];
}) {
  const entries = useQuery(
    garden.entries.queryOptions({ locationId, page: 1 }),
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
            {date} · {entryKindLabel(entry.kind)}
            {line ? ` · ${line}` : ""}
          </p>
        );
      })}
    </Stack>
  );
}

type GardenLocationFields = Pick<
  InfLocation,
  "id" | "name" | "gardenKind" | "gardenConditions"
>;

function LocationGardenSectionContent({
  location,
}: {
  location: GardenLocationFields;
}) {
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
}

/**
 * A bed/tray's Garden section — only present when `gardenKind` is set, so an
 * ordinary storage location stays entirely inventory-shaped (empty
 * compartment map, Sweep/Recount, no mention of the garden). `location-detail.tsx`
 * places this section *before* Contents/compartment-map/Recount in its
 * `sections` array so the garden leads the page; `DetailSections` has no
 * collapsible/`defaultOpen` flag, so demoting those inventory-first sections
 * means only reordering them after this one, not collapsing them.
 */
export function locationGardenSections(
  location: GardenLocationFields,
): DetailSection[] {
  if (!location.gardenKind) return [];
  return [
    {
      id: "garden",
      title: "Garden",
      icon: Sprout,
      placement: "primary",
      content: <LocationGardenSectionContent location={location} />,
    },
  ];
}

function GuideDisplayName({ guideKey }: { guideKey: string }) {
  const guides = useQuery(garden.guides.queryOptions(undefined));
  const name = guides.data?.guides.find(
    (candidate) => candidate.key === guideKey,
  )?.name;
  return <>{name ?? guideKey}</>;
}

type GardenIngredientFields = Pick<
  IngredientWithFoodOut,
  "id" | "gardenGuideKey"
>;

function IngredientGardenSectionContent({
  ingredient,
}: {
  ingredient: GardenIngredientFields;
}) {
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
}

/**
 * Read-only garden context for an Ingredient page: its guide key (resolved to
 * the guide's display name via the small `garden.guides` document) and any
 * plantings that grow it. Gated on `gardenGuideKey` alone — a plain array
 * builder runs outside a component and cannot call hooks, so it cannot know
 * whether `garden.overview` will turn up plantings before that query
 * resolves. `gardenGuideKey` is the synchronous signal that this ingredient
 * participates in the garden at all; plantings still render inside once the
 * overview loads.
 */
export function ingredientGardenSection(
  ingredient: GardenIngredientFields,
): DetailSection[] {
  if (!ingredient.gardenGuideKey) return [];
  return [
    {
      id: "garden",
      title: "Garden",
      icon: Sprout,
      placement: "supporting",
      content: <IngredientGardenSectionContent ingredient={ingredient} />,
    },
  ];
}

type GardenProductFields = Pick<ProductWithFoodOut, "id" | "growsIngredientId">;

function ProductGardenSectionContent({
  product,
}: {
  product: GardenProductFields;
}) {
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
}

/**
 * Read-only garden context for a Product page: what it grows (a seed packet
 * or starts product linked via `growsIngredientId`) and the plantings sourced
 * from it. Only present when `growsIngredientId` is set — every other
 * product's page stays entirely product-shaped.
 */
export function productGardenSection(
  product: GardenProductFields,
): DetailSection[] {
  if (!product.growsIngredientId) return [];
  return [
    {
      id: "garden",
      title: "Garden",
      icon: Sprout,
      placement: "supporting",
      content: <ProductGardenSectionContent product={product} />,
    },
  ];
}
