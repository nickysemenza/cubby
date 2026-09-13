import {
  gardenFinishPlantingInput,
  type gardenPlantingOut,
} from "@cubby/schemas/garden";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { z } from "zod";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { getErrorMessage } from "~/lib/error-utils";
import { householdLocalDate } from "~/lib/household-date";

import { EntryForm } from "./entry-form";
import { GardenField, GardenFormActions } from "./garden-fields";
import { GardenTimeline } from "./garden-timeline";
import { garden } from "./garden.functions";
import { GardenLocationForm, type GardenLocation } from "./location-form";
import { PlantingForm } from "./planting-form";

type OverviewPlanting = z.infer<typeof gardenPlantingOut>;
type HomeDialog =
  | { kind: "location"; location?: GardenLocation }
  | { kind: "planting"; location?: GardenLocation }
  | { kind: "entry"; location: GardenLocation }
  | { kind: "history"; location: GardenLocation }
  | { kind: "finish"; plantings: OverviewPlanting[] };

function FinishSelected({
  plantings,
  onSaved,
  onCancel,
}: {
  plantings: OverviewPlanting[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(householdLocalDate);
  const [error, setError] = useState<string | null>(null);
  const [completed] = useState(() => new Set<string>());
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      for (const planting of plantings) {
        if (completed.has(planting.id)) continue;
        await garden.finishPlanting.call(
          gardenFinishPlantingInput.parse({
            plantingId: planting.id,
            finishedOn: date,
          }),
        );
        completed.add(planting.id);
      }
    },
    onSuccess: onSaved,
    onError: (error) => setError(getErrorMessage(error)),
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Stack gap="lg">
        <p>
          Finish{" "}
          {plantings.map((planting) => planting.ingredientName).join(", ")}.
          Other plantings stay active.
        </p>
        <GardenField
          label="Finished on"
          value={date}
          onChange={setDate}
          type="date"
          required
        />
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
          label={`Finish ${plantings.length} plantings`}
        />
      </Stack>
    </form>
  );
}

