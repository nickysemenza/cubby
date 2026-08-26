import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import { Link } from "@tanstack/react-router";
import { ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { EntityPreviewContent } from "./EntityPreviewContent";
import type { HoverPreviewEntity } from "./preview/preview-entities";
import { RelationshipExplorer } from "./relationships/relationship-explorer";

type InspectorTab = "overview" | "relations" | "activity";

const COMPACT_OVERVIEW_ENTITIES: ReadonlySet<Entity> =
  new Set<HoverPreviewEntity>([
    "recipe",
    "ingredient",
    "product",
    "usda-food",
    "cookbook",
    "location",
    "inventory",
    "meal",
    "project",
    "task",
    "expense",
    "purchase",
    "vendor",
  ]);

const supportsCompactOverview = (
  entity: Entity,
): entity is HoverPreviewEntity => COMPACT_OVERVIEW_ENTITIES.has(entity);

const isAuditableEntity = (entity: Entity): entity is AuditEntityType =>
  entityManifest[entity].auditable;

function OpenEntityLink({ entity, id }: { entity: Entity; id: string }) {
  if (!isBrowserRoutedEntity(entity)) return null;

  if (entity === "usda-food") {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        mobileSize="compact"
        nativeButton={false}
        aria-label="Open full USDA food details"
        render={<Link to="/usda/$id" params={{ id }} />}
      >
        <ExternalLink />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      mobileSize="compact"
      nativeButton={false}
      aria-label={`Open full ${entities[entity].label.toLowerCase()} details`}
      render={
        <Link
          to={entities[entity].routes.detail}
          params={entityDetailParams(id)}
        />
      }
    >
      <ExternalLink />
    </Button>
  );
}

function UnsupportedOverview({ entity, id }: { entity: Entity; id: string }) {
  const label = entityLabel(entity);

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center gap-2">
        <EntityIcon entity={entity} colored className="size-3.5" />
        <p className="font-medium text-foreground text-xs">{label}</p>
      </div>
      <p className="font-mono text-muted-foreground text-xs">{id}</p>
      <p className="text-muted-foreground text-xs">
        Open the full record to inspect its details.
      </p>
    </div>
  );
}

/**
 * Compact inspector shared by canonical sibling lists. Product keeps its
 * purpose-built workbench inspector; this surface never mounts a full detail
 * page inside the table dock.
 */
export function EntityWorkbenchInspector({
  entity,
  id,
  onClose,
}: {
  entity: Entity;
  id: string;
  onClose?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const hasRelations = relatedViewsFor(entity).length > 0;
  const hasActivity = isAuditableEntity(entity);
  const label = entityLabel(entity);

  const selectTab = (value: string) => {
    if (
      value === "overview" ||
      (value === "relations" && hasRelations) ||
      (value === "activity" && hasActivity)
    ) {
      setActiveTab(value);
    }
  };

  return (
    <aside
      aria-label={`${label} inspector`}
      className="h-full w-full max-w-full overflow-y-auto bg-card text-foreground text-xs"
    >
      <header className="border-border border-b p-3">
        <div className="flex items-start gap-2">
          <EntityIcon entity={entity} colored className="mt-0.5 size-4" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-2xs text-muted-foreground">
              {label}
            </span>
            <h2
              className="truncate font-mono text-foreground text-xs"
              title={id}
            >
              {id}
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <OpenEntityLink entity={entity} id={id} />
            {onClose ? (
              <Button
                variant="ghost"
                size="icon-xs"
                mobileSize="compact"
                aria-label="Close inspector"
                onClick={onClose}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={selectTab}>
        <TabsList
          variant="line"
          className="w-full justify-start border-border border-b px-2"
        >
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {hasRelations ? (
            <TabsTrigger value="relations">Relations</TabsTrigger>
          ) : null}
          {hasActivity ? (
            <TabsTrigger value="activity">Activity</TabsTrigger>
          ) : null}
        </TabsList>
        {activeTab === "overview" ? (
          <TabsContent value="overview">
            {supportsCompactOverview(entity) ? (
              <EntityPreviewContent entity={entity} id={id} />
            ) : (
              <UnsupportedOverview entity={entity} id={id} />
            )}
          </TabsContent>
        ) : null}
        {activeTab === "relations" && hasRelations ? (
          <TabsContent value="relations">
            <div className="px-3 py-3">
              <RelationshipExplorer entity={entity} sourceId={id} />
            </div>
          </TabsContent>
        ) : null}
        {activeTab === "activity" && hasActivity ? (
          <TabsContent value="activity">
            <div className="px-3 py-3">
              <AuditLogList
                entityType={entity}
                entityId={id}
                showEntityLink={false}
              />
            </div>
          </TabsContent>
        ) : null}
      </Tabs>
    </aside>
  );
}
