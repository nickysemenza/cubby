import type { Entity } from "@cubby/schemas/entity";
import {
  type RelatedPreviewGroup,
  type RelatedPreviewItem,
  type RelatedViewDefinition,
  relatedViewsFor,
} from "@cubby/schemas/related-view";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import type { EntityDetailRoute } from "~/entities/entities";
import {
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { relatedData } from "~/lib/related-data.functions";
import { cn } from "~/lib/utils";
import { TableLink } from "../table/TableLink";

const ROUTE_PREVIEW_LIMIT = 3;
const NO_PREVIEW_GROUPS: readonly RelatedPreviewGroup[] = [];

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

type PreviewableRelatedView = Pick<RelatedViewDefinition, "label"> & {
  key: RelatedPreviewGroup["relationKey"];
};

/**
 * Selects one honest graph edge for compact surfaces. The endpoints remain a
 * sibling list after the edge: this model intentionally never treats the
 * preview's first endpoint as the parent of the next one.
 */
export function relationshipRoutePreviewModel({
  entity,
  sourceId,
  views,
  groups,
}: {
  entity: Entity;
  sourceId: string;
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
    source: {
      entity,
      id: sourceId,
      label: entityLabel(entity),
    },
    relation: {
      key: primaryView.key,
      label: primaryView.label,
      totalCount: primaryGroup.totalCount,
      endpoints: primaryGroup.items.slice(0, ROUTE_PREVIEW_LIMIT),
    },
  };
}

/**
 * The shared local seam for bounded relationship previews. Consumers can all
 * ask for the same React Query key without issuing separate network reads;
 * deeper branch pages remain the explorer's explicit user action.
 */
export function useRelationshipRoutePreview(
  entity: Entity,
  sourceId: string | undefined,
) {
  const views = useMemo(() => relatedViewsFor(entity), [entity]);
  const relationKeys = useMemo(() => views.map((view) => view.key), [views]);
  const query = useQuery({
    ...relatedData.previews.queryOptions({
      source: entity,
      sourceIds: sourceId ? [sourceId] : [],
      relationKeys,
    }),
    enabled: Boolean(sourceId) && relationKeys.length > 0,
  });
  const groups = query.data ?? NO_PREVIEW_GROUPS;
  const model = useMemo(
    () =>
      sourceId
        ? relationshipRoutePreviewModel({ entity, sourceId, views, groups })
        : null,
    [entity, groups, sourceId, views],
  );

  return { groups, model, query, relationKeys, views };
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
  className,
}: {
  entity: Entity;
  sourceId: string | undefined;
  className?: string;
}) {
  const { model } = useRelationshipRoutePreview(entity, sourceId);
  if (!model) return null;

  return (
    <section
      aria-label={`${model.source.label} relationship preview`}
      className={cn("border-border border-y py-2", className)}
      data-testid="relationship-route-preview"
    >
      <div className="overflow-x-auto overscroll-x-contain [scrollbar-width:thin]">
        <div className="flex min-w-max items-center gap-2 px-1 md:min-w-0 md:flex-wrap">
          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs">
            <EntityIdentityMark
              entity={model.source.entity}
              displayImage={null}
              size="inline"
            />
            <span className="font-medium">{model.source.label}</span>
            <span className="font-mono text-2xs text-slate">
              {model.source.id}
            </span>
          </div>
          <ArrowRight aria-hidden className="size-3 shrink-0 text-slate" />
          <div className="flex items-center gap-1 whitespace-nowrap font-medium text-xs">
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
              <li className="shrink-0 whitespace-nowrap font-mono text-2xs text-slate">
                +{model.relation.totalCount - model.relation.endpoints.length}
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    </section>
  );
}
