import type { Entity } from "@cubby/schemas/entity";
import {
  listPresentationLabel,
  listViewId,
} from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GridFourIcon } from "@phosphor-icons/react/dist/csr/GridFour";
import { GridNineIcon } from "@phosphor-icons/react/dist/csr/GridNine";
import { RowsIcon } from "@phosphor-icons/react/dist/csr/Rows";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import {
  EntityListCardDensityProvider,
  GenericEntityList,
  type GenericEntityListProps,
  listGroupBy,
  listGroupLevel,
  useEntityListCardDensity,
  useListSearch,
} from "~/entity/entity-list/generic-entity-list";
import { resolveListView } from "~/entity/entity-list/resolve-list-view";
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
}

const VIEW_ICONS = {
  table: TableIcon,
  shelf: GridFourIcon,
  timeline: CalendarCheckIcon,
} satisfies Record<"table" | "shelf" | "timeline", Icon>;

const TIMELINE_GROUP_REASON = "Timeline is already arranged by date.";
const NO_GROUP_LEVEL_REASON = "Group by a field first.";

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
  const { views, view } = resolveListView(entity, search);
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
  const { view } = resolveListView(entity, search);
  const grouping = generatedEntityListFields[entity].grouping;
  if (grouping.length === 0) return null;
  const timeline = view === "timeline";
  const groupBy = timeline ? undefined : listGroupBy(search);
  const activeGroup = grouping.find(
    (choice) => choice.key === groupBy && choice.reason === null,
  );
  const groupChoices = [
    { key: undefined, label: "None", reason: null },
    ...grouping,
  ].map((choice) => ({
    ...choice,
    reason: timeline && choice.key ? TIMELINE_GROUP_REASON : choice.reason,
  }));
  // Levels sit beside Group by on lists whose choices can nest; a choice
  // that cannot keeps the section, disabled, with the declaration's reason.
  const leveled = grouping.some(({ levels }) => levels > 0);
  const requestedLevel = listGroupLevel(search);
  const activeLevel =
    activeGroup && requestedLevel && requestedLevel <= activeGroup.levels
      ? requestedLevel
      : undefined;
  const levelReason = timeline
    ? TIMELINE_GROUP_REASON
    : activeGroup === undefined
      ? NO_GROUP_LEVEL_REASON
      : activeGroup.levelReason;
  const levelChoices: { level: number | undefined; label: string }[] =
    activeGroup && levelReason === null
      ? [
          {
            level: undefined,
            label: `Exact ${activeGroup.label.toLowerCase()}`,
          },
          ...Array.from({ length: activeGroup.levels }, (_, index) => ({
            level: index + 1,
            label: groupLevelLabel(index + 1),
          })),
        ]
      : [];
  const groupSummary = activeGroup
    ? `${activeGroup.label}${activeLevel ? `, ${groupLevelLabel(activeLevel).toLowerCase()}` : ""}`
    : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={
              groupSummary ? `Grouped by ${groupSummary}` : "Group by"
            }
          />
        }
      >
        <RowsIcon className="size-3.5" />
        {groupSummary ?? "Group"}
        <CaretDownIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuGroup aria-label="Group by">
          <DropdownMenuLabel>Group by</DropdownMenuLabel>
          {groupChoices.map((choice) => {
            const current = choice.key === activeGroup?.key;
            return (
              <DropdownMenuItem
                key={choice.key ?? "none"}
                disabled={choice.reason !== null}
                aria-label={`Group by ${choice.label}`}
                aria-current={current ? "true" : undefined}
                onClick={() =>
                  navigate({ groupBy: choice.key, groupLevel: undefined })
                }
              >
                <span className="flex min-w-0 flex-col">
                  <span>{choice.label}</span>
                  {choice.reason && (
                    <span className="max-w-64 text-xs whitespace-normal text-muted-foreground">
                      {choice.reason}
                    </span>
                  )}
                </span>
                {current && <CheckIcon className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {leveled && <DropdownMenuSeparator />}
        {leveled && (
          <DropdownMenuGroup aria-label="Group level">
            <DropdownMenuLabel>Level</DropdownMenuLabel>
            {levelReason !== null ? (
              <DropdownMenuItem disabled aria-label="Group by level">
                <span className="flex min-w-0 flex-col">
                  <span>By level</span>
                  <span className="max-w-64 text-xs whitespace-normal text-muted-foreground">
                    {levelReason}
                  </span>
                </span>
              </DropdownMenuItem>
            ) : (
              levelChoices.map((choice) => {
                const current = choice.level === activeLevel;
                return (
                  <DropdownMenuItem
                    key={choice.level ?? "exact"}
                    aria-label={`Group at ${choice.label}`}
                    aria-current={current ? "true" : undefined}
                    onClick={() => navigate({ groupLevel: choice.level })}
                  >
                    {choice.label}
                    {current && <CheckIcon className="ml-auto size-3.5" />}
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuGroup>
        )}
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
  return resolveListView(entity, search).view === "table" ? "none" : "standard";
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
}: EntityListPageOptions) {
  const { singular, plural, list } = entitySummary[entity];
  return listChromePage({
    entity,
    title: plural ?? singular,
    page: () => (
      <GenericEntityList
        entity={entity}
        operations={operations}
        override={override}
      />
    ),
    workbenchControls: () => <ListWorkbenchMenus entity={entity} />,
    bodyGutter: function useBodyGutter() {
      return useListBodyGutter(entity);
    },
    actions: () => (
      <>
        {list.links.map((link) => (
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
    ),
  });
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
  compact?: boolean;
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
  compact,
  actions,
  workbenchControls,
  bodyGutter,
}: ListChromeOptions) {
  return function ListChromeShell() {
    const routedEntity =
      entity !== undefined && isBrowserRoutedEntity(entity) ? entity : null;
    const resolvedWorkbenchControls =
      workbenchControls ??
      (routedEntity
        ? () => <ListWorkbenchMenus entity={routedEntity} />
        : undefined);
    return (
      <EntityListCardDensityProvider>
        <Page
          variant="list"
          listChrome="workbench"
          title={title}
          entity={entity}
          layout={layout}
          eyebrow={eyebrow}
          compact={compact}
          actions={actions?.()}
          workbenchControls={resolvedWorkbenchControls?.()}
          bodyGutter={bodyGutter?.()}
        >
          <PageBody />
        </Page>
      </EntityListCardDensityProvider>
    );
  };
}
