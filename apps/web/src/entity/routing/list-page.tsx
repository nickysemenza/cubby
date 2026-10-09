import type { Entity } from "@cubby/schemas/entity";
import {
  isSlotListView,
  listPresentationLabel,
  listViewId,
} from "@cubby/schemas/entity-definitions/definition";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-index";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GridFourIcon } from "@phosphor-icons/react/dist/csr/GridFour";
import { GridNineIcon } from "@phosphor-icons/react/dist/csr/GridNine";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import {
  EntityListCardDensityProvider,
  GenericEntityList,
  type GenericEntityListProps,
  useEntityListCardDensity,
  useListSearch,
} from "~/entity/entity-list/generic-entity-list";
import type { ListClient } from "~/entity/entity-list/list-hooks";
import { resolveListView } from "~/entity/entity-list/resolve-list-view";
import { entitySummaryOf } from "~/entity/entity-model";
import type { PageLayout } from "~/ui/layout/page-wrapper";
import { Page } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { ViewSwitcher } from "~/ui/primitives/view-switcher";

/**
 * The list page bodies every entity list route shares, as factories.
 *
 * ⚠️ These build **components**, never a `createFileRoute(...)` option object.
 * That is a hard constraint, not a style choice: the router plugin's code
 * splitter only fires when the argument to `createFileRoute(path)(…)` is a
 * literal object expression, and it splits exactly the `component`,
 * `errorComponent`, and `notFoundComponent` properties out of the eager bundle
 * (`defaultCodeSplitGroupings`). Hand it a call expression — a factory that
 * returns the whole options object — and it silently splits nothing, so every
 * route body lands in the first-load app shell.
 *
 * So a route file keeps its literal options object, and reaches for these only
 * in the values of splittable properties, bound to a module-level const:
 *
 * ```tsx
 * const VendorsPage = listPage({ entity: "vendor" });
 * export const Route = createFileRoute("/_authenticated/vendors/")({
 *   loader: …,              // stays eager, by design — it prefetches
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
  /**
   * The entity's generated client module (`entity/generated/clients/<entity>.list.gen.ts`),
   * whose manifest (`entitySummaryOf(entity).list`) drives the page. The
   * route's component chunk imports it, so the model is registered before
   * the page renders and its list slots arrive with it.
   */
  client: ListClient<BrowserRoutedEntity>;
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

/** The segmented view control, rendered only when the manifest declares more than one view. */
function ListViewSwitcher({ entity }: { entity: BrowserRoutedEntity }) {
  const { search, navigate } = useListSearch();
  const { density, setDensity } = useEntityListCardDensity();
  const { views, view } = resolveListView(entity, search);
  if (views.length < 2) return null;
  const options = views.flatMap((candidate) => {
    const id = listViewId(candidate);
    const choice = {
      value: id,
      label: isSlotListView(candidate)
        ? candidate.label
        : (listPresentationLabel(candidate) ?? "Timeline"),
      icon: isSlotListView(candidate) ? undefined : VIEW_ICONS[candidate],
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
  return (
    <>
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                aria-label={`${entities[entity].pluralLabel} view: ${selectedOption?.label ?? selected}`}
              />
            }
          >
            View: {selectedOption?.label ?? selected}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {options.map((option) => (
              <DropdownMenuItem
                key={option.value}
                aria-current={option.value === selected ? "true" : undefined}
                onClick={() => onValueChange(option.value)}
              >
                {option.value === selected && <CheckIcon aria-hidden />}
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ViewSwitcher
        ariaLabel={`${entities[entity].pluralLabel} view`}
        className="hidden md:flex"
        options={options}
        value={selected}
        // Merge, don't replace: filter params survive a renderer switch and
        // stay shareable in the URL; the default view is the bare URL.
        onValueChange={onValueChange}
      />
    </>
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
  client,
  actions,
  operations,
  override,
}: EntityListPageOptions) {
  const { entity } = client;
  const { singular, plural, list } = entitySummaryOf(entity);
  return listChromePage({
    entity,
    title: plural ?? singular,
    page: () => (
      <GenericEntityList
        entity={entity}
        slots={client.slots}
        operations={operations}
        override={override}
      />
    ),
    workbenchControls: () => <ListViewSwitcher entity={entity} />,
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
  decoration?: "accent" | "none";
  actions?: () => ReactNode;
  /**
   * A `ViewSwitcher` or similar, rendered in the workbench header's first
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
  decoration,
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
        ? () => <ListViewSwitcher entity={routedEntity} />
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
          decoration={decoration}
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
