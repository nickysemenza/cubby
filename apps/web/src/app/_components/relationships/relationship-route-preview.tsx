import type { Entity } from "@cubby/schemas/entity";
import {
  type RelatedPreviewGroup,
  type RelatedPreviewItem,
  type RelatedViewDefinition,
  relatedViewsFor,
} from "@cubby/schemas/related-view";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { skipToken, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { z } from "zod";

import { formatDate } from "~/app/projects/project-formatting";
import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Button } from "~/components/ui/button";
import type { EntityDetailRoute } from "~/entities/entities";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { relatedData } from "~/lib/related-data.functions";
import { cn } from "~/lib/utils";

import { TableLink } from "../table/TableLink";

const ROUTE_PREVIEW_LIMIT = 3;
const NO_PREVIEW_GROUPS: readonly RelatedPreviewGroup[] = [];
const relationshipSourceRecordSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    date: z.string().optional(),
    description: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough();
type RelationshipSourceRecord = z.output<typeof relationshipSourceRecordSchema>;

export interface RelationshipPreviewOperations {
  previews: typeof relatedData.previews;
}

const productionRelationshipPreviewOperations: RelationshipPreviewOperations = {
  previews: relatedData.previews,
};

export interface RelationshipRoutePreviewModel {
  source: {
    entity: Entity;
    id: string;
    label: string;
  };
  relation: {
    key: string;
    label: string;
    totalCount: number;
    endpoints: readonly RelatedPreviewItem[];
  };
}

export interface RelationshipRouteSource {
  entity: Entity;
  id: string;
  /** The already-loaded record title, never an entity-type placeholder. */
  label: string;
}

type PreviewableRelatedView = Pick<RelatedViewDefinition, "label"> & {
  key: RelatedPreviewGroup["relationKey"];
};

/**
 * Selects one honest graph edge for compact surfaces. The endpoints remain a
 * sibling list after the edge: this model intentionally never treats the
 * preview's first endpoint as the parent of the next one.
 */
export function relationshipRoutePreviewModel({
  source,
  views,
  groups,
}: {
  source: RelationshipRouteSource;
  views: readonly PreviewableRelatedView[];
  groups: readonly RelatedPreviewGroup[];
}): RelationshipRoutePreviewModel | null {
  const groupsByRelation = new Map(
    groups.map((group) => [group.relationKey, group]),
  );
  const primaryView = views.find(
    (view) => (groupsByRelation.get(view.key)?.totalCount ?? 0) > 0,
  );
  if (!primaryView) return null;

  const primaryGroup = groupsByRelation.get(primaryView.key);
  if (!primaryGroup) return null;

  return {
    source,
    relation: {
      key: primaryView.key,
      label: primaryView.label,
      totalCount: primaryGroup.totalCount,
      endpoints: primaryGroup.items.slice(0, ROUTE_PREVIEW_LIMIT),
    },
  };
}

/**
 * Makes a route source from a record the caller has already loaded. The
 * generated title field is the same identity the entity's list/detail
 * contracts use. A partial record stays absent rather than inventing a generic
 * entity label for a station that has not loaded its identity yet.
 */
export function relationshipRouteSourceFromRecord(
  entity: Entity,
  record: RelationshipSourceRecord,
  fallbackId?: string,
): RelationshipRouteSource | null {
  const id = record.id ?? fallbackId;
  if (!id) return null;
  const title = titleForRelationshipSource(entity, record);
  const label =
    title && title.trim().length > 0
      ? title
      : entity === "meal" && record.date
        ? formatDate(record.date)
        : null;
  if (!label) return null;
  return {
    entity,
    id,
    label,
  };
}

function titleForRelationshipSource(
  entity: Entity,
  record: RelationshipSourceRecord,
): string | undefined {
  if (entity === "usda-food") return record.description;
  if (entity === "image") return record.filename;
  return record.name;
}

/**
 * The shared local seam for bounded relationship previews. Consumers can all
 * ask for the same React Query key without issuing separate network reads;
 * deeper branch pages remain the explorer's explicit user action.
 */
function useRelationshipRoutePreview(
  entity: Entity,
  sourceId: string | undefined,
  source?: RelationshipRouteSource | null,
  operations: RelationshipPreviewOperations = productionRelationshipPreviewOperations,
) {
  const views = useMemo(() => relatedViewsFor(entity), [entity]);
  const relationKeys = useMemo(() => views.map((view) => view.key), [views]);
  const query = useQuery({
    ...operations.previews.queryOptions({
      source: entity,
      sourceIds: sourceId ? [sourceId] : [],
      relationKeys,
    }),
    enabled: Boolean(sourceId) && relationKeys.length > 0,
  });
  const groups = query.data ?? NO_PREVIEW_GROUPS;
  const model = useMemo(
    () =>
      sourceId && source
        ? relationshipRoutePreviewModel({
            source,
            views,
            groups,
          })
        : null,
    [groups, source, sourceId, views],
  );

  return { groups, model, query, relationKeys, views };
}

/**
 * Subscribes to the inspector's existing detail-preview cache without fetching.
 * The inspector has already mounted its compact preview; this only gives the
 * relationship station the same record identity once that data is available.
 */
export function useRelationshipRouteSource(
  entity: Entity,
  sourceId: string | undefined,
) {
  // SAFETY: dynamic entity selection chooses one generated query-options member,
  // but React Query cannot retain that correlated union through this call.
  const query = useQuery({
    ...(sourceId
      ? entityPreviewQueryOptions(entity, sourceId)
      : {
          queryKey: ["relationship-route", entity, "no-source"],
          queryFn: skipToken,
        }),
    enabled: false,
  } as never);
  return useMemo(() => {
    const parsed = relationshipSourceRecordSchema.safeParse(query.data);
    return parsed.success
      ? relationshipRouteSourceFromRecord(entity, parsed.data, sourceId)
      : null;
  }, [entity, query.data, sourceId]);
}

