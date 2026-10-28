import type { Entity } from "@cubby/schemas/entity";
import {
  listPresentationLabel,
  listViewId,
} from "@cubby/schemas/entity-definitions/definition";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import type { ListGroupBy } from "@cubby/schemas/pagination";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GridFourIcon } from "@phosphor-icons/react/dist/csr/GridFour";
import { GridNineIcon } from "@phosphor-icons/react/dist/csr/GridNine";
import { RowsIcon } from "@phosphor-icons/react/dist/csr/Rows";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import type { Icon } from "@phosphor-icons/react/lib";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useState } from "react";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import {
  EntityListCardDensityProvider,
  GenericEntityList,
  type GenericEntityListProps,
  listGroupBy,
  useEntityListCardDensity,
  useListSearch,
} from "~/entity/entity-list/generic-entity-list";
import { resolveListView } from "~/entity/entity-list/resolve-list-view";
import { useEntityMetadata } from "~/entity/metadata";
import { Page } from "~/entity/page/page";
import type { PageLayout } from "~/ui/layout/page-wrapper";
import { Button } from "~/ui/primitives/button";
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
} from "~/ui/primitives/dropdown-menu";

/**
 * The list page bodies every entity list route shares, as factories.
 *
 * ⚠️ These build **components**, never a `createFileRoute(...)` option object.
 * That is a hard constraint, not a style choice: the router plugin's code
 * splitter only fires when the argument to `createFileRoute(path)(…)` is a
 * literal object expression. `defaultBehavior` groups `component`,
 * `errorComponent`, and `notFoundComponent` together, and splits `loader`
 * separately out of the eager bundle. Hand it a call expression — a factory that
 * returns the whole options object — and it silently splits nothing, so every
 * route body lands in the first-load app shell.
 *
 * So a route file keeps its literal options object, and reaches for these only
 * in the values of splittable properties, bound to a module-level const:
 *
 * ```tsx
 * const VendorsPage = listPage({ entity: "vendor" });
 * export const Route = createFileRoute("/_authenticated/vendors/")({
 *   loader: …,              // split separately — it prefetches
 *   component: VendorsPage, // split
 * });
 * ```
 *
 * Because nothing here is referenced from an unsplittable property, this whole
 * module (and the page bodies it closes over) stays out of the app shell.
 * Keep it that way: anything a route needs at `loader` / `head` / `search` time
 * belongs in `./detail-loader`, not here.
 *
 * List and detail factories live in separate modules (`./detail-page`) so a
 * list route's closure never includes the generic detail page, and vice versa.
 */

interface EntityListPageOptions {
  /** The entity whose manifest (`entitySummary[entity].list`) drives the page. */
  entity: BrowserRoutedEntity;
  /**
   * The route's own trigger beside the manifest's header links (the create
   * dialog, an upload dialog). A thunk so nothing in it — a capture-request
   * builder, an icon module — runs at module load.
   */
  actions?: () => ReactNode;
  /** Test seam, forwarded to the generic list. */
  operations?: GenericEntityListProps["operations"];
  override?: GenericEntityListProps["override"];
  readProjection?: GenericEntityListProps["readProjection"];
}

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
 * Timeline). Group by is its own menu beside it ({@link ListGroupMenu}).
 */
