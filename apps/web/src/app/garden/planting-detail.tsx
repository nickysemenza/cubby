import type { PlantingOut } from "@cubby/schemas/garden";
import {
  plantingShortcode,
  type LocationShortcode,
  type ProductShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen, History, MoreHorizontal, Sprout } from "lucide-react";
import { useState } from "react";

import { DetailSections } from "~/app/_components/data-table/detail-page";
import { formatDateWithYear } from "~/app/projects/project-formatting";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { getErrorMessage } from "~/lib/error-utils";

import { EntryForm } from "./entry-form";
import { GardenDialogFooterSlot } from "./garden-fields";
import { GardenGuide } from "./garden-guide";
import { GardenTimeline } from "./garden-timeline";
import { garden } from "./garden.functions";
import type { GardenLocation } from "./location-form";
import {
  PlantingLocationHistory,
  type PlantingLocationPeriods,
} from "./location-history";
import {
  PlantingActionForm,
  plantingActionLabels,
  type PlantingAction,
} from "./planting-action-form";
import { PlantingForm } from "./planting-form";

type PlantingDialog = PlantingAction | "edit" | "entry";
type ProductLink = { id: ProductShortcode; name: string };
type LocationLink = { id: LocationShortcode; name: string };

function PlantingFacts({
  planting,
  cropName,
  source,
  intended,
}: {
  planting: PlantingOut;
  cropName: string;
  source?: ProductLink;
  intended?: LocationLink;
}) {
  return (
    <>
      <p className="text-sm">
        Crop:{" "}
        <Link
          to="/ingredients/$shortcode"
          params={{ shortcode: planting.ingredientId }}
          className="underline"
        >
          {cropName}
        </Link>
        {planting.variety ? ` · ${planting.variety}` : ""}
      </p>
      {planting.quantity && (
        <p className="text-sm">Quantity: {planting.quantity}</p>
      )}
      {source && (
        <p className="text-sm">
          Source:{" "}
          <Link
            to="/products/$shortcode"
            params={{ shortcode: source.id }}
            className="underline"
          >
            {source.name}
          </Link>
        </p>
      )}
      {intended && (
        <p className="text-sm">
          Intended destination:{" "}
          <Link
            to="/locations/$shortcode"
            params={{ shortcode: intended.id }}
            className="underline"
          >
            {intended.name}
          </Link>
        </p>
      )}
      <Stack gap="sm" className="text-sm">
        {planting.plannedWindow && (
          <p>Planned window: {planting.plannedWindow}</p>
        )}
        {planting.plannedDate && (
          <p>Planned date: {formatDateWithYear(planting.plannedDate)}</p>
        )}
        {planting.sowedOn && (
          <p>Sowed: {formatDateWithYear(planting.sowedOn)}</p>
        )}
        {planting.transplantedOn && (
          <p>Transplanted: {formatDateWithYear(planting.transplantedOn)}</p>
        )}
        {planting.finishedOn && (
          <p>Finished: {formatDateWithYear(planting.finishedOn)}</p>
        )}
        {planting.notes && (
          <p className="whitespace-pre-wrap">Notes: {planting.notes}</p>
        )}
      </Stack>
      {planting.parentPlantingId && (
        <Link
          to="/plantings/$shortcode"
          params={{ shortcode: planting.parentPlantingId }}
          className="text-sm underline"
        >
          Original tray planting
        </Link>
      )}
    </>
  );
}

/**
 * Mirrors `PlantingLocationHistory`'s own gating: offer the "confirm/correct
 * location dates" action once a period already exists, or the planting could
 * confirm its first one.
 */
function plantingLocationDatesState(
  hasConfirmedLocationPeriod: boolean,
  planting: PlantingOut,
) {
  return {
    canOfferLocationDates:
      hasConfirmedLocationPeriod ||
      (planting.status !== "planned" && planting.locationId !== null),
    locationDatesLabel: hasConfirmedLocationPeriod
      ? "Correct location dates"
      : "Confirm location dates",
  };
}

function plantingDialogTitle(dialog: PlantingDialog) {
  if (dialog === "edit") return "Edit planting";
  if (dialog === "entry") return "Log garden entry";
  return plantingActionLabels[dialog];
}

