import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Link } from "@tanstack/react-router";
import { useId, useEffect, useState, type ReactNode } from "react";

import {
  EntityIcon,
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import {
  SidePanel,
  SidePanelIconTile,
  SidePanelSection,
  stepCurrentTableRow,
} from "~/ui/overlays/side-panel";
import { Button } from "~/ui/primitives/button";
import {
  domainForEntity,
  domainWayfinding,
} from "~/ui/navigation/domain-wayfinding";

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
      Open <ArrowSquareOutIcon />
    </Button>
  );
}

const domainColor = (entity: Entity) => {
  const domain = domainForEntity(entity);
  return domain ? `var(${domainWayfinding(domain).accentToken})` : undefined;
};

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
  onPrev = () => void stepCurrentTableRow(-1),
  onNext = () => void stepCurrentTableRow(1),
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
  /** J/K; defaults step the docked table's current row. */
  onPrev?: () => void;
  onNext?: () => void;
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
  const disclosure = (tab: Exclude<InspectorTab, "overview">) => ({
    id: `${prefix}-${tab}`,
    open: activeTab === tab,
    onOpenChange: (open: boolean) => {
      if (open) onTabChange(tab);
      else if (activeTab === tab) onTabChange("overview");
    },
  });

  return (
    <SidePanel
      label={`${label} inspector`}
      code={id}
      title={name ?? label}
      eyebrow={eyebrow ?? label}
      icon={
        leading ?? (
          <SidePanelIconTile color={domainColor(entity)}>
            <EntityIcon entity={entity} />
          </SidePanelIconTile>
        )
      }
      actions={<OpenEntityLink entity={entity} id={id} />}
      onClose={onClose}
      closeLabel="Close inspector"
      onPrev={onPrev}
      onNext={onNext}
    >
      <div id={`${prefix}-overview`}>{overview}</div>
      {hasRelations ? (
        <SidePanelSection title="Relations" {...disclosure("relations")}>
          {visited.has("relations") || activeTab === "relations"
            ? relations
            : null}
        </SidePanelSection>
      ) : null}
      {hasActivity ? (
        <SidePanelSection title="Activity" {...disclosure("activity")}>
          {visited.has("activity") || activeTab === "activity"
            ? activity
            : null}
        </SidePanelSection>
      ) : null}
    </SidePanel>
  );
}
