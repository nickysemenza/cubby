import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { plantingGuides } from "@cubby/schemas/garden-guides";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";

import type {
  ListSlotComponent,
  ListSlotProps,
} from "~/app/_components/entity-list/list-slot-types";
import {
  ScheduleGrid,
  type ScheduleRow,
} from "~/app/_components/schedule/schedule-grid";
import {
  usePlantingRecords,
  usePlantRecords,
} from "~/app/garden-workbench/garden-records";
import {
  plantingScheduleRows,
  yearWindow,
} from "~/app/garden-workbench/garden-schedule";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Button } from "~/components/ui/button";

function searchYear(value: ListSlotProps["search"]["year"]): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100
    ? parsed
    : new Date().getUTCFullYear();
}

function scheduleLabel(row: ScheduleRow) {
  if (row.id.startsWith("guide:")) {
    const sourceId = row.id.split(":")[2];
    const source = plantingGuides.sources.find(
      (entry) => entry.id === sourceId,
    );
    if (source)
      return (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline focus-visible:underline"
        >
          {source.name}
        </a>
      );
  }
  if (!row.id.startsWith("planting:")) return row.name;
  const shortcode = row.id.slice("planting:".length);
  return (
    <Link
      to="/plantings/$shortcode"
      params={{ shortcode }}
      className="text-primary hover:underline focus-visible:underline"
    >
      {row.name}
    </Link>
  );
}

function PlantingsScheduleSlot({ search, navigate }: ListSlotProps) {
  const year = searchYear(search.year);
  const plantingRead = usePlantingRecords();
  const plantRead = usePlantRecords();
  usePageCount(plantingRead.totalCount);
  const guideKeyByPlant = useMemo(
    () =>
      new Map(
        plantRead.records.map((plant) => [plant.id, plant.gardenGuideKey]),
      ),
    [plantRead.records],
  );
  const rows = useMemo(
    () => plantingScheduleRows(plantingRead.records, year, guideKeyByPlant),
    [plantingRead.records, year, guideKeyByPlant],
  );
  const window = useMemo(() => yearWindow(year), [year]);

  return (
    <Stack gap="md">
      <Row align="center" justify="between" className="flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold">Planting schedule</h2>
          <p className="text-xs text-muted-foreground">
            Grouped by current location. Recorded dates, expected harvests,
            cited recommendations, and free-text plans stay distinct.
          </p>
        </div>
        <Row align="center" gap="sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Previous year"
            disabled={year <= 2000}
            onClick={() => navigate({ year: year - 1 })}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="min-w-12 text-center text-sm tabular-nums">
            {year}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Next year"
            disabled={year >= 2100}
            onClick={() => navigate({ year: year + 1 })}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            render={<Link to="/garden-workbench" search={{ year }} />}
          >
            Garden workbench
          </Button>
        </Row>
      </Row>
      {plantingRead.error || plantRead.error ? (
        <ErrorDisplay
          error={plantingRead.error ?? plantRead.error}
          title="garden records"
          onRetry={() => {
            void plantingRead.refetch();
            void plantRead.refetch();
          }}
        />
      ) : plantingRead.isLoading || plantRead.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Loading the complete schedule… {plantingRead.records.length}
          {plantingRead.totalCount != null
            ? ` of ${plantingRead.totalCount}`
            : ""}{" "}
          plantings
        </p>
      ) : (
        <>
          <ScheduleGrid
            rows={rows}
            window={window}
            ariaLabel={`Planting schedule for ${year}`}
            renderLabel={scheduleLabel}
          />
        </>
      )}
    </Stack>
  );
}

export const plantingListSlots = {
  schedule: PlantingsScheduleSlot,
} satisfies Record<ListSlotId<"planting">, ListSlotComponent>;