function PlantingDialogContent({
  dialog,
  planting,
  location,
  onSaved,
  onCancel,
}: {
  dialog: PlantingDialog;
  planting: PlantingOut;
  location?: GardenLocation;
  onSaved: () => void;
  onCancel: () => void;
}) {
  if (dialog === "edit")
    return (
      <PlantingForm
        planting={planting}
        location={location}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    );
  if (dialog === "entry")
    return planting.locationId ? (
      <EntryForm
        locationId={planting.locationId}
        plantingId={planting.id}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    ) : null;
  return (
    <PlantingActionForm
      planting={planting}
      action={dialog}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

/**
 * The planting's top action row. `Page`'s `heroActions` prop is how every
 * other detail page gets a primary + collapsing-secondary action cluster
 * (`page-hero.tsx`'s `DetailPlateActions`), but `PlantingDetail` is a body
 * component nested inside `plantings.$shortcode.tsx`'s own `<Page>` call —
 * that route (already rewritten onto `detailPage`) has no seam for a child
 * to contribute `heroActions` up to it. So this renders its own row using the
 * same visual contract instead: one primary `Button`, one outline `Button`,
 * and one `DropdownMenu` labeled "Actions" for the rest.
 */
function PlantingActionRow({
  planting,
  locationDatesLabel,
  canOfferLocationDates,
  onOpenDialog,
  onCorrectLocationDates,
}: {
  planting: PlantingOut;
  locationDatesLabel: string;
  canOfferLocationDates: boolean;
  onOpenDialog: (dialog: PlantingDialog) => void;
  onCorrectLocationDates: () => void;
}) {
  const primary =
    planting.status === "planned"
      ? { label: "Start planting", onClick: () => onOpenDialog("start") }
      : planting.locationId
        ? { label: "Log entry", onClick: () => onOpenDialog("entry") }
        : null;
  const moveItems =
    planting.status === "growing"
      ? [
          {
            id: "move",
            label: "Move everything",
            onClick: () => onOpenDialog("move"),
          },
          {
            id: "split",
            label: "Move some seedlings",
            onClick: () => onOpenDialog("split"),
          },
        ]
      : [];
  const dateItems = canOfferLocationDates
    ? [
        {
          id: "dates",
          label: locationDatesLabel,
          onClick: onCorrectLocationDates,
        },
      ]
    : [];
  const finishItems =
    planting.status !== "finished"
      ? [
          {
            id: "finish",
            label: "Finish planting",
            onClick: () => onOpenDialog("finish"),
          },
        ]
      : [];
  const leadingItems = [...moveItems, ...dateItems];
  return (
    <Row gap="sm" align="center" wrap>
      {primary && <Button onClick={primary.onClick}>{primary.label}</Button>}
      <Button variant="outline" onClick={() => onOpenDialog("edit")}>
        Edit
      </Button>
      {(leadingItems.length > 0 || finishItems.length > 0) && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" aria-label="Open planting actions" />
            }
          >
            <MoreHorizontal />
            Actions
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {leadingItems.map((item) => (
              <DropdownMenuItem key={item.id} onClick={item.onClick}>
                {item.label}
              </DropdownMenuItem>
            ))}
            {finishItems.length > 0 && (
              <>
                {leadingItems.length > 0 && <DropdownMenuSeparator />}
                {finishItems.map((item) => (
                  <DropdownMenuItem key={item.id} onClick={item.onClick}>
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </Row>
  );
}

/**
 * The "Location history" section's content: loading / error / loaded states
 * for the `history` query, pulled out of `PlantingDetail` so its branches
 * don't count against that component's complexity.
 */
function PlantingLocationHistorySection({
  isPending,
  isError,
  error,
  onRetry,
  planting,
  locationName,
  periods,
  correctingDates,
  onOpenChange,
  onSaved,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  planting: PlantingOut;
  locationName?: string;
  periods: PlantingLocationPeriods;
  correctingDates: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  if (isPending) return <p>Loading location history…</p>;
  if (isError) {
    return (
      <Stack gap="sm">
        <p role="alert">
          Could not load location history: {getErrorMessage(error)}
        </p>
        <Button variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </Stack>
    );
  }
  return (
    <PlantingLocationHistory
      planting={planting}
      locationName={locationName}
      periods={periods}
      open={correctingDates}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />
  );
}

/** The planting detail page body, including its `<Page>` shell. */
export function PlantingDetail({ record: planting }: { record: PlantingOut }) {
  const queryClient = useQueryClient();
  const refresh = () =>
    void invalidateOperationTags(queryClient, ripple.planting);
  const [dialog, setDialog] = useState<PlantingDialog | null>(null);
  const [correctingDates, setCorrectingDates] = useState(false);
  const crop = useQuery(
    entityDetailFor("ingredient").queryOptions(planting.ingredientId),
  );
  const location = useQuery(
    entityDetailFor("location").queryOptions(planting.locationId ?? "", {
      enabled: Boolean(planting.locationId),
    }),
  );
  const source = useQuery(
    entityDetailFor("product").queryOptions(planting.sourceProductId ?? "", {
      enabled: Boolean(planting.sourceProductId),
    }),
  );
  const intended = useQuery(
    entityDetailFor("location").queryOptions(
      planting.intendedLocationId ?? "",
      { enabled: Boolean(planting.intendedLocationId) },
    ),
  );
  // Loaded once here so it can feed three surfaces: the Actions menu's
  // "Confirm/Correct location dates" item, the Location history section's own
  // display, and the journal's "confirm this planting's location dates" hint.
  const history = useQuery(
    garden.locationHistory.queryOptions({
      plantingId: plantingShortcode.parse(planting.id),
    }),
  );
  const periods = history.data?.periods ?? [];
  const hasConfirmedLocationPeriod = periods.length > 0;
  const { canOfferLocationDates, locationDatesLabel } =
    plantingLocationDatesState(hasConfirmedLocationPeriod, planting);
  const cropName = crop.data?.name ?? "Planting";
  const onSaved = () => {
    setDialog(null);
    refresh();
  };
  return (
    <Page
      variant="detail"
      entity="planting"
      title={planting.displayName}
      rawData={planting}
      heroImages={planting.images}
      heroNo={planting.id}
    >
      <Stack gap="md" className="mb-6">
        {/* The page hero already carries the display name; this row is the
            status and the current growing area. */}
        <Row gap="sm" align="center" wrap>
          <Badge variant="secondary">{planting.status}</Badge>
          {location.data && (
            <Link
              to="/locations/$shortcode"
              params={{ shortcode: location.data.id }}
              className="text-sm underline"
            >
              {location.data.name}
            </Link>
          )}
        </Row>
        <PlantingActionRow
          planting={planting}
          locationDatesLabel={locationDatesLabel}
          canOfferLocationDates={canOfferLocationDates}
          onOpenDialog={setDialog}
          onCorrectLocationDates={() => setCorrectingDates(true)}
        />
        {planting.locationId && (
          <Link
            to="/garden-entries"
            search={{ locationId: planting.locationId }}
            className="content-center text-sm underline"
          >
            {location.data ? `${location.data.name} journal` : "Area journal"}
          </Link>
        )}
      </Stack>
      <DetailSections
        showEntityActions={false}
        rawData={planting}
        heroImages={planting.images}
        sections={[
          {
            id: "garden-history",
            title: "Journal",
            icon: History,
            placement: "primary",
            content: (
              <GardenTimeline
                plantingId={planting.id}
                hasConfirmedLocationPeriod={hasConfirmedLocationPeriod}
              />
            ),
          },
          {
            id: "overview",
            title: "Planting details",
            icon: Sprout,
            placement: "supporting",
            content: (
              <PlantingFacts
                planting={planting}
                cropName={cropName}
                source={source.data ?? undefined}
                intended={intended.data ?? undefined}
              />
            ),
          },
          {
            id: "location-history",
            title: "Location history",
            icon: History,
            placement: "supporting",
            content: (
              <PlantingLocationHistorySection
                isPending={history.isPending}
                isError={history.isError}
                error={history.error}
                onRetry={() => void history.refetch()}
                planting={planting}
                locationName={location.data?.name}
                periods={periods}
                correctingDates={correctingDates}
                onOpenChange={setCorrectingDates}
                onSaved={() => void history.refetch()}
              />
            ),
          },
          {
            id: "planting-guide",
            title: "Local planting guide",
            icon: BookOpen,
            placement: "supporting",
            content: (
              <details>
                <summary className="cursor-pointer py-2 text-sm font-medium">
                  View planting windows and sources
                </summary>
                <div className="pt-3">
                  <GardenGuide guideKey={crop.data?.gardenGuideKey} />
                </div>
              </details>
            ),
          },
        ]}
      />
      {dialog && (
        <ResponsiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title={plantingDialogTitle(dialog)}
          size="lg"
          footer={<GardenDialogFooterSlot />}
        >
          <PlantingDialogContent
            dialog={dialog}
            planting={planting}
            location={location.data ?? undefined}
            onSaved={onSaved}
            onCancel={() => setDialog(null)}
          />
        </ResponsiveDialog>
      )}
    </Page>
  );
}
