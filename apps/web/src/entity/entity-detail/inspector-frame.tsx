import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Link } from "@tanstack/react-router";
import { useId, useEffect, useState, type ReactNode } from "react";

import {
  EntityIcon,
  browserEntityDetailLink,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { PrevNextButtons } from "~/ui/navigation/prev-next-buttons";
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
      render={<Link {...browserEntityDetailLink(entity, id)} />}
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
    <PrevNextButtons
      previous={{ label: `Previous ${noun}`, onClick: onPrev, shortcut: "K" }}
      next={{ label: `Next ${noun}`, onClick: onNext, shortcut: "J" }}
      compact
    />
  );
}

/** Shared chrome for every responsive canonical-row inspector. */
export function EntityInspectorFrame({
  entity,
  id,
  name,
  resolving = false,
  eyebrow,
  leading,
  headerActions,
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
  /** The record is still loading: `name`, if any, is the row's copy of it. */
  resolving?: boolean;
  eyebrow?: ReactNode;
  leading?: ReactNode;
  /** The record's primary verb and Edit, always in the header. */
  headerActions?: ReactNode;
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
      // Never "Product / Product": a loading record says so rather than
      // printing its type as its name.
      title={
        name ?? (
          <span className="font-normal text-muted-foreground">
            {resolving ? `Loading ${label.toLowerCase()}…` : label}
          </span>
        )
      }
      eyebrow={eyebrow ?? (resolving && name ? `${label} · loading` : label)}
      headerRow={headerActions}
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
