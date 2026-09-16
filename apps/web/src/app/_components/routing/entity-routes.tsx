import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { UseSuspenseQueryOptions } from "@tanstack/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, notFound, useParams } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";

import type { PageLayout } from "~/components/layout/page-wrapper";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from "~/components/ui/empty";
import { entities } from "~/entities/entities";
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

interface ListPageOptions {
  title: string;
  /** The list body, rendered inside the standard workbench page shell. */
  list: ComponentType;
  /** Only needed where the route path doesn't name the entity. */
  entity?: Entity;
  layout?: PageLayout;
  /**
   * Header actions. A thunk rather than a `ReactNode` so nothing in it — a
   * capture-request builder, an icon module — runs at module load.
   */
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
   * it derive it from the same live view state as `workbenchControls`.
   */
  bodyGutter?: () => "none" | "standard";
}

/**
 * The standard `variant="list" listChrome="workbench"` page body for an
 * entity list. Same shell as {@link listChromePage}; this narrower signature
 * exists so entity-list routes can't accidentally pass chrome the standard
 * lists never use.
 */
export function listPage({ list, ...options }: ListPageOptions) {
  return listChromePage({ ...options, page: list });
}

/**
 * The generated index routes' page: the title and the header links come
 * from the entity's manifest (`entitySummary[entity].list`); `actions` adds
 * the route's own trigger (the create dialog) beside them.
 */
export function entityListPage({
  entity,
  actions,
  ...options
}: Omit<ListPageOptions, "title" | "entity"> & {
  entity: BrowserRoutedEntity;
}) {
  const { singular, plural, list } = entitySummary[entity];
  return listPage({
    ...options,
    entity,
    title: plural ?? singular,
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
    return (
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
        workbenchControls={workbenchControls?.()}
        bodyGutter={bodyGutter?.()}
      >
        <PageBody />
      </Page>
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
   */
  render: (data: DetailRecord<TQuery>, shortcode: string) => ReactNode;
  /** Document title for the loaded record; the shortcode is the fallback. */
  title: (data: DetailRecord<TQuery>) => string | null | undefined;
}

/** The `$shortcode` detail body: suspense-read the loader's record, render it. */
export function detailPage<TQuery extends DetailQueryFactory>({
  query,
  render,
  title,
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
