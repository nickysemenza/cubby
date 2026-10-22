import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
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
  useTableRowStep,
} from "~/ui/overlays/side-panel";
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
      Open <ArrowSquareOutIcon />
    </Button>
  );
}

/** Pointer twins of J/K, named for the entity so they never collide with a
 * host's own record stepper on the same page. */
function RecordStepButtons({
  noun,
  onPrev,
  onNext,
}: {
  noun: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        mobileSize="compact"
        aria-label={`Previous ${noun}`}
        aria-keyshortcuts="K"
        title="Previous (K)"
        onClick={onPrev}
      >
        <CaretUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        mobileSize="compact"
        aria-label={`Next ${noun}`}
        aria-keyshortcuts="J"
        title="Next (J)"
        onClick={onNext}
      >
        <CaretDownIcon />
      </Button>
    </>
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
  onPrev,
  onNext,
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
  const step = useTableRowStep();
  const label = entityLabel(entity);
  const prev = onPrev ?? (() => void step(-1));
  const next = onNext ?? (() => void step(1));
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
          <SidePanelIconTile>
            <EntityIcon entity={entity} />
          </SidePanelIconTile>
        )
      }
      actions={
        <>
          <RecordStepButtons
            noun={label.toLowerCase()}
            onPrev={prev}
            onNext={next}
          />
          <OpenEntityLink entity={entity} id={id} />
        </>
      }
      onClose={onClose}
      closeLabel="Close inspector"
      onPrev={prev}
      onNext={next}
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
