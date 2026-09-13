import { plantingShortcode } from "@cubby/schemas/identifiers";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";

import { GardenField, GardenFormActions } from "./garden-fields";
import { garden } from "./garden.functions";

type Periods = Awaited<
  ReturnType<typeof garden.locationHistory.call>
>["periods"];

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
}: {
  plantingId: string;
  periods: Periods;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [dates, setDates] = useState(periods);
  const save = useMutation({
    ...garden.correctLocationDates.mutationOptions(),
    meta: { invalidates: ripple.garden },
    onSuccess: onSaved,
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending) return;
        save.mutate(
          garden.correctLocationDates.definition.input.parse({
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
          Record only dates you know. These dates determine which whole-bed
          photos appear in this planting’s journal. They are separate from when
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
  plantingId,
}: {
  plantingId: string;
}) {
  const history = useQuery(
    garden.locationHistory.queryOptions({
      plantingId: plantingShortcode.parse(plantingId),
    }),
  );
  const [editing, setEditing] = useState(false);
  if (history.isPending) return <p>Loading location history…</p>;
  if (history.isError)
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
  return (
    <Stack gap="md">
      {history.data.periods.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No confirmed location dates yet. Starting a planting records its first
          location.
        </p>
      )}
      {history.data.periods.map((period) => (
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
            {period.inLocationSince}
            {period.endedOn ? ` · Last day ${period.endedOn}` : " · Still here"}
          </p>
          {period.startKind === "recorded" && (
            <p className="text-sm text-muted-foreground">
              Earlier dates are unknown. Add a confirmed date to include older
              bed photos.
            </p>
          )}
        </Stack>
      ))}
      {history.data.periods.length > 0 && (
        <Row>
          <Button variant="outline" onClick={() => setEditing(true)}>
            Correct location dates
          </Button>
        </Row>
      )}
      {editing && (
        <ResponsiveDialog
          open
          title="Correct location dates"
          size="lg"
          onOpenChange={setEditing}
        >
          <LocationDatesForm
            plantingId={plantingId}
            periods={history.data.periods}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              void history.refetch();
            }}
          />
        </ResponsiveDialog>
      )}
    </Stack>
  );
}
