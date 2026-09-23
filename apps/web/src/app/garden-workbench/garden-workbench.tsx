import { plantingGuides } from "@cubby/schemas/garden-guides";
import {
  type GardenCropKey,
  type GardenPracticeEntry,
  gardenCropKey,
  gardenCropKeys,
  gardenPractice,
  gardenPracticeSources,
} from "@cubby/schemas/garden-practice";
import { CalendarRange, ListChecks, Sprout } from "lucide-react";
import { useMemo } from "react";

import {
  ScheduleGrid,
  type ScheduleRow,
} from "~/app/_components/schedule/schedule-grid";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Stack } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ViewSwitcher } from "~/components/ui/view-switcher";

import { usePlantingRecords, usePlantRecords } from "./garden-records";
import {
  cropName,
  guideScheduleRows,
  plantingScheduleRows,
  yearWindow,
} from "./garden-schedule";
import { usePlantingScheduleLabel } from "./planting-schedule-label";

export type GardenMode = "timing" | "practice" | "plan";

const modes = [
  { value: "timing", label: "Timing", icon: CalendarRange },
  { value: "practice", label: "Practice", icon: ListChecks },
  { value: "plan", label: "Plan", icon: Sprout },
] as const;

const crops = [...gardenCropKeys].sort((a, b) =>
  cropName(a).localeCompare(cropName(b)),
);

const startLabels = {
  direct: "Direct sow",
  tray: "Start in trays",
  indoor: "Start indoors",
  bought: "Buy plants",
} as const;

function maturityText(maturity: GardenPracticeEntry["maturity"]) {
  if (!maturity) return "No estimate";
  const ranges = [
    maturity.fromSow &&
      `${maturity.fromSow[0]}–${maturity.fromSow[1]} days from sow`,
    maturity.fromTransplant &&
      `${maturity.fromTransplant[0]}–${maturity.fromTransplant[1]} days from transplant`,
  ].filter(Boolean);
  return ranges.join("; ") || "No estimate";
}

function MaturityBasis({ sourceId }: { sourceId: string | undefined }) {
  if (!sourceId) return null;
  if (sourceId === "estimate") return <>Household estimate</>;
  const source = gardenPracticeSources.find((entry) => entry.id === sourceId);
  return source ? (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="text-primary hover:underline"
    >
      {source.name}
    </a>
  ) : (
    <>{sourceId}</>
  );
}

function PracticeView({ crop }: { crop?: GardenCropKey }) {
  const selected = crop ? [crop] : crops;
  const rows = selected.map((key) => {
    const practice: GardenPracticeEntry = gardenPractice[key];
    return { key, practice };
  });
  return (
    <Stack gap="md">
      <div>
        <h2 className="text-base font-semibold">Household practice</h2>
        <p className="max-w-[75ch] text-sm text-muted-foreground">
          Start methods and succession intervals are household choices. Maturity
          ranges cite their own source or say when they are estimates.
        </p>
      </div>
      <div className="divide-y divide-border border-y border-border md:hidden">
        {rows.map(({ key, practice }) => (
          <div key={key} className="space-y-1 py-3 text-sm">
            <h3 className="font-semibold">{cropName(key)}</h3>
            <p>
              {practice.starts.map((start) => startLabels[start]).join(" · ")}
            </p>
            <p className="text-muted-foreground">
              {practice.successionWeeks
                ? `Succession every ${practice.successionWeeks} weeks`
                : "No succession interval"}
            </p>
            <p>{maturityText(practice.maturity)}</p>
            <p className="text-xs text-muted-foreground">
              <MaturityBasis sourceId={practice.maturity?.source} />
            </p>
          </div>
        ))}
      </div>
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[20%]">Crop</TableHead>
            <TableHead className="w-[22%]">Starts</TableHead>
            <TableHead className="w-[16%]">Succession</TableHead>
            <TableHead className="w-[27%]">First harvest</TableHead>
            <TableHead className="w-[15%]">Maturity basis</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ key, practice }) => (
            <TableRow key={key}>
              <TableCell className="font-medium">{cropName(key)}</TableCell>
              <TableCell className="whitespace-normal">
                {practice.starts.map((start) => startLabels[start]).join(" · ")}
              </TableCell>
              <TableCell>
                {practice.successionWeeks
                  ? `Every ${practice.successionWeeks} weeks`
                  : "—"}
              </TableCell>
              <TableCell className="whitespace-normal">
                {maturityText(practice.maturity)}
              </TableCell>
              <TableCell className="whitespace-normal">
                <MaturityBasis sourceId={practice.maturity?.source} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  );
}

