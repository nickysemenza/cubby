import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { UseSuspenseQueryOptions } from "@tanstack/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, notFound, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";

import { entities } from "~/entity/entities";
import { type GenericDetailEntity } from "~/entity/entity-detail/detail-record";
import { GenericEntityDetail } from "~/entity/entity-detail/generic-entity-detail";
import { readRecordField } from "~/entity/entity-references";
import { useDetailTitle } from "~/ui/hooks/useDocumentTitle";
import { Page } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from "~/ui/primitives/empty";

/**
 * The `$shortcode` page bodies every entity detail route shares, as factories.
 *
 * Same splitter contract as `./list-page`: build components only, bind each to
 * a module-level const, and reference that identifier from the literal
 * `createFileRoute(...)` options object's splittable properties:
 *
 * ```tsx
 * const VendorDetailPage = detailPage({ … });
 * const VendorNotFound = notFoundPage("vendor");
 * export const Route = createFileRoute("/_authenticated/vendors/$shortcode")({
 *   loader: …,                         // split separately — it prefetches
 *   notFoundComponent: VendorNotFound, // split
 *   component: VendorDetailPage,       // split
 * });
 * ```
 *
 * Kept apart from `./list-page` so the generic detail page and its sections
 * never ride into a list route's closure. Loader-time code belongs in
 * `./detail-loader`.
 */

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
