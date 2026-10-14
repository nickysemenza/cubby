import { parseShortcode } from "@cubby/shared";
import { useId, useMemo } from "react";

import { EntityIcon } from "~/entity/entities";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { Row, Stack } from "~/ui/layout";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";

import type { GraphData, GraphFilters } from "./dependency-graph-model";

/** Above this many locations a typed filter beats scanning the list. */
const CHOOSE_MODE_MAX = 12;

const WORK_KIND_OPTIONS: PickerOption[] = [
  { value: "all", label: "Projects & tasks" },
  { value: "project", label: "Projects only" },
  { value: "task", label: "Tasks only" },
];

const GROUP_BY_OPTIONS: PickerOption[] = [
  { value: "hierarchy", label: "Hierarchy" },
  { value: "location", label: "Location" },
  { value: "both", label: "Location & hierarchy" },
  { value: "none", label: "None" },
];

const RECIPE_DIRECTION_OPTIONS: PickerOption[] = [
  { value: "all", label: "Both directions" },
  { value: "upstream", label: "Recipes using this" },
  { value: "downstream", label: "Used recipes" },
];

const WORK_DIRECTION_OPTIONS: PickerOption[] = [
  { value: "all", label: "Both directions" },
  { value: "upstream", label: "Blockers" },
  { value: "downstream", label: "Blocked work" },
];

export function EntityGraphControls({
  data,
  filters,
  onChange,
  recipes,
  search,
  onSearch,
}: {
  data: GraphData;
  filters: GraphFilters;
  onChange: (patch: Partial<GraphFilters>) => void;
  recipes: boolean;
  search: string;
  onSearch: (value: string) => void;
}) {
  const id = useId();
  const locationOptions = useMemo(
    (): PickerOption[] => [
      { value: "all", label: "All locations" },
      { value: "location:", label: "No location" },
      ...[...new Set(data.nodes.flatMap((node) => node.locations ?? []))]
        .sort()
        .map((location) => ({
          value: `location:${location}`,
          label: location,
        })),
    ],
    [data.nodes],
  );
  const focusItems = useMemo(
    (): ComboboxItem[] =>
      data.nodes
        .filter(
          (node) =>
            !filters.workKind ||
            filters.workKind === "all" ||
            node.kind === filters.workKind,
        )
        .filter(
          (node) =>
            filters.location === undefined ||
            (filters.location === ""
              ? !node.locations?.length
              : node.locations?.includes(filters.location)),
        )
        .filter(
          (node) =>
            node.id === filters.focus ||
            `${node.name} ${node.id}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .map((node) => {
          // Graph nodes span entities, so each row's glyph follows its code.
          const entity = parseShortcode(node.id)?.type;
          return {
            id: node.id,
            shortcode: node.id,
            name: node.name,
            ...(node.kindLabel && { detail: node.kindLabel }),
            thumb: {
              imageUrl: node.imageUrl ?? null,
              fallback: entity ? (
                <EntityIcon entity={entity} size={14} colored />
              ) : null,
            },
          };
        }),
    [data.nodes, filters.workKind, filters.location, filters.focus, search],
  );
  return (
    <Stack gap="sm">
      <Row wrap gap="sm">
        {!recipes && (
          <Picker
            mode="choose"
            compact
            label="Record types"
            options={WORK_KIND_OPTIONS}
            value={filters.workKind ?? "all"}
            onValueChange={(value) => {
              if (value === "all" || value === "project" || value === "task")
                onChange({ workKind: value, focus: undefined });
            }}
          />
        )}
        {!recipes && (
          <Row align="center" gap="sm" className="max-w-full min-w-0">
            <span>Location</span>
            <Picker
              mode={
                locationOptions.length > CHOOSE_MODE_MAX ? "search" : "choose"
              }
              compact
              label="Location"
              className="min-w-0"
              options={locationOptions}
              value={
                filters.location === undefined
                  ? "all"
                  : `location:${filters.location}`
              }
              onValueChange={(value) => {
                if (value === null) return;
                onChange({
                  location:
                    value === "all"
                      ? undefined
                      : value.slice("location:".length),
                  focus: undefined,
                });
              }}
            />
          </Row>
        )}
        <Input
          aria-label="Find graph record"
          placeholder="Find a record by name or code…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          className="max-w-sm"
        />
        <Picker
          compact
          label="Focus record"
          className="w-56 max-w-full"
          placeholder="All records"
          clearable
          items={focusItems}
          value={focusItems.find((item) => item.id === filters.focus) ?? null}
          setValue={(item) => onChange({ focus: item?.id })}
        />
        <Picker
          mode="choose"
          compact
          label="Dependency direction"
          className="max-w-full"
          options={recipes ? RECIPE_DIRECTION_OPTIONS : WORK_DIRECTION_OPTIONS}
          value={filters.direction}
          onValueChange={(value) => {
            if (
              value === "all" ||
              value === "upstream" ||
              value === "downstream"
            )
              onChange({ direction: value });
          }}
        />
      </Row>
      <Row wrap gap="md">
        {!recipes && (
          <Row align="center" gap="sm" className="max-w-full min-w-0">
            <span>Group by</span>
            <Picker
              mode="choose"
              compact
              label="Group by"
              className="min-w-0"
              options={GROUP_BY_OPTIONS}
              value={
                filters.groupByLocation
                  ? filters.grouped
                    ? "both"
                    : "location"
                  : filters.grouped
                    ? "hierarchy"
                    : "none"
              }
              onValueChange={(value) =>
                onChange({
                  grouped: value === "hierarchy" || value === "both",
                  groupByLocation: value === "location" || value === "both",
                })
              }
            />
          </Row>
        )}
        {(
          [
            { key: "grouped", label: "Group by cookbook" },
            { key: "reduceEdges", label: "Hide redundant dependency edges" },
            recipes
              ? {
                  key: "hideUnconnected" as const,
                  label: "Hide unconnected recipes",
                }
              : { key: "hideCompleted" as const, label: "Hide completed work" },
          ] as const
        )
          .filter(({ key }) => recipes || key !== "grouped")
          .map(({ key, label }) => (
            <Row key={key} align="center" gap="sm">
              <Checkbox
                id={`${id}-${key}`}
                checked={filters[key]}
                onCheckedChange={(checked) =>
                  onChange({ [key]: checked === true })
                }
              />
              <label htmlFor={`${id}-${key}`} className="text-sm">
                {label}
              </label>
            </Row>
          ))}
      </Row>
    </Stack>
  );
}
