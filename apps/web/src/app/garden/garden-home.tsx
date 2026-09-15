import {
  gardenFinishPlantingInput,
  type gardenPlantingOut,
} from "@cubby/schemas/garden";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { z } from "zod";

import { formatDate } from "~/app/projects/project-formatting";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { getErrorMessage } from "~/lib/error-utils";
import { householdLocalDate } from "~/lib/household-date";
import { countLabel } from "~/lib/pluralize";
import { cn } from "~/lib/utils";

import { EntryForm } from "./entry-form";
import {
  GARDEN_DIALOG_FORM_ID,
  GardenDialogFooterSlot,
  GardenField,
  GardenFormActions,
  GardenNotes,
} from "./garden-fields";
import { gardenStrings } from "./garden-strings";
import { garden } from "./garden.functions";
import { GardenLocationForm, type GardenLocation } from "./location-form";
import { PlantingForm } from "./planting-form";

type OverviewPlanting = z.infer<typeof gardenPlantingOut>;
const plantingStateLabel = {
  growing: gardenStrings.planting.stateGrowing,
  planned: gardenStrings.planting.statePlanned,
  finished: gardenStrings.planting.stateFinished,
} as const;
type HomeDialog =
  | { kind: "location"; location?: GardenLocation }
  | { kind: "planting"; location?: GardenLocation }
  | { kind: "entry"; location: GardenLocation }
  | { kind: "finish"; plantings: OverviewPlanting[] };

const productionHomeOperations = {
  overview: garden.overview,
  finishPlanting: garden.finishPlanting,
};