function ListViewMenu({ entity }: { entity: BrowserRoutedEntity }) {
  const { search, navigate } = useListSearch();
  const { density, setDensity } = useEntityListCardDensity();
  const { views, view } = resolveListView(useQueryClient(), entity, search);
  if (views.length < 2) return null;
  const options = views.flatMap((candidate) => {
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
  const defaultView = listViewId(views[0] ?? "table");
  const selected =
    view === "shelf" && density === "compact" ? "compact" : listViewId(view);
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7.5 text-sm"
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
            onClick={() => onValueChange(option.value)}
          >
            {option.icon && <option.icon className="size-3.5" />}
            {option.label}
            {option.value === selected && (
              <CheckIcon className="ml-auto size-3.5" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  if (choices.length === 0) return null;
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7.5 max-w-80 text-sm"
            aria-label={summary ? `Grouped by ${summary}` : "Group by"}
          />
        }
      >
        <RowsIcon className="size-3.5 shrink-0" />
        <span className="truncate">{summary || "Group"}</span>
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
            const index = dimensions.findIndex(({ key }) => key === choice.key);
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
  );
}

/** The list's Group by and view menus, in the workbench band's controls slot. */
function ListWorkbenchMenus({ entity }: { entity: BrowserRoutedEntity }) {
  return (
    <div className="flex items-center gap-1">
      <ListGroupMenu entity={entity} />
      <ListViewMenu entity={entity} />
    </div>
  );
}

/** A table sits flush to the viewport edge; every other renderer wants the gutter. */
function useListBodyGutter(entity: BrowserRoutedEntity): "none" | "standard" {
  const { search } = useListSearch();
  return resolveListView(useQueryClient(), entity, search).view === "table"
    ? "none"
    : "standard";
}

/**
 * The generated index routes' page: title, header links, view switcher and
 * body gutter derive from the entity's manifest; the body is the generic
 * list. `actions` adds the route's own trigger beside the links.
 */
export function listPage({
  entity,
  actions,
  operations,
  override,
  readProjection,
}: EntityListPageOptions) {
  const { singular, plural } = entityRoster[entity];
  return listChromePage({
    entity,
    title: plural ?? singular,
    page: () => (
      <GenericEntityList
        entity={entity}
        operations={operations}
        override={override}
        readProjection={readProjection}
      />
    ),
    workbenchControls: () => <ListWorkbenchMenus entity={entity} />,
    bodyGutter: function useBodyGutter() {
      return useListBodyGutter(entity);
    },
    actions: () => <DeclaredListActions entity={entity} actions={actions} />,
  });
}

function DeclaredListActions({
  entity,
  actions,
}: {
  entity: BrowserRoutedEntity;
  actions?: () => ReactNode;
}) {
  const { summary } = useEntityMetadata(entity);
  return (
    <>
      {summary.list.links.map((link) => (
        <Button
          key={link.path}
          variant="outline"
          render={<Link to={link.path} />}
          nativeButton={false}
        >
          {link.label}
        </Button>
      ))}
      {actions?.()}
    </>
  );
}

interface ListChromeOptions {
  title: string;
  /**
   * The bespoke body — reads its own `Route.useSearch()`/`useNavigate()`
   * rather than taking props, same as `ListPageOptions.list`.
   */
  page: ComponentType;
  entity?: Entity;
  layout?: PageLayout;
  eyebrow?: ReactNode;
  actions?: () => ReactNode;
  /**
   * A view menu or segmented `Picker`, rendered in the workbench query
   * tier. A thunk for the same reason as `actions`: it closes over that
   * route's own `Route.useSearch()`/`useNavigate()`, so it has to be called
   * during this shell's render rather than built at module load.
   */
  workbenchControls?: () => ReactNode;
  /**
   * Passed straight through to `Page`. A thunk because the routes that need
   * it (a table view flush to the edge, other views gutter-contained) derive
   * it from the same live view state as `workbenchControls`.
   */
  bodyGutter?: () => "none" | "standard";
}

/**
 * The `variant="list" listChrome="workbench"` shell for routes that share the
 * durable workbench chrome without being an entity list — Activity, Calendar,
 * the project tool matrix, statement rows. Unlike {@link listPage}, the body
 * is arbitrary (it owns its own search/navigate wiring); this only owns the
 * shell, so a route can't drift onto a different `Page` variant/chrome by
 * hand-writing the wrapper.
 */
export function listChromePage({
  title,
  page: PageBody,
  entity,
  layout = "full",
  eyebrow,
  actions,
  workbenchControls,
  bodyGutter,
}: ListChromeOptions) {
  return function ListChromeShell() {
    const [density, setDensity] = useState<"cards" | "compact">("cards");
    const cardDensity = { density, setDensity };
    const routedEntity =
      entity !== undefined && isBrowserRoutedEntity(entity) ? entity : null;
    const resolvedWorkbenchControls =
      workbenchControls ??
      (routedEntity
        ? () => <ListWorkbenchMenus entity={routedEntity} />
        : undefined);
    return (
      <EntityListCardDensityProvider value={cardDensity}>
        <Page
          variant="list"
          listChrome="workbench"
          title={title}
          entity={entity}
          layout={layout}
          eyebrow={eyebrow}
          actions={actions?.()}
          workbenchControls={
            <EntityListCardDensityProvider value={cardDensity}>
              {resolvedWorkbenchControls?.()}
            </EntityListCardDensityProvider>
          }
          bodyGutter={bodyGutter?.()}
        >
          <PageBody />
        </Page>
      </EntityListCardDensityProvider>
    );
  };
}
