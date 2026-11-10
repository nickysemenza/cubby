import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useState } from "react";

import { isBrowserRoutedEntity } from "~/entity/entities";
import {
  EntityListCardDensityProvider,
  GenericEntityList,
  type GenericEntityListProps,
  listGroupBy,
  useListSearch,
  useEntityListCardDensity,
} from "~/entity/entity-list/generic-entity-list";
import { ListDisplaySections } from "~/entity/entity-list/list-display-sections";
import { resolveListView } from "~/entity/entity-list/resolve-list-view";
import { useEntityMetadata } from "~/entity/metadata";
import { Page } from "~/entity/page/page";
import { DisplayMenu } from "~/entity/table/display-menu";
import type { PageLayout } from "~/ui/layout/page-wrapper";
import { Button } from "~/ui/primitives/button";

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

/**
 * The Display control for views with no table (Board, Calendar and other slot
 * views). Table-backed views get theirs from the toolbar, which adds sort and
 * columns; both read the same layout and grouping rows.
 */
function ListWorkbenchMenus({ entity }: { entity: BrowserRoutedEntity }) {
  const { search } = useListSearch();
  const { view } = resolveListView(useQueryClient(), entity, search);
  const { density } = useEntityListCardDensity();
  if (typeof view === "string" || density === "contact-sheet") return null;
  return (
    <DisplayMenu customized={(listGroupBy(search)?.length ?? 0) > 0}>
      <ListDisplaySections entity={entity} />
    </DisplayMenu>
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
          render={<Link to={link.path} search={link.search} />}
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
    const [density, setDensity] = useState<
      "cards" | "compact" | "contact-sheet"
    >("cards");
    const cardDensity = { density, setDensity };
    const routedEntity =
      entity !== undefined && isBrowserRoutedEntity(entity) ? entity : null;
    const resolvedWorkbenchControls =
      workbenchControls ??
      (routedEntity
        ? () => <ListWorkbenchMenus entity={routedEntity} />
        : undefined);
    const gutter = bodyGutter?.();
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
          bodyGutter={density === "contact-sheet" ? "none" : gutter}
        >
          <PageBody />
        </Page>
      </EntityListCardDensityProvider>
    );
  };
}
