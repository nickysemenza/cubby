import type { PlantingOut } from "@cubby/schemas/garden";
import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen, History, Sprout } from "lucide-react";
import { useState } from "react";

import { DetailSections } from "~/app/_components/data-table/detail-page";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailFor } from "~/entities/entity-detail.functions";

import { EntryForm } from "./entry-form";
import { GardenGuide } from "./garden-guide";
import { GardenTimeline } from "./garden-timeline";
import type { GardenLocation } from "./location-form";
import { PlantingLocationHistory } from "./location-history";
import {
  PlantingActionForm,
  plantingActionLabels,
  type PlantingAction,
} from "./planting-action-form";
import { PlantingForm } from "./planting-form";

type PlantingDialog = PlantingAction | "edit" | "entry";
type LocationLink = { id: LocationShortcode; name: string };
type ProductLink = { id: ProductShortcode; name: string };

function PlantingFacts({
  planting,
  cropName,
  location,
  source,
  intended,
}: {
  planting: PlantingOut;
  cropName: string;
  location?: LocationLink;
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
      <p className="text-sm">
        {location ? (
          <Link
            to="/locations/$shortcode"
            params={{ shortcode: location.id }}
            className="underline"
          >
            {location.name}
          </Link>
        ) : (
          "Location not yet chosen"
        )}
        {planting.quantity ? ` · ${planting.quantity}` : ""}
      </p>
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
        {planting.plannedDate && <p>Planned date: {planting.plannedDate}</p>}
        {planting.sowedOn && <p>Sowed: {planting.sowedOn}</p>}
        {planting.transplantedOn && (
          <p>Transplanted: {planting.transplantedOn}</p>
        )}
        {planting.finishedOn && <p>Finished: {planting.finishedOn}</p>}
        {planting.notes && (
          <p className="whitespace-pre-wrap">{planting.notes}</p>
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

function PlantingActions({
  planting,
  onOpen,
}: {
  planting: PlantingOut;
  onOpen: (dialog: PlantingDialog) => void;
}) {
  return (
    <Row gap="sm" wrap>
      {planting.status === "growing" && (
        <>
          <Button variant="outline" onClick={() => onOpen("move")}>
            Move everything
          </Button>
          <Button variant="outline" onClick={() => onOpen("split")}>
            Move some seedlings
          </Button>
        </>
      )}
      {planting.status !== "finished" && (
        <Button variant="outline" onClick={() => onOpen("finish")}>
          Finish planting
        </Button>
      )}
    </Row>
  );
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

export function PlantingDetail({
  planting,
  refresh,
}: {
  planting: PlantingOut;
  refresh: () => void;
}) {
  const [dialog, setDialog] = useState<PlantingDialog | null>(null);
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
  const onSaved = () => {
    setDialog(null);
    refresh();
  };
  const overview = (
    <Stack gap="md">
      <PlantingFacts
        planting={planting}
        cropName={crop.data?.name ?? "Planting"}
        location={location.data ?? undefined}
        source={source.data ?? undefined}
        intended={intended.data ?? undefined}
      />
      <PlantingActions planting={planting} onOpen={setDialog} />
    </Stack>
  );
  return (
    <>
      <Stack gap="md" className="mb-6">
        <Row gap="sm" align="center" wrap>
          <h2 className="text-lg font-semibold">
            {crop.data?.name ?? "Planting"}
            {planting.variety ? ` · ${planting.variety}` : ""}
          </h2>
          <Badge variant="secondary">{planting.status}</Badge>
        </Row>
        {location.data && (
          <Link
            to="/locations/$shortcode"
            params={{ shortcode: location.data.id }}
            className="text-sm underline"
          >
            {location.data.name}
          </Link>
        )}
        <Row gap="sm" wrap>
          {planting.locationId && (
            <Button onClick={() => setDialog("entry")}>
              Add photos / Log entry
            </Button>
          )}
          {planting.status === "planned" && (
            <Button onClick={() => setDialog("start")}>Start planting</Button>
          )}
          <Button variant="outline" onClick={() => setDialog("edit")}>
            Edit planting
          </Button>
          {planting.locationId && (
            <Link
              to="/garden-entries"
              search={{ locationId: planting.locationId }}
              className="content-center text-sm underline"
            >
              Bed journal
            </Link>
          )}
        </Row>
      </Stack>
      <DetailSections
        showEntityActions={false}
        rawData={planting}
        sections={[
          {
            id: "garden-history",
            title: "Journal",
            icon: History,
            placement: "primary",
            content: <GardenTimeline plantingId={planting.id} />,
          },
          {
            id: "overview",
            title: "Planting details",
            icon: Sprout,
            placement: "supporting",
            content: (
              <details>
                <summary className="cursor-pointer py-2 text-sm font-medium">
                  Dates, source, and planting actions
                </summary>
                <Stack gap="md" className="pt-3">
                  {overview}
                </Stack>
              </details>
            ),
          },
          {
            id: "location-history",
            title: "Location history",
            icon: History,
            placement: "supporting",
            content: <PlantingLocationHistory plantingId={planting.id} />,
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
    </>
  );
}