function SourcePreview({ source }: { source: RelationshipRouteSource }) {
  const contents = (
    <>
      <EntityIdentityMark
        entity={source.entity}
        displayImage={null}
        size="inline"
      />
      <span className="min-w-0 truncate font-medium">{source.label}</span>
      <span className="shrink-0 font-mono text-2xs text-slate">
        {source.id}
      </span>
    </>
  );
  const className =
    "flex min-w-36 max-w-52 items-center gap-1.5 whitespace-nowrap text-xs";

  if (!isBrowserRoutedEntity(source.entity))
    return <span className={className}>{contents}</span>;

  return (
    <TableLink
      // SAFETY: isBrowserRoutedEntity narrows this generated manifest key to a detail route.
      to={entities[source.entity].routes.detail as EntityDetailRoute}
      params={entityDetailParams(source.id)}
      className={className}
      variant="muted"
    >
      {contents}
    </TableLink>
  );
}

function EndpointPreview({ endpoint }: { endpoint: RelatedPreviewItem }) {
  const contents = (
    <>
      <EntityIdentityMark
        entity={endpoint.entity}
        displayImage={endpoint.displayImage}
        size="inline"
      />
      <span className="min-w-0 truncate">{endpoint.label}</span>
      <span className="shrink-0 font-mono text-2xs text-slate">
        {endpoint.id}
      </span>
    </>
  );
  const className =
    "flex min-w-36 max-w-52 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  if (!isBrowserRoutedEntity(endpoint.entity)) {
    return (
      <span className={cn(className, "text-muted-foreground")}>{contents}</span>
    );
  }

  return (
    <TableLink
      // SAFETY: isBrowserRoutedEntity narrows this generated manifest key to a detail route.
      to={entities[endpoint.entity].routes.detail as EntityDetailRoute}
      params={entityDetailParams(endpoint.id)}
      className={className}
      variant="muted"
    >
      {contents}
    </TableLink>
  );
}

/** A compact, linkable source -> relation -> sibling endpoint route. */
export function RelationshipRoutePreview({
  entity,
  sourceId,
  source,
  className,
  onViewAll,
  operations,
}: {
  entity: Entity;
  sourceId: string | undefined;
  source?: RelationshipRouteSource | null;
  className?: string;
  /** Inspector-owned mode switch; detail pages already expose the Relations tab. */
  onViewAll?: () => void;
  operations?: RelationshipPreviewOperations;
}) {
  const cachedSource = useRelationshipRouteSource(entity, sourceId);
  const resolvedSource = source ?? cachedSource;
  const { groups, model, query } = useRelationshipRoutePreview(
    entity,
    sourceId,
    resolvedSource,
    operations,
  );
  // The detail-preview owns unavailable/deleted state. Until it has supplied
  // an honest identity, the relationship station must not imply one.
  if (!resolvedSource) return null;

  if (query.isLoading) {
    return (
      <RelationshipRoutePreviewState source={resolvedSource}>
        Loading relationships…
      </RelationshipRoutePreviewState>
    );
  }

  if (query.isError) {
    return (
      <RelationshipRoutePreviewState source={resolvedSource}>
        <ErrorDisplay
          error={query.error}
          title="relationships"
          onRetry={() => void query.refetch()}
        />
      </RelationshipRoutePreviewState>
    );
  }

  if (groups.every((group) => group.totalCount === 0)) {
    return (
      <RelationshipRoutePreviewState source={resolvedSource}>
        No linked records.
      </RelationshipRoutePreviewState>
    );
  }

  if (!model) return null;

  return (
    <section
      aria-label={`${model.source.label} relationship preview`}
      className={cn("border-y border-border py-2", className)}
      data-testid="relationship-route-preview"
    >
      <div className="[scrollbar-width:thin] overflow-x-auto overscroll-x-contain">
        <div className="flex min-w-max items-center gap-2 px-1 md:min-w-0 md:flex-wrap">
          <SourcePreview source={model.source} />
          <ArrowRight aria-hidden className="size-3 shrink-0 text-slate" />
          <div className="flex items-center gap-1 text-xs font-medium whitespace-nowrap">
            <span>{model.relation.label}</span>
            <span className="font-mono text-2xs text-slate">
              ({model.relation.totalCount})
            </span>
          </div>
          <ul
            aria-label={`${model.relation.label} endpoints`}
            className="flex list-none items-center gap-1.5 p-0"
          >
            {model.relation.endpoints.map((endpoint) => (
              <li key={`${endpoint.entity}:${endpoint.id}`}>
                <EndpointPreview endpoint={endpoint} />
              </li>
            ))}
            {model.relation.totalCount > model.relation.endpoints.length ? (
              <li className="flex shrink-0 items-center gap-1 font-mono text-2xs whitespace-nowrap text-slate">
                <span>
                  +{model.relation.totalCount - model.relation.endpoints.length}
                </span>
                {onViewAll ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={onViewAll}
                  >
                    View all
                  </Button>
                ) : null}
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    </section>
  );
}

function RelationshipRoutePreviewState({
  source,
  children,
}: {
  source: RelationshipRouteSource;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={`${source.label} relationship preview`}
      className="border-y border-border px-3 py-2 text-xs text-muted-foreground"
      data-testid="relationship-route-preview-state"
    >
      {children}
    </section>
  );
}
