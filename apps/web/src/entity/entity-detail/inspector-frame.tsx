import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import { useId, useEffect, useState, type ReactNode } from "react";

import {
  EntityIcon,
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { Button } from "~/ui/primitives/button";

export type InspectorTab = "overview" | "relations" | "activity";

function OpenEntityLink({ entity, id }: { entity: Entity; id: string }) {
  if (!isBrowserRoutedEntity(entity)) return null;
  const label = entityLabel(entity);
  return (
    <Button
      variant="ghost"
      size="xs"
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
      Open record <ArrowSquareOutIcon />
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
  const prefix = useId();
  const [visited, setVisited] = useState<ReadonlySet<InspectorTab>>(
    new Set(["overview"]),
  );
  useEffect(() => {
    setVisited((previous) =>
      previous.has(activeTab) ? previous : new Set([...previous, activeTab]),
    );
    if (activeTab !== "overview")
      document
        .getElementById(`${prefix}-${activeTab}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeTab, prefix]);

  return (
    <aside
      aria-label={`${label} inspector`}
      className="h-full w-full max-w-full overflow-y-auto bg-card text-xs text-foreground"
    >
      <header className="sticky top-0 z-20 border-b border-border bg-card p-3">
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
              className="text-sm leading-snug font-semibold break-words text-foreground"
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

      <div id={`${prefix}-overview`}>{overview}</div>
      {hasRelations ? (
        <details
          id={`${prefix}-relations`}
          className="border-t border-border"
          open={activeTab === "relations"}
          onToggle={(event) => {
            if (event.currentTarget.open) onTabChange("relations");
            else if (activeTab === "relations") onTabChange("overview");
          }}
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
            Relations
          </summary>
          {visited.has("relations") || activeTab === "relations"
            ? relations
            : null}
        </details>
      ) : null}
      {hasActivity ? (
        <details
          id={`${prefix}-activity`}
          className="border-t border-border"
          open={activeTab === "activity"}
          onToggle={(event) => {
            if (event.currentTarget.open) onTabChange("activity");
            else if (activeTab === "activity") onTabChange("overview");
          }}
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
            Activity
          </summary>
          {visited.has("activity") || activeTab === "activity"
            ? activity
            : null}
        </details>
      ) : null}
    </aside>
  );
}
