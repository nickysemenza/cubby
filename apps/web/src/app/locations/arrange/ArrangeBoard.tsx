import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { ChevronRight, Home } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useAutoScroll } from "~/app/_components/hooks/use-auto-scroll";
import { cn } from "~/lib/utils";
import { ArrangeColumn } from "./ArrangeColumn";
import { findNode, pathToNode } from "./arrange-tree-utils";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

interface ArrangeBoardProps {
  roots: InfLocation[];
  depth: number;
  unknownRoot: InfLocation | null;
  /** The drilled-to location, from the URL. Undefined = Home. */
  at?: LocationShortcode;
  onSelect: (at: LocationShortcode | undefined) => void;
}

interface ColumnModel {
  locationId: LocationShortcode | null;
  headerLocation: InfLocation | null;
  nodes: InfLocation[];
  items: InfLocation["inventoryItems"];
  activeChildId: LocationShortcode | null;
}

export function ArrangeBoard({
  roots,
  depth,
  unknownRoot,
  at,
  onSelect,
}: ArrangeBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(scrollRef);

  const home = roots[0] ?? null;
  const homeChildren = useMemo(
    () =>
      (home?.children ?? []).filter((child) => child.id !== unknownRoot?.id),
    [home, unknownRoot],
  );

  // The URL carries only the drilled-to leaf; the columns to its left are
  // whatever the live tree says its ancestors are. That resolves itself against
  // every mutation for free — a location dragged elsewhere keeps its column
  // open under its new parent, where the old stored-path walk would have
  // truncated — and a location that's gone resolves to `[]`, i.e. Home.
  const validPath = useMemo(() => {
    if (!at || !home) return [];
    // The URL drills below Home. Keep the structural root in the rendered
    // breadcrumb/header, not as an extra Miller column.
    return pathToNode(roots, at).filter((id) => id !== home.id);
  }, [at, home, roots]);

  const columns = useMemo<ColumnModel[]>(() => {
    const cols: ColumnModel[] = [
      {
        locationId: home?.id ?? null,
        headerLocation: home,
        nodes: homeChildren,
        items: [],
        activeChildId: validPath[0] ?? null,
      },
    ];
    for (let k = 0; k < validPath.length; k++) {
      const parentId = validPath[k];
      if (!parentId) break;
      const parent = findNode(roots, parentId);
      if (!parent) break;
      cols.push({
        locationId: parentId,
        headerLocation: parent,
        nodes: parent.children ?? [],
        items: parent.inventoryItems ?? [],
        activeChildId: validPath[k + 1] ?? null,
      });
    }
    return cols;
  }, [home, homeChildren, roots, validPath]);

  // Show only the rightmost `depth` columns; the breadcrumb reaches the rest.
  const hiddenLeft = Math.max(0, columns.length - depth);
  const visibleColumns = columns.slice(hiddenLeft);

  // Keep the newest column in view when the cascade grows. The effect body
  // doesn't read validPath.length — it's the reactive trigger (scroll right
  // whenever a column opens/closes), which is exactly the intent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: length is the intended trigger, not a read
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [validPath.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <BoardBreadcrumb
        roots={roots}
        home={home}
        path={validPath}
        onJump={(prefixLength) => onSelect(validPath[prefixLength - 1])}
      />
      <div
        ref={scrollRef}
        className="flex min-h-[24rem] flex-1 gap-2 overflow-x-auto pb-2"
      >
        {visibleColumns.map((col) => (
          <ArrangeColumn
            key={col.locationId ?? "__home__"}
            locationId={col.locationId}
            headerLocation={col.headerLocation}
            nodes={col.nodes}
            items={col.items ?? []}
            activeChildId={col.activeChildId}
            roots={roots}
            onOpenChild={onSelect}
          />
        ))}
        {unknownRoot && (
          <ArrangeColumn
            locationId={unknownRoot.id}
            headerLocation={unknownRoot}
            nodes={unknownRoot.children ?? []}
            items={unknownRoot.inventoryItems ?? []}
            activeChildId={null}
            roots={roots}
            onOpenChild={() => {}}
            pinned
          />
        )}
      </div>
    </div>
  );
}

interface BoardBreadcrumbProps {
  roots: InfLocation[];
  home: InfLocation | null;
  path: LocationShortcode[];
  /** Jump to a path prefix of the given length (0 = Home). */
  onJump: (prefixLength: number) => void;
}

function BoardBreadcrumb({ roots, home, path, onJump }: BoardBreadcrumbProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <BreadcrumbCrumb
        roots={roots}
        locationId={home?.id ?? null}
        label={home?.name ?? "Home"}
        icon={<Home className="size-3.5" />}
        onClick={() => onJump(0)}
      />
      {path.map((id, i) => {
        const node = findNode(roots, id);
        return (
          <span key={id} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 text-muted-foreground" />
            <BreadcrumbCrumb
              roots={roots}
              locationId={id}
              label={node?.name ?? "…"}
              onClick={() => onJump(i + 1)}
            />
          </span>
        );
      })}
    </div>
  );
}

interface BreadcrumbCrumbProps {
  roots: InfLocation[];
  locationId: LocationShortcode | null;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}

/** A breadcrumb segment that is also a drop target (reparent to it / to Home). */
function BreadcrumbCrumb({
  roots,
  locationId,
  label,
  icon,
  onClick,
}: BreadcrumbCrumbProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const isOver = useArrangeDropTarget({ ref, roots, locationId });

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground" /* tight: crumb */,
        isOver && "bg-primary/15 text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
