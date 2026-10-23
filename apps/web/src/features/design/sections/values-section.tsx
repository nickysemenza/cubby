import { type ComponentProps, useState } from "react";

import { recordFilterOption } from "~/entity/filter-option-presentation";
import { GapChipCluster } from "~/entity/work-queue/work-queue-display";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { DateDisplay } from "~/ui/common/date-display";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { MiddleTruncate } from "~/ui/common/middle-truncate";
import { StackedValue } from "~/ui/common/stacked-value";
import { FilterBar } from "~/ui/data-table/filter-bar";
import type { Filter, FilterBarField } from "~/ui/data-table/filter-bar-core";
import { Row, Stack } from "~/ui/layout";
import { Panel } from "~/ui/layout/panel";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { Demo, DemoGrid } from "../components/design-section";
import { demoProducts } from "../data/samples";
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
  {
    key: "purchase",
    label: "Purchase",
    type: "multiselect",
    valueType: "entity",
    referenceEntity: "purchase",
    options: [
      recordFilterOption(
        "purchase",
        {
          id: "PUR-2222",
          label: "Autumn wardrobe",
          detail: "Example Apparel · Oct 12, 2026",
          count: 8,
        },
        demoProducts[0]?.images[0] ?? null,
      ),
      recordFilterOption(
        "purchase",
        {
          id: "PUR-3333",
          label: "Boots and care supplies",
          detail: "Example Outfitters · Sep 24, 2026",
          count: 3,
        },
        demoProducts[1]?.images[0] ?? null,
      ),
      recordFilterOption(
        "purchase",
        {
          id: "PUR-4444",
          label: "Replacement hardware",
          detail: "Example Hardware · Sep 18, 2026",
          count: 2,
        },
        null,
      ),
    ],
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
                  <EnumPill
                    key={option.value}
                    optionRole={option.role}
                    glyph={option.glyph}
                    color={option.color}
                  >
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
          name="<StackedValue />"
          note="A primary value and muted context within one table row."
        >
          <StackedValue
            primary="Sample oat milk"
            secondary="Fridge door · 2 cartons"
          />
        </Demo>
        <Demo
          name="<ChipCluster />"
          note="Bounded chip rows retain the first value and count overflow; hover +N to read the rest."
        >
          <div className="w-48 max-w-full">
            <ChipCluster
              lines={1}
              items={demoCategoryOptions.slice(0, 4).map((option) => ({
                key: option.value,
                label: option.label,
                node: <EnumPill icon={option.icon}>{option.label}</EnumPill>,
              }))}
            />
          </div>
        </Demo>
        <Demo
          name="<MiddleTruncate />"
          note="Long paths keep their tail; codes retain their first and last four characters."
        >
          <Stack gap="sm" className="w-48 max-w-full">
            <MiddleTruncate text="House / Kitchen / Pantry / Upper shelf" />
            <MiddleTruncate text="DEMO1234567890123456" code />
          </Stack>
        </Demo>
        <Demo
          name="<GapChipCluster gaps />"
          note="Work queue checks: one chip per failed check, two lines inside a 32px row, then +N with every message."
        >
          <Panel tone="default" className="w-64 px-1 py-1.5">
            <GapChipCluster gaps={demoGaps} />
          </Panel>
        </Demo>
        <Demo
          name="<FilterBar fields filters />"
          note="One focused editor from Filters, headers, or active chips. Record identity, context and facet counts stay separate; edits apply immediately."
          className="md:col-span-2"
        >
          <FilterBar
            fields={FILTER_FIELDS}
            filters={filters}
            onChange={setFilters}
            searchKey="q"
          />
        </Demo>
      </DemoGrid>
    </Stack>
  );
}
