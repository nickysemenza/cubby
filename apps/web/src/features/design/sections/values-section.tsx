import { type ComponentProps, useState } from "react";

import { GapChipCluster } from "~/features/work-queue/work-queue-display";
import { DateDisplay } from "~/ui/common/date-display";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { FilterBar } from "~/ui/data-table/filter-bar";
import type { Filter, FilterBarField } from "~/ui/data-table/filter-bar-core";
import { ScopeChip } from "~/ui/data-table/scope-chip";
import { Row, Stack } from "~/ui/layout";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { Demo, DemoGrid } from "../components/design-section";
import {
  demoCategoryOptions,
  demoGaps,
  demoStatusOptions,
} from "../data/samples";

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

type DateDisplayProps = ComponentProps<typeof DateDisplay>;

const INSTANT = "2026-10-13T16:42:00Z";

const DATE_VARIANTS: [label: string, props: DateDisplayProps][] = [
  ["timestamp", { timestamp: INSTANT }],
  ["timestamp stacked", { timestamp: INSTANT, stacked: true }],
  ['clock="time"', { timestamp: INSTANT, clock: "time" }],
  ['clock="day"', { timestamp: INSTANT, clock: "day" }],
  ["start", { start: "2026-10-02" }],
  ["start · end", { start: "2026-09-28", end: "2026-10-04" }],
  ["another year", { start: "2025-03-14", stacked: true }],
];

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
          <Ledger as="dl" variant="facts">
            {DATE_VARIANTS.map(([label, props]) => (
              <LedgerRow as="div" key={label}>
                <LedgerCell as="dt" slot="primary">
                  <code className="font-mono text-2xs text-muted-foreground">
                    {label}
                  </code>
                </LedgerCell>
                <LedgerCell as="dd" slot="secondary">
                  <DateDisplay {...props} />
                </LedgerCell>
              </LedgerRow>
            ))}
          </Ledger>
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