function sourceFromRow(row: ScheduleRow) {
  if (!row.id.startsWith("guide:")) return undefined;
  const sourceId = row.id.split(":")[2];
  return plantingGuides.sources.find((source) => source.id === sourceId);
}

function SourceNotes({ rows }: { rows: readonly ScheduleRow[] }) {
  const sourceIds = new Set(
    rows.flatMap((row) => {
      const source = sourceFromRow(row);
      return source ? [source.id] : [];
    }),
  );
  const sources = plantingGuides.sources.filter((source) =>
    sourceIds.has(source.id),
  );
  if (sources.length === 0) return null;
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">Guide sources</h3>
      <ul className="space-y-2 text-xs text-muted-foreground">
        {sources.map((source) => (
          <li key={source.id}>
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {source.name}
            </a>
            {source.publishedOrRevised ? ` · ${source.publishedOrRevised}` : ""}
            {` · Reviewed ${source.reviewedAt}`}
            {source.basedOn.length > 0
              ? ` · Based on ${source.basedOn.join(", ")}`
              : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TimingView({ year, crop }: { year: number; crop?: GardenCropKey }) {
  const rows = useMemo(() => guideScheduleRows(year, crop), [year, crop]);
  const window = useMemo(() => yearWindow(year), [year]);
  const scheduleLabel = usePlantingScheduleLabel(rows, []);
  return (
    <Stack gap="md">
      <div>
        <h2 className="text-base font-semibold">Cited planting windows</h2>
        <p className="max-w-[75ch] text-sm text-muted-foreground">
          Each row preserves one source’s method, microclimate, and month or
          half-month precision. The year places recurring windows on an axis; it
          does not turn them into dated household plans.
        </p>
      </div>
      <ScheduleGrid
        rows={rows}
        window={window}
        ariaLabel={`Garden guide windows in ${year}`}
        renderLabel={scheduleLabel}
      />
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          This crop has no cited window for the sunny or Bay Area calendar. Its
          household practice is still available in Practice.
        </p>
      )}
      <SourceNotes rows={rows} />
    </Stack>
  );
}

function PlanView({
  year,
  crop,
  location,
  plantings,
  plants,
}: {
  year: number;
  crop?: GardenCropKey;
  location?: string;
  plantings: ReturnType<typeof usePlantingRecords>;
  plants: ReturnType<typeof usePlantRecords>;
}) {
  const rows = useMemo(() => {
    const keyByPlant = new Map(
      plants.records.map((plant) => [plant.id, plant.gardenGuideKey]),
    );
    const selected = plantings.records.filter(
      (planting) =>
        (!location || planting.locationId === location) &&
        (!crop || keyByPlant.get(planting.plantId) === crop),
    );
    const recorded = plantingScheduleRows(selected, year);
    const guideKeys = crop
      ? [crop]
      : [
          ...new Set(
            selected.flatMap((planting) => {
              const key = keyByPlant.get(planting.plantId);
              return key ? [key] : [];
            }),
          ),
        ];
    const guide = guideKeys.flatMap((key) => guideScheduleRows(year, key));
    return [
      ...(guide.length > 0
        ? [
            {
              id: "section:guide",
              name: "Cited guide windows",
              depth: 0,
              group: true,
              segments: [],
            } satisfies ScheduleRow,
            ...guide.map((row) => ({ ...row, depth: row.depth + 1 })),
          ]
        : []),
      {
        id: "section:recorded",
        name: "Household plantings by current location",
        depth: 0,
        group: true,
        segments: [],
      } satisfies ScheduleRow,
      ...recorded.map((row) => ({ ...row, depth: row.depth + 1 })),
    ];
  }, [crop, location, plantings.records, plants.records, year]);
  const window = useMemo(() => yearWindow(year), [year]);
  const scheduleLabel = usePlantingScheduleLabel(rows, plantings.records);
  const error = plantings.error ?? plants.error;
  return (
    <Stack gap="md">
      <div>
        <h2 className="text-base font-semibold">Plan comparison</h2>
        <p className="max-w-[75ch] text-sm text-muted-foreground">
          Guide windows are cited reference ranges. Sown, transplanted, and
          finished marks are recorded dates; harvest ranges are derived
          expectations. Free-text planned windows remain in the undated lane.
        </p>
      </div>
      {error ? (
        <ErrorDisplay
          error={error}
          title="garden records"
          onRetry={() => {
            void plantings.refetch();
            void plants.refetch();
          }}
        />
      ) : plantings.isLoading || plants.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Loading the complete comparison… {plantings.records.length}
          {plantings.totalCount != null
            ? ` of ${plantings.totalCount}`
            : ""}{" "}
          plantings, {plants.records.length}
          {plants.totalCount != null ? ` of ${plants.totalCount}` : ""} plants
        </p>
      ) : (
        <>
          <ScheduleGrid
            rows={rows}
            window={window}
            ariaLabel={`Garden plan comparison in ${year}`}
            renderLabel={scheduleLabel}
          />
          {!rows.some((row) => row.id.startsWith("planting:")) && (
            <p className="text-sm text-muted-foreground">
              No plantings with dates in {year} or undated plans match these
              filters.
            </p>
          )}
          <SourceNotes rows={rows} />
        </>
      )}
    </Stack>
  );
}

export function GardenWorkbench({
  mode,
  year,
  crop,
  location,
  onModeChange,
  onYearChange,
  onCropChange,
  onLocationChange,
}: {
  mode: GardenMode;
  year: number;
  crop?: GardenCropKey;
  location?: string;
  onModeChange: (mode: GardenMode) => void;
  onYearChange: (year: number) => void;
  onCropChange: (crop?: GardenCropKey) => void;
  onLocationChange: (location?: string) => void;
}) {
  const planActive = mode === "plan";
  const plantings = usePlantingRecords(planActive);
  const plants = usePlantRecords(planActive);
  const locations = useMemo(() => {
    const choices = new Map<string, string>();
    for (const planting of plantings.records) {
      if (planting.locationId)
        choices.set(
          planting.locationId,
          planting.locationName ?? planting.locationId,
        );
    }
    if (location && !choices.has(location)) choices.set(location, location);
    return [...choices.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [location, plantings.records]);
  const yearChoices = Array.from(
    { length: 7 },
    (_, index) => year - 3 + index,
  ).filter((choice) => choice >= 2000 && choice <= 2100);

  return (
    <Stack gap="lg">
      <div className="flex flex-wrap items-end gap-3 border-b border-border pb-3">
        <ViewSwitcher
          options={modes}
          value={mode}
          onValueChange={onModeChange}
          compactOnMobile
        />
        <label className="grid min-w-24 gap-1 text-xs text-muted-foreground">
          Year
          <NativeSelect
            value={year}
            onChange={(event) => onYearChange(Number(event.target.value))}
          >
            {yearChoices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid min-w-44 flex-1 gap-1 text-xs text-muted-foreground md:max-w-60">
          Crop
          <NativeSelect
            value={crop ?? ""}
            onChange={(event) => {
              const parsed = gardenCropKey.safeParse(event.target.value);
              onCropChange(parsed.success ? parsed.data : undefined);
            }}
          >
            <option value="">All crops</option>
            {crops.map((key) => (
              <option key={key} value={key}>
                {cropName(key)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid min-w-44 flex-1 gap-1 text-xs text-muted-foreground md:max-w-60">
          Current location
          <NativeSelect
            value={location ?? ""}
            disabled={!planActive}
            onChange={(event) =>
              onLocationChange(event.target.value || undefined)
            }
          >
            <option value="">All locations</option>
            {locations.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      {mode === "timing" ? (
        <TimingView year={year} crop={crop} />
      ) : mode === "practice" ? (
        <PracticeView crop={crop} />
      ) : (
        <PlanView
          year={year}
          crop={crop}
          location={location}
          plantings={plantings}
          plants={plants}
        />
      )}
    </Stack>
  );
}
