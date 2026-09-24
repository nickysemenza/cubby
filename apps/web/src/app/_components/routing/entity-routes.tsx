import type { Entity } from "@cubby/schemas/entity";
import {
  isSlotListView,
  listPresentationLabel,
  listViewId,
} from "@cubby/schemas/entity-definitions/definition";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { CalendarCheckIcon as CalendarClock } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { GridFourIcon as Grid2X2 } from "@phosphor-icons/react/dist/csr/GridFour";
import { GridNineIcon as Grid3X3 } from "@phosphor-icons/react/dist/csr/GridNine";
import { TableIcon as Table2 } from "@phosphor-icons/react/dist/csr/Table";
import type { Icon } from "@phosphor-icons/react/lib";
import type { UseSuspenseQueryOptions } from "@tanstack/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, notFound, useParams } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { z } from "zod";

import {
  GenericEntityDetail,
  type GenericDetailEntity,
} from "~/app/_components/entity-detail/generic-entity-detail";
import {
  EntityListCardDensityProvider,
  GenericEntityList,
  type GenericEntityListProps,
  resolveListView,
  useEntityListCardDensity,
  useListSearch,
} from "~/app/_components/entity-list/generic-entity-list";
import type { PageLayout } from "~/components/layout/page-wrapper";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from "~/components/ui/empty";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { readRecordField } from "~/entities/entity-references";
import { useDetailTitle } from "~/hooks/useDocumentTitle";

/**
 * The page bodies every entity route shares, as factories.
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
 * in the values of splittable properties:
 *
 * ```tsx
 * export const Route = createFileRoute("/_authenticated/vendors/$shortcode")({
 *   loader: …,                       // stays eager, by design — it prefetches
 *   notFoundComponent: notFoundPage("vendor", …),   // split
 *   component: detailPage({ … }),                   // split
 * });
 * ```
 *
 * Because nothing here is referenced from an unsplittable property, this whole
 * module (and the page bodies it closes over) stays out of the app shell.
 * Keep it that way: anything a route needs at `loader` / `head` / `search` time
 * belongs in `./detail-loader`, not here.
 */

/* -------------------------------------------------------------------------- */
/* List pages                                                                  */
/* -------------------------------------------------------------------------- */

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
}

const VIEW_ICONS = {
  table: Table2,
  shelf: Grid2X2,
  timeline: CalendarClock,
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
            icon: Grid3X3,
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
                {option.value === selected && <Check aria-hidden />}
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
  entity,
  actions,
  operations,
}: EntityListPageOptions) {
  const { singular, plural, list } = entitySummary[entity];
  return listChromePage({
    entity,
    title: plural ?? singular,
    page: () => <GenericEntityList entity={entity} operations={operations} />,
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

/* -------------------------------------------------------------------------- */
/* Detail pages                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Structural view of an entity detail `queryOptions()` result.
 *
 * The concrete transport query options are not assignable to react-query's
 * `UseSuspenseQueryOptions`, so the read below takes a cast — the same boundary
 * technique as `entity-contracts.ts`'s standard contract. The record's own type
 * is still recovered exactly, by resolving `queryFn` on the concrete return
 * type rather than inferring through it: React Query hides that signature behind an
 * `Exclude<…>` conditional, which is a non-inferrable position.
 */
type DetailQueryFactory = (shortcode: string) => {
  queryKey: readonly unknown[];
  queryFn?: (...args: never[]) => DetailQueryValue;
};

/** Query payloads are parsed by each entity operation before reaching a page. */
type DetailQueryValue = object | null;

/** The non-null record a detail query resolves to. */
type DetailRecord<TQuery extends DetailQueryFactory> = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<TQuery>["queryFn"]>>>
>;

interface DetailPageOptions<TQuery extends DetailQueryFactory> {
  /** The entity the route serves; the generated routes name it. */
  entity?: BrowserRoutedEntity;
  /**
   * The record's query — the same one the route's loader prefetches, so this
   * suspense read is always a cache hit.
   */
  query: TQuery;
  /**
   * The loaded record's page body. Declared after `query` on purpose: a
   * context-sensitive callback contributes no inference candidate, so `TQuery`
   * has to be fixed by the property above before this one is checked — order
   * it first and `data` degrades to the constraint's `unknown`.
   *
   * Omitted by the generated routes: with `entity` set, the body is the
   * generic detail page rendered from the manifest.
   */
  render?: (data: DetailRecord<TQuery>, shortcode: string) => ReactNode;
  /**
   * Document title for the loaded record; the shortcode is the fallback.
   * Omitted by the generated routes: `entity`'s `titleField` is read.
   */
  title?: (data: DetailRecord<TQuery>) => string | null | undefined;
}

const recordTitle = z.string().nullish();

/** The `$shortcode` detail body: suspense-read the loader's record, render it. */
export function detailPage<TQuery extends DetailQueryFactory>({
  entity,
  query,
  render = (data, shortcode) => {
    if (entity === undefined)
      throw new Error("detailPage needs `render` or `entity`");
    // SAFETY: a generated route pairs `entity` with that entity's own detail
    // query, so the loaded record is the entity's detail shape.
    return (
      <GenericEntityDetail
        key={shortcode}
        entity={entity as GenericDetailEntity}
        record={data as never}
      />
    );
  },
  title = (data) =>
    entity === undefined
      ? undefined
      : readRecordField(data, entitySummary[entity].titleField, recordTitle),
}: DetailPageOptions<TQuery>) {
  return function EntityDetailPage() {
    // `useParams({ strict: false })` because this component is built before any
    // route object exists to read the literal path from. Every caller is a
    // `$shortcode` route, which is what makes the narrowing safe.
    // SAFETY: this component is only installed on `$shortcode` detail routes.
    const { shortcode } = useParams({ strict: false }) as {
      shortcode: string;
    };
    // SAFETY: the route factory's query options resolve to the page's
    // schema-derived record, while the router library hides that correlation
    // behind conditional generic overloads.
    const { data } = useSuspenseQuery(
      query(shortcode) as UseSuspenseQueryOptions<DetailRecord<TQuery> | null>,
    );

    useDetailTitle(shortcode, (data ? title(data) : undefined) ?? undefined);

    // The loader covers the initial request. Focus/reconnect refetches can
    // still observe a record deleted since navigation, which is a real
    // not-found transition rather than a blank successful detail page.
    if (!data) throw notFound();

    return render(data, shortcode);
  };
}

/**
 * The `notFoundComponent` every entity detail route renders. Copy derives
 * from the entity's singular name so generated and hand-written routes read
 * the same.
 */
export function notFoundPage(entity: BrowserRoutedEntity) {
  const { label } = entities[entity];
  const title = `${label} not found`;
  const description = `This ${label.toLocaleLowerCase()} is no longer available.`;
  return function EntityNotFound() {
    return (
      <Page variant="list" title={title} entity={entity} compact>
        <Empty>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
          <EmptyActions>
            <Button
              variant="outline"
              render={<Link to={entities[entity].routes.list} />}
              nativeButton={false}
            >
              Browse {entities[entity].pluralLabel.toLocaleLowerCase()}
            </Button>
          </EmptyActions>
        </Empty>
      </Page>
    );
  };
}
