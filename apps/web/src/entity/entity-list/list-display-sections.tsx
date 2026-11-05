import {
  listPresentationLabel,
  listViewId,
} from "@cubby/schemas/entity-definitions/definition";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { ListGroupBy } from "@cubby/schemas/pagination";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GridFourIcon } from "@phosphor-icons/react/dist/csr/GridFour";
import { GridNineIcon } from "@phosphor-icons/react/dist/csr/GridNine";
import { IntersectSquareIcon } from "@phosphor-icons/react/dist/csr/IntersectSquare";
import { RowsIcon } from "@phosphor-icons/react/dist/csr/Rows";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import type { Icon } from "@phosphor-icons/react/lib";
import { useQueryClient } from "@tanstack/react-query";

import { entities } from "~/entity/entities";
import { useEntityMetadata } from "~/entity/metadata";
import { DisplayRow } from "~/entity/table/display-menu";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Button } from "~/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
  DropdownMenuSubmenuContent,
} from "~/ui/shadcn/dropdown-menu";

import { listGroupBy, PIVOT_VIEW_ID, pivotAvailable } from "./list-grouping";
import { useEntityListCardDensity, useListSearch } from "./list-search";
import { resolveListView } from "./resolve-list-view";

const VIEW_ICONS = {
  table: TableIcon,
  shelf: GridFourIcon,
  timeline: CalendarCheckIcon,
} satisfies Record<"table" | "shelf" | "timeline", Icon>;

const TIMELINE_GROUP_REASON = "This view is already arranged by date.";

/** A hierarchy level's menu label: 1 is the top level. */
const groupLevelLabel = (level: number) =>
  level === 1 ? "Top level" : `Level ${level}`;

/**
 * The presentation menu: the manifest's list views (Table, Cards, Compact,
 * Timeline, Board).
 */
