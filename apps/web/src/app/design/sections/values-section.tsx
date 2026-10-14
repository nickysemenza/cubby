import { useState } from "react";

import { GapChipCluster } from "~/features/work-queue/work-queue-display";
import { DateDisplay } from "~/ui/common/date-display";
import type { Filter, FilterBarField } from "~/ui/data-table/filter-bar-core";
import { FilterBar } from "~/ui/data-table/FilterBar";
import { ScopeChip } from "~/ui/data-table/ScopeChip";
import { Row, Stack } from "~/ui/layout";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { Demo, DemoGrid } from "../_components/design-section";
import {
  demoCategoryOptions,
  demoGaps,
  demoStatusOptions,
} from "../_data/samples";

const FILTER_FIELDS: FilterBarField[] = [
  { key: "q", label: "products", type: "text" },
  {
    key: "category",
    label: "Category",
    type: "multiselect",
    options: demoCategoryOptions,
  },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: demoStatusOptions.filter((option) => !option.meta),
  },
  { key: "location", label: "Location", type: "text" },
];

const INSTANT = "2026-10-13T16:42:00Z";

function DateRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border/60 py-1 text-xs first:border-t-0">
      <code className="font-mono text-2xs text-muted-foreground">{label}</code>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function ValuesSection() {
  const [filters, setFilters] = useState<Filter[]>([
    {
      id: "category",
      field: "category",
      operator: "is_any_of",
      values: ["dairy", "grains"],
    },
  ]);
  const [scopes, setScopes] = useState([
    { name: "Vendor", value: "Corner grocer" },
    { name: "Project", value: "Pantry refresh" },
  ]);
  return (
    <Stack gap="md">
      <DemoGrid>
        <Demo
          name="<DateDisplay />"
          note="One presentation for every record date: full outside tables, stacked and compact inside them."
        >
          <div>
            <DateRow label="timestamp">
              <DateDisplay timestamp={INSTANT} />
            </DateRow>
            <DateRow label="timestamp stacked">
              <DateDisplay timestamp={INSTANT} stacked />
            </DateRow>
            <DateRow label='clock="time"'>
              <DateDisplay timestamp={INSTANT} clock="time" />
            </DateRow>
            <DateRow label='clock="day"'>
              <DateDisplay timestamp={INSTANT} clock="day" />
            </DateRow>
            <DateRow label="start">
              <DateDisplay start="2026-10-02" />
            </DateRow>
            <DateRow label="start · end">
              <DateDisplay start="2026-09-28" end="2026-10-04" />
            </DateRow>
            <DateRow label="another year">
              <DateDisplay start="2025-03-14" stacked />
            </DateRow>
          </div>
        </Demo>
        <Demo
          name="<EnumPill color icon />"
          note="Status, enum and category values share one pill geometry; colour always comes with text."
        >
          <Stack gap="sm">
            <Row wrap gap="sm">
              {demoStatusOptions
                .filter((option) => !option.meta)
                .map((option) => (
                  <EnumPill key={option.value} color={option.color}>
                    {option.label}
                  </EnumPill>
                ))}
            </Row>
            <Row wrap gap="sm">
              {demoCategoryOptions.slice(0, 6).map((option) => (
                <EnumPill key={option.value} icon={option.icon}>
                  {option.label}
                </EnumPill>
              ))}
            </Row>
          </Stack>
        </Demo>
        <Demo
          name="<GapChipCluster gaps />"
          note="Work queue checks: one chip per failed check, two lines inside a 32px row, then +N with every message."
        >
          <div className="w-64 rounded-sm border px-1 py-1.5">
            <GapChipCluster gaps={demoGaps} />
          </div>
        </Demo>
        <Demo
          name="<FilterBar fields filters />"
          note="The manifest filter bar: a search field, one chip per declared filter, and Clear N."
          className="md:col-span-2"
        >
          <FilterBar
            fields={FILTER_FIELDS}
            filters={filters}
            onChange={setFilters}
            searchKey="q"
          />
        </Demo>
        <Demo
          name="<ScopeChip name value onClear />"
          note="URL-only scopes keep their own clearable chips."
        >
          <Row wrap gap="sm">
            {scopes.map((scope) => (
              <ScopeChip
                key={scope.name}
                name={scope.name}
                value={scope.value}
                onClear={() =>
                  setScopes((current) =>
                    current.filter((item) => item.name !== scope.name),
                  )
                }
              />
            ))}
          </Row>
        </Demo>
      </DemoGrid>
    </Stack>
  );
}