function FinishSelected({
  plantings,
  onSaved,
  onCancel,
  finishPlanting = garden.finishPlanting,
}: {
  plantings: OverviewPlanting[];
  onSaved: () => void;
  onCancel: () => void;
  finishPlanting?: typeof garden.finishPlanting;
}) {
  const [date, setDate] = useState(householdLocalDate);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Persists across a retry so a resubmit only reattempts plantings that
  // actually failed, rather than re-finishing ones that already succeeded.
  const [completed] = useState(() => new Set<string>());
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const failed: string[] = [];
      // Every planting is attempted — a mid-batch failure no longer aborts
      // the rest — and the per-item outcomes are aggregated into one report.
      for (const planting of plantings) {
        if (completed.has(planting.id)) continue;
        try {
          await finishPlanting.call(
            gardenFinishPlantingInput.parse({
              plantingId: planting.id,
              finishedOn: date,
              note: note.trim() || null,
            }),
          );
          completed.add(planting.id);
        } catch {
          failed.push(planting.ingredientName);
        }
      }
      if (failed.length > 0)
        throw new Error(
          `${gardenStrings.home.finishPartialReport(
            countLabel(completed.size, "planting"),
            countLabel(plantings.length, "planting"),
          )} Couldn't finish: ${failed.join(", ")}.`,
        );
    },
    onSuccess: onSaved,
    onError: (error) => setError(getErrorMessage(error)),
  });
  return (
    <form
      id={GARDEN_DIALOG_FORM_ID}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <Stack gap="lg">
        <GardenField
          label={gardenStrings.planting.dateField}
          value={date}
          onChange={setDate}
          type="date"
          required
        />
        <GardenNotes value={note} onChange={setNote} />
        <p className="text-sm text-muted-foreground">
          {gardenStrings.planting.finishExplanation}
        </p>
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
          label={gardenStrings.home.finishSubmit(
            countLabel(plantings.length, "planting"),
          )}
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
            planting.transplantedOn
              ? `Transplanted ${formatDate(planting.transplantedOn)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Dates not recorded"}
        </p>
      </Stack>
      <Badge variant="secondary">{plantingStateLabel[planting.status]}</Badge>
    </Row>
  );
}

function homeDialogTitle(dialog: HomeDialog | null) {
  const dialogTitle =
    dialog?.kind === "location"
      ? dialog.location
        ? gardenStrings.location.editTitle
        : gardenStrings.location.addTitle
      : dialog?.kind === "planting"
        ? gardenStrings.planting.addTitle
        : dialog?.kind === "entry"
          ? gardenStrings.home.logEntry
          : dialog?.kind === "finish"
            ? gardenStrings.home.finishDialogTitle
            : "Location history";
  return dialogTitle;
}

export function GardenHome({
  operations = productionHomeOperations,
}: {
  operations?: typeof productionHomeOperations;
}) {
  const queryClient = useQueryClient();
  const overview = useQuery(operations.overview.queryOptions(undefined));
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
          {gardenStrings.home.loadFailed}: {getErrorMessage(overview.error)}
        </p>
        <Button onClick={() => void overview.refetch()}>
          {gardenStrings.common.retry}
        </Button>
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
          {gardenStrings.home.addPlanting}
        </Button>
        <Button
          variant="outline"
          onClick={() => setDialog({ kind: "location" })}
        >
          {gardenStrings.home.addLocation}
        </Button>
        {selectedPlantings.length > 0 && (
          <Button
            variant="outline"
            onClick={() =>
              setDialog({ kind: "finish", plantings: selectedPlantings })
            }
          >
            {gardenStrings.home.finishSelected(selectedPlantings.length)}
          </Button>
        )}
        <Link
          to="/garden-entries"
          className={cn(
            buttonVariants({ variant: "ghost" }),
            "max-sm:min-h-11",
          )}
        >
          {gardenStrings.home.allEntries}
        </Link>
      </Row>
      {overview.data.locations.length === 0 && (
        <Stack gap="md">
          <h2 className="text-lg font-semibold">
            {gardenStrings.home.emptyTitle}
          </h2>
          <p>{gardenStrings.home.emptyBody}</p>
        </Stack>
      )}
      {overview.data.locations.map((location) => (
        <Card key={location.id} className="p-4">
          <Stack gap="md">
            <Row gap="sm" justify="between" align="center" wrap>
              <h2 className="text-lg font-semibold">
                <Link
                  to="/locations/$shortcode"
                  params={{ shortcode: location.id }}
                  className="flex min-h-11 items-center hover:underline max-sm:min-h-11"
                >
                  {location.name}
                </Link>
              </h2>
              <Badge variant="secondary">
                {location.gardenKind
                  ? gardenStrings.location.kindLabel[location.gardenKind]
                  : gardenStrings.location.kindField}
              </Badge>
            </Row>
            {location.gardenConditions && (
              <p className="text-sm text-muted-foreground">
                {location.gardenConditions}
              </p>
            )}
            {location.plantings.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {gardenStrings.home.noPlantingsInLocation}
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
                {gardenStrings.home.addPlanting}
              </Button>
              <Button
                variant="outline"
                onClick={() => setDialog({ kind: "entry", location })}
              >
                {gardenStrings.home.logEntry}
              </Button>
              <Link
                to="/garden-entries"
                search={{ locationId: location.id }}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "max-sm:min-h-11",
                )}
              >
                {gardenStrings.home.bedJournal}
              </Link>
              <Button
                variant="ghost"
                onClick={() => setDialog({ kind: "location", location })}
              >
                {gardenStrings.home.editConditions}
              </Button>
            </Row>
          </Stack>
        </Card>
      ))}
      {overview.data.unassigned.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">
            {gardenStrings.location.noLocationYet}
          </h2>
          {overview.data.unassigned.map((planting) => (
            <PlantingRow key={planting.id} planting={planting} />
          ))}
        </section>
      )}
      {overview.data.finished.length > 0 && (
        <details>
          <summary className="cursor-pointer py-3 font-medium">
            {gardenStrings.home.finishedPlantingsSummary(
              overview.data.finished.length,
            )}
          </summary>
          {overview.data.finished.map((planting) => (
            <PlantingRow key={planting.id} planting={planting} />
          ))}
        </details>
      )}
      {dialog && (
        <ResponsiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title={dialogTitle}
          size="lg"
          footer={<GardenDialogFooterSlot />}
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
          {dialog.kind === "finish" && (
            <FinishSelected
              plantings={dialog.plantings}
              onSaved={onSaved}
              onCancel={() => setDialog(null)}
              finishPlanting={operations.finishPlanting}
            />
          )}
        </ResponsiveDialog>
      )}
    </Stack>
  );
}