function ListViewMenu({ entity }: { entity: BrowserRoutedEntity }) {
  const { search, navigate } = useListSearch();
  const { density, setDensity } = useEntityListCardDensity();
  const { views, view } = resolveListView(useQueryClient(), entity, search);
  const grouping = useEntityMetadata(entity).listFields.grouping;
  const isMobile = useIsMobile();
  // Pivot is built in on desktop wherever two choices can group.
  const pivot = !isMobile && pivotAvailable(grouping);
  if (views.length < 2 && !pivot) return null;
  const dimensions = listGroupBy(search) ?? [];
  const pivotReason =
    dimensions.length < 2
      ? "Group by two fields first: rows, then columns."
      : null;
  const declared = views.flatMap((candidate) => {
    const id = listViewId(candidate);
    const choice = {
      value: id,
      label:
        typeof candidate === "object"
          ? candidate.label
          : (listPresentationLabel(candidate) ?? "Timeline"),
      icon: typeof candidate === "object" ? undefined : VIEW_ICONS[candidate],
    };
    return candidate === "shelf"
      ? [
          choice,
          {
            value: "compact",
            label: listPresentationLabel("compact") ?? "Compact",
            icon: GridNineIcon,
          },
        ]
      : [choice];
  });
  const options: {
    value: string;
    label: string;
    icon?: Icon;
    reason?: string | null;
  }[] = [
    ...declared,
    ...(pivot
      ? [
          {
            value: PIVOT_VIEW_ID,
            label: "Pivot",
            icon: IntersectSquareIcon,
            reason: pivotReason,
          },
        ]
      : []),
  ];
  const defaultView = listViewId(views[0] ?? "table");
  const selected =
    pivot && search.view === PIVOT_VIEW_ID
      ? PIVOT_VIEW_ID
      : view === "shelf" && density === "compact"
        ? "compact"
        : listViewId(view);
  const selectedOption = options.find((option) => option.value === selected);
  const onValueChange = (next: string) => {
    if (next === "compact") {
      setDensity("compact");
      navigate({ view: "shelf" });
      return;
    }
    setDensity("cards");
    navigate({ view: next === defaultView ? undefined : next });
  };
  const SelectedIcon = selectedOption?.icon;
  const viewLabel = selectedOption?.label ?? selected;
  return (
    <DisplayRow label="Layout">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-(--input-height) text-sm"
              aria-label={`${entities[entity].pluralLabel} view: ${viewLabel}`}
            />
          }
        >
          {SelectedIcon && <SelectedIcon className="size-3.5" />}
          {viewLabel}
          <CaretDownIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              aria-label={`${option.label} view`}
              aria-current={option.value === selected ? "true" : undefined}
              disabled={Boolean(option.reason)}
              title={option.reason ?? undefined}
              onClick={() => onValueChange(option.value)}
            >
              {option.icon && <option.icon className="size-3.5" />}
              {option.label}
              {option.reason && (
                <span className="sr-only">: {option.reason}</span>
              )}
              {option.value === selected && (
                <CheckIcon className="ml-auto size-3.5" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </DisplayRow>
  );
}

/**
 * Group by over the declared `model.grouping` choices, with hierarchy levels
 * where a choice nests. A choice that cannot group stays listed, disabled,
 * with its reason. Absent when the entity declares no grouping.
 */
function ListGroupMenu({ entity }: { entity: BrowserRoutedEntity }) {
  const { search, navigate } = useListSearch();
  const { view } = resolveListView(useQueryClient(), entity, search);
  const choices = useEntityMetadata(entity).listFields.grouping;
  // A board's columns are its grouping; it declares its own choices.
  const board = typeof view === "object" && view.kind === "board";
  if (choices.length === 0 || board) return null;
  const timeline =
    view === "timeline" || (typeof view === "object" && view.id === "calendar");
  const dimensions = timeline ? [] : (listGroupBy(search) ?? []);
  const apply = (next: ListGroupBy[]) =>
    navigate({ groupBy: next.length ? next : undefined });
  const update = (index: number, next: ListGroupBy) =>
    apply(
      dimensions.map((item, position) => (position === index ? next : item)),
    );
  const move = (index: number, delta: number) => {
    const next = [...dimensions];
    const from = next[index];
    const to = next[index + delta];
    if (!from || !to) return;
    next[index] = to;
    next[index + delta] = from;
    apply(next);
  };
  const summary = dimensions
    .map((dimension) => {
      const choice = choices.find(({ key }) => key === dimension.key);
      return `${choice?.label ?? dimension.key}${dimension.bucket ? ` / ${dimension.bucket}` : dimension.level ? ` / ${groupLevelLabel(dimension.level)}` : ""}`;
    })
    .join(" → ");
  return (
    <DisplayRow label="Group">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-(--input-height) max-w-48 text-sm"
              aria-label={summary ? `Grouped by ${summary}` : "Group by"}
            />
          }
        >
          <RowsIcon className="size-3.5 shrink-0" />
          <span className="truncate">{summary || "None"}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-96 min-w-56 overflow-y-auto"
        >
          <DropdownMenuGroup aria-label="Group by">
            <DropdownMenuLabel>Group by · up to 3 fields</DropdownMenuLabel>
            <DropdownMenuItem
              aria-label="Group by None"
              onClick={() => apply([])}
            >
              None
              {dimensions.length === 0 && (
                <CheckIcon className="ml-auto size-3.5" />
              )}
            </DropdownMenuItem>
            {choices.map((choice) => {
              const index = dimensions.findIndex(
                ({ key }) => key === choice.key,
              );
              const reason = timeline ? TIMELINE_GROUP_REASON : choice.reason;
              return (
                <DropdownMenuItem
                  key={choice.key}
                  aria-label={`Group by ${choice.label}`}
                  disabled={
                    reason !== null || (index < 0 && dimensions.length === 3)
                  }
                  aria-current={index >= 0 ? "true" : undefined}
                  onClick={() =>
                    apply(
                      index >= 0
                        ? dimensions.filter((_, position) => position !== index)
                        : [
                            ...dimensions,
                            {
                              key: choice.key,
                              ...(choice.buckets.length
                                ? { bucket: "month" }
                                : {}),
                            },
                          ],
                    )
                  }
                >
                  <span className="flex min-w-0 flex-col">
                    <span>{choice.label}</span>
                    {reason && (
                      <span className="max-w-64 text-xs whitespace-normal text-muted-foreground">
                        {reason}
                      </span>
                    )}
                  </span>
                  {index >= 0 && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {index + 1}
                      <CheckIcon className="ml-1 inline size-3.5" />
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
          {dimensions.length > 0 && <DropdownMenuSeparator />}
          {dimensions.map((dimension, index) => {
            const choice = choices.find(({ key }) => key === dimension.key);
            if (!choice) return null;
            return (
              <DropdownMenuSubmenu key={dimension.key}>
                <DropdownMenuSubmenuTrigger>
                  {index + 1}. {choice.label}
                </DropdownMenuSubmenuTrigger>
                <DropdownMenuSubmenuContent>
                  <DropdownMenuItem
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === dimensions.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    Move down
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      apply(
                        dimensions.filter((_, position) => position !== index),
                      )
                    }
                  >
                    Remove grouping
                  </DropdownMenuItem>
                  {choice.levels > 0 && <DropdownMenuSeparator />}
                  {choice.levels > 0 && (
                    <DropdownMenuItem
                      onClick={() => update(index, { key: dimension.key })}
                    >
                      Exact {choice.label.toLowerCase()}
                    </DropdownMenuItem>
                  )}
                  {Array.from({ length: choice.levels }, (_, level) => (
                    <DropdownMenuItem
                      key={level}
                      aria-label={`Group ${choice.label} at ${groupLevelLabel(level + 1)}`}
                      onClick={() =>
                        update(index, { key: dimension.key, level: level + 1 })
                      }
                    >
                      {groupLevelLabel(level + 1)}
                      {dimension.level === level + 1 && (
                        <CheckIcon className="ml-auto size-3.5" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  {choice.buckets.length > 0 && <DropdownMenuSeparator />}
                  {choice.buckets.map((bucket) => (
                    <DropdownMenuItem
                      key={bucket}
                      onClick={() =>
                        update(index, { key: dimension.key, bucket })
                      }
                    >
                      By {bucket}
                      {dimension.bucket === bucket && (
                        <CheckIcon className="ml-auto size-3.5" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubmenuContent>
              </DropdownMenuSubmenu>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </DisplayRow>
  );
}

/** The Display popover's layout and grouping rows, from the entity's manifest. */
export function ListDisplaySections({
  entity,
}: {
  entity: BrowserRoutedEntity;
}) {
  return (
    <>
      <ListViewMenu entity={entity} />
      <ListGroupMenu entity={entity} />
    </>
  );
}
