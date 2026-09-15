import type { PlantingOut } from "@cubby/schemas/planting";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { formatDateWithYear } from "~/app/projects/project-formatting";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";

import {
  GARDEN_DIALOG_FORM_ID,
  GardenDialogFooterSlot,
  GardenField,
  GardenFormActions,
} from "./garden-fields";
import { garden } from "./garden.functions";

/** The shape `PlantingDetail` loads once (via `garden.locationHistory`) and
 * passes down as `periods` — this component no longer queries on its own, so
 * a single load also feeds the journal's "confirm location dates" hint and
 * the top-level Actions menu's "Correct location dates" item. */
export type PlantingLocationPeriods = Awaited<
  ReturnType<typeof garden.locationHistory.call>
>["periods"];
type Periods = PlantingLocationPeriods;

function reviseBoundary(
  periods: Periods,
  sequence: number,
  boundary: "inLocationSince" | "endedOn",
  date: string,
): Periods {
  const index = periods.findIndex((period) => period.sequence === sequence);
  // A move closes one location and starts the next on the same calendar day.
  const neighbor = boundary === "inLocationSince" ? index - 1 : index + 1;
  const opposite =
    boundary === "inLocationSince" ? "endedOn" : "inLocationSince";
  return periods.map((period, position) => {
    if (position === index) return { ...period, [boundary]: date };
    if (position === neighbor) return { ...period, [opposite]: date };
    return period;
  });
}

function LocationDatesForm({
  plantingId,
  periods,
  onSaved,
  onCancel,
  correctLocationDates,
}: {
  plantingId: string;
  periods: Periods;
  onSaved: () => void;
  onCancel: () => void;
  correctLocationDates: typeof garden.correctLocationDates;
}) {
  const [dates, setDates] = useState(periods);
  const save = useMutation({
    ...correctLocationDates.mutationOptions(),
    meta: { invalidates: ripple.garden },
    onSuccess: onSaved,
  });
  return (
    <form
      id={GARDEN_DIALOG_FORM_ID}
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending) return;
        save.mutate(
          correctLocationDates.definition.input.parse({
            plantingId,
            periods: dates.map(({ sequence, inLocationSince, endedOn }) => ({
              sequence,
              inLocationSince,
              endedOn,
            })),
          }),
        );
      }}
    >
      <Stack gap="lg">
        <p className="text-sm text-muted-foreground">
          Record only dates you know. These dates determine which whole-area
          entries appear in this planting’s journal. They are separate from when
          seeds were sown.
        </p>
        {dates.map((period) => (
          <Stack key={period.sequence} gap="md">
            <Link
              to="/locations/$shortcode"
              params={{ shortcode: period.locationId }}
              className="font-medium underline"
            >
              {period.locationName}
            </Link>
            <GardenField
              label="In this location since"
              type="date"
              required
              disabled={save.isPending}
              value={period.inLocationSince}
              onChange={(value) =>
                setDates((current) =>
                  reviseBoundary(
                    current,
                    period.sequence,
                    "inLocationSince",
                    value,
                  ),
                )
              }
            />
            {period.endedOn !== null && (
              <GardenField
                label="Last day here"
                type="date"
                required
                disabled={save.isPending}
                value={period.endedOn}
                onChange={(value) =>
                  setDates((current) =>
                    reviseBoundary(current, period.sequence, "endedOn", value),
                  )
                }
              />
            )}
          </Stack>
        ))}
        <GardenFormActions
          pending={save.isPending}
          error={save.isError ? getErrorMessage(save.error) : null}
          onCancel={onCancel}
          label="Save location dates"
        />
      </Stack>
    </form>
  );
}

export function PlantingLocationHistory({
  planting,
  locationName,
  periods,
  correctLocationDates = garden.correctLocationDates,
  onSaved,
  open,
  onOpenChange,
}: {
  planting: PlantingOut;
  locationName?: string;
  /** Loaded by the caller (`PlantingDetail`) — see {@link PlantingLocationPeriods}. */
  periods: Periods;
  correctLocationDates?: typeof garden.correctLocationDates;
  /** Called after dates save, so the owner of the `periods` query can refetch it. */
  onSaved?: () => void;
  /**
   * Controlled dialog-open state, so the planting's top-level Actions menu
   * ("Correct location dates") can open the exact same dialog this
   * component's own button opens. Uncontrolled (a local `useState`) when
   * omitted, e.g. under test in isolation.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const plantingId = planting.id;
  const [internalEditing, setInternalEditing] = useState(false);
  const editing = open ?? internalEditing;
  const setEditing = onOpenChange ?? setInternalEditing;
  const canConfirm =
    planting.status !== "planned" && planting.locationId !== null;
  const initialPeriods: Periods =
    periods.length > 0
      ? periods
      : canConfirm && planting.locationId
        ? [
            {
              sequence: 0,
              locationId: planting.locationId,
              locationName: locationName ?? "Current location",
              inLocationSince: "",
              endedOn:
                planting.status === "finished"
                  ? (planting.finishedOn ?? "")
                  : null,
              startKind: "actual",
            },
          ]
        : [];
  const ctaLabel =
    periods.length > 0 ? "Correct location dates" : "Confirm location dates";
  return (
    <Stack gap="md">
      {periods.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {canConfirm
            ? "Earlier presence is unknown. Confirm when this planting was here to include matching whole-area entries."
            : "No confirmed location dates yet. Starting a planting records its first location."}
        </p>
      )}
      {periods.map((period) => (
        <Stack key={period.sequence} gap="xs">
          <Link
            to="/locations/$shortcode"
            params={{ shortcode: period.locationId }}
            className="text-sm font-medium underline"
          >
            {period.locationName}
          </Link>
          <p className="text-sm">
            {period.startKind === "recorded" ? "Recorded here " : "Here since "}
            {formatDateWithYear(period.inLocationSince)}
            {period.endedOn
              ? ` · Last day ${formatDateWithYear(period.endedOn)}`
              : " · Still here"}
          </p>
          {period.startKind === "recorded" && (
            <p className="text-sm text-muted-foreground">
              Earlier dates are unknown. Add a confirmed date to include older
              whole-area entries.
            </p>
          )}
        </Stack>
      ))}
      {initialPeriods.length > 0 && (
        <Row>
          <Button variant="outline" onClick={() => setEditing(true)}>
            {ctaLabel}
          </Button>
        </Row>
      )}
      {editing && (
        <ResponsiveDialog
          open
          title={ctaLabel}
          size="lg"
          onOpenChange={setEditing}
          footer={<GardenDialogFooterSlot />}
        >
          <LocationDatesForm
            plantingId={plantingId}
            periods={initialPeriods}
            correctLocationDates={correctLocationDates}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onSaved?.();
            }}
          />
        </ResponsiveDialog>
      )}
    </Stack>
  );
}
