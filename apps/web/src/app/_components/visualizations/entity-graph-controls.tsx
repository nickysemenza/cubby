import { useId } from "react";

import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";

import type { GraphData, GraphFilters } from "./dependency-graph-model";

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
  return (
    <Stack gap="sm">
      <Row wrap gap="sm">
        {!recipes && (
          <NativeSelect
            aria-label="Record types"
            value={filters.workKind ?? "all"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "all" || value === "project" || value === "task")
                onChange({ workKind: value, focus: undefined });
            }}
          >
            <option value="all">Projects & tasks</option>
            <option value="project">Projects only</option>
            <option value="task">Tasks only</option>
          </NativeSelect>
        )}
        {!recipes && (
          <Row
            as="label"
            align="center"
            gap="sm"
            className="max-w-full min-w-0"
          >
            <span>Location</span>
            <NativeSelect
              className="min-w-0"
              value={
                filters.location === undefined
                  ? "all"
                  : `location:${filters.location}`
              }
              onChange={(event) =>
                onChange({
                  location:
                    event.target.value === "all"
                      ? undefined
                      : event.target.value.slice("location:".length),
                  focus: undefined,
                })
              }
            >
              <option value="all">All locations</option>
              <option value="location:">No location</option>
              {[...new Set(data.nodes.flatMap((node) => node.locations ?? []))]
                .sort()
                .map((location) => (
                  <option key={location} value={`location:${location}`}>
                    {location}
                  </option>
                ))}
            </NativeSelect>
          </Row>
        )}
        <Input
          aria-label="Find graph record"
          placeholder="Find a record by name or code…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          className="max-w-sm"
        />
        <NativeSelect
          className="max-w-full"
          aria-label="Focus record"
          value={filters.focus ?? ""}
          onChange={(event) =>
            onChange({ focus: event.target.value || undefined })
          }
        >
          <option value="">All records</option>
          {data.nodes
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
            .map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} ({node.id})
              </option>
            ))}
        </NativeSelect>
        <NativeSelect
          className="max-w-full"
          aria-label="Dependency direction"
          value={filters.direction}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === "all" ||
              value === "upstream" ||
              value === "downstream"
            )
              onChange({ direction: value });
          }}
        >
          <option value="all">Both directions</option>
          <option value="upstream">
            {recipes ? "Recipes using this" : "Blockers"}
          </option>
          <option value="downstream">
            {recipes ? "Used recipes" : "Blocked work"}
          </option>
        </NativeSelect>
      </Row>
      <Row wrap gap="md">
        {!recipes && (
          <Row
            as="label"
            align="center"
            gap="sm"
            className="max-w-full min-w-0"
          >
            <span>Group by</span>
            <NativeSelect
              className="min-w-0"
              value={
                filters.groupByLocation
                  ? filters.grouped
                    ? "both"
                    : "location"
                  : filters.grouped
                    ? "hierarchy"
                    : "none"
              }
              onChange={(event) =>
                onChange({
                  grouped:
                    event.target.value === "hierarchy" ||
                    event.target.value === "both",
                  groupByLocation:
                    event.target.value === "location" ||
                    event.target.value === "both",
                })
              }
            >
              <option value="hierarchy">Hierarchy</option>
              <option value="location">Location</option>
              <option value="both">Location & hierarchy</option>
              <option value="none">None</option>
            </NativeSelect>
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
