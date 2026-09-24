import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";

export type InspectorTab = "overview" | "relations" | "activity";

function OpenEntityLink({ entity, id }: { entity: Entity; id: string }) {
  if (!isBrowserRoutedEntity(entity)) return null;
  const label = entityLabel(entity);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      mobileSize="compact"
      nativeButton={false}
      aria-label={`Open full ${label.toLowerCase()} details`}
      render={
        entity === "usda-food" ? (
          <Link to="/usda/$id" params={{ id }} />
        ) : (
          <Link
            to={entities[entity].routes.detail}
            params={entityDetailParams(id)}
          />
        )
      }
    >
      <ArrowSquareOutIcon />
    </Button>
  );
}

/** Shared chrome for every responsive canonical-row inspector. */
export function EntityInspectorFrame({
  entity,
  id,
  name,
  eyebrow,
  leading,
  activeTab,
  onTabChange,
  onClose,
  overview,
  relations,
  activity,
}: {
  entity: Entity;
  id: string;
  name?: string;
  eyebrow?: ReactNode;
  leading?: ReactNode;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose?: () => void;
  overview: ReactNode;
  relations?: ReactNode;
  activity?: ReactNode;
}) {
  const label = entityLabel(entity);
  const hasRelations = relations !== undefined;
  const hasActivity = activity !== undefined;
  const selectTab = (value: string) => {
    if (
      value === "overview" ||
      (value === "relations" && hasRelations) ||
      (value === "activity" && hasActivity)
    ) {
      onTabChange(value);
    }
  };

  return (
    <aside
      aria-label={`${label} inspector`}
      className="h-full w-full max-w-full overflow-y-auto bg-card text-xs text-foreground"
    >
      <header className="border-b border-border p-3">
        <div className="flex items-start gap-2">
          {leading ?? (
            <EntityIcon entity={entity} colored className="mt-0.5 size-4" />
          )}
          <div className="min-w-0 flex-1">
            {eyebrow ?? (
              <span className="text-2xs font-medium text-muted-foreground">
                {label}
              </span>
            )}
            <h2
              className="truncate text-sm font-semibold text-foreground"
              title={name ?? label}
            >
              {name ?? label}
            </h2>
            <p
              className="truncate font-mono text-2xs text-muted-foreground"
              title={id}
            >
              {id}
            </p>
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
                <XIcon />
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={selectTab}>
        <TabsList
          variant="line"
          className="w-full justify-start border-b border-border px-2"
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
          <TabsContent value="overview">{overview}</TabsContent>
        ) : null}
        {activeTab === "relations" && hasRelations ? (
          <TabsContent value="relations">{relations}</TabsContent>
        ) : null}
        {activeTab === "activity" && hasActivity ? (
          <TabsContent value="activity">{activity}</TabsContent>
        ) : null}
      </Tabs>
    </aside>
  );
}