function PlantingRow({
  planting,
  selected,
  onSelect,
}: {
  planting: OverviewPlanting;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
}) {
  return (
    <Row gap="md" align="center" className="border-b py-3">
      {onSelect && (
        <label className="flex size-11 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            aria-label={`Select ${planting.ingredientName}${planting.variety ? ` ${planting.variety}` : ""}`}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
        </label>
      )}
      <Stack gap="xs" className="min-w-0 flex-1">
        <Link
          to="/plantings/$shortcode"
          params={{ shortcode: planting.id }}
          className="min-h-11 content-center font-medium hover:underline"
        >
          {planting.ingredientName}
          {planting.variety ? ` · ${planting.variety}` : ""}
        </Link>
        <p className="text-sm text-muted-foreground">
          {[
            planting.quantity,
            planting.plannedWindow,
            planting.status === "planned"
              ? planting.plannedDate
              : planting.sowedOn
                ? `Sowed ${planting.sowedOn}`
                : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Dates not recorded"}
        </p>
      </Stack>
      <Badge variant="secondary">{planting.status}</Badge>
    </Row>
  );
}

function homeDialogTitle(dialog: HomeDialog | null) {
  const dialogTitle =
    dialog?.kind === "location"
      ? "Garden location"
      : dialog?.kind === "planting"
        ? "Add planting"
        : dialog?.kind === "entry"
          ? "Log an entry"
          : dialog?.kind === "finish"
            ? "Finish selected plantings"
            : "Location history";
  return dialogTitle;
}

export function GardenHome() {
  const queryClient = useQueryClient();
  const overview = useQuery(garden.overview.queryOptions(undefined));
  const [dialog, setDialog] = useState<HomeDialog | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const onSaved = () => {
    setDialog(null);
    setSelected([]);
    void invalidateOperationTags(queryClient, ripple.garden);
  };
  if (overview.isPending) return <p>Loading garden…</p>;
  if (overview.isError)
    return (
      <Stack gap="md">
        <p role="alert">
          Could not load the garden: {getErrorMessage(overview.error)}
        </p>
        <Button onClick={() => void overview.refetch()}>Retry</Button>
      </Stack>
    );
  const selectedPlantings = overview.data.locations
    .flatMap((location) => location.plantings)
    .filter((planting) => selected.includes(planting.id));
  const dialogTitle = homeDialogTitle(dialog);
  return (
    <Stack gap="lg">
      <Row gap="sm" wrap>
        <Button onClick={() => setDialog({ kind: "planting" })}>
          Add planting
        </Button>
        <Button
          variant="outline"
          onClick={() => setDialog({ kind: "location" })}
        >
          Add bed or tray
        </Button>
        {selectedPlantings.length > 0 && (
          <Button
            variant="outline"
            onClick={() =>
              setDialog({ kind: "finish", plantings: selectedPlantings })
            }
          >
            Finish selected ({selectedPlantings.length})
          </Button>
        )}
      </Row>
      {overview.data.locations.length === 0 && (
        <Stack gap="md">
          <h2 className="text-lg font-semibold">
            Start with what’s growing today
          </h2>
          <p>
            Add a bed, tray, or growing area, then record your crops. Leave
            unknown dates blank.
          </p>
        </Stack>
      )}
      {overview.data.unassigned.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Location to choose</h2>
          {overview.data.unassigned.map((planting) => (
            <PlantingRow key={planting.id} planting={planting} />
          ))}
        </section>
      )}
      {overview.data.locations.map((location) => (
        <section key={location.id} className="rounded-lg border bg-card p-4">
          <Stack gap="md">
            <Row gap="sm" justify="between" align="center" wrap>
              <h2 className="text-lg font-semibold">
                <Link
                  to="/locations/$shortcode"
                  params={{ shortcode: location.id }}
                  className="hover:underline"
                >
                  {location.name}
                </Link>
              </h2>
              <Badge variant="secondary">
                {location.gardenKind ?? "Growing area"}
              </Badge>
            </Row>
            {location.gardenConditions && (
              <p className="text-sm text-muted-foreground">
                {location.gardenConditions}
              </p>
            )}
            {location.plantings.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No current or planned plantings.
              </p>
            ) : (
              <div>
                {location.plantings.map((planting) => (
                  <PlantingRow
                    key={planting.id}
                    planting={planting}
                    selected={selected.includes(planting.id)}
                    onSelect={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...current, planting.id]
                          : current.filter((id) => id !== planting.id),
                      )
                    }
                  />
                ))}
              </div>
            )}
            <Row gap="sm" wrap>
              <Button
                variant="outline"
                onClick={() => setDialog({ kind: "planting", location })}
              >
                Add planting
              </Button>
              <Button
                variant="outline"
                onClick={() => setDialog({ kind: "entry", location })}
              >
                Note, photos, or harvest
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDialog({ kind: "history", location })}
              >
                History
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDialog({ kind: "location", location })}
              >
                Edit conditions
              </Button>
            </Row>
          </Stack>
        </section>
      ))}
      <details>
        <summary className="cursor-pointer py-3 font-medium">
          Finished plantings ({overview.data.finished.length})
        </summary>
        {overview.data.finished.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Finished plantings will stay here with their history.
          </p>
        ) : (
          overview.data.finished.map((planting) => (
            <PlantingRow key={planting.id} planting={planting} />
          ))
        )}
      </details>
      {dialog && (
        <ResponsiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title={dialogTitle}
          size="lg"
        >
          {dialog.kind === "location" && (
            <GardenLocationForm
              location={dialog.location}
              onSaved={onSaved}
              onCancel={() => setDialog(null)}
            />
          )}
          {dialog.kind === "planting" && (
            <PlantingForm
              location={dialog.location}
              onSaved={onSaved}
              onCancel={() => setDialog(null)}
            />
          )}
          {dialog.kind === "entry" && (
            <EntryForm
              locationId={dialog.location.id}
              onSaved={onSaved}
              onCancel={() => setDialog(null)}
            />
          )}
          {dialog.kind === "history" && (
            <GardenTimeline locationId={dialog.location.id} />
          )}
          {dialog.kind === "finish" && (
            <FinishSelected
              plantings={dialog.plantings}
              onSaved={onSaved}
              onCancel={() => setDialog(null)}
            />
          )}
        </ResponsiveDialog>
      )}
    </Stack>
  );
}
