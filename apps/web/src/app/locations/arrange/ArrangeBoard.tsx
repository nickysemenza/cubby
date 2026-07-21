import type { LocationId } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { ChevronRight, Home } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { ArrangeColumn } from "./ArrangeColumn";
import { findNode } from "./arrange-tree-utils";
import { useAutoScroll } from "./use-arrange-dnd";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

interface ArrangeBoardProps {
  roots: InfLocation[];
  depth: number;
  unknownRoot: InfLocation | null;
}

interface ColumnModel {
  locationId: LocationId | null;
  headerLocation: InfLocation | null;
  nodes: InfLocation[];
  items: InfLocation["inventoryItems"];
  activeChildId: LocationId | null;
}

export function ArrangeBoard({ roots, depth, unknownRoot }: ArrangeBoardProps) {
  const [columnPath, setColumnPath] = useState<LocationId[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(scrollRef);

  const rootsMain = useMemo(
    () => roots.filter((r) => r.id !== unknownRoot?.id),
    [roots, unknownRoot],
  );

  // Drop any path segment that no longer resolves (e.g. after a move relocated
  // a location out from under an open column).
  const validPath = useMemo(() => {
    const out: LocationId[] = [];
    for (const id of columnPath) {
      if (findNode(roots, id)) out.push(id);
      else break;
    }
    return out;
  }, [columnPath, roots]);

  const columns = useMemo<ColumnModel[]>(() => {
    const cols: ColumnModel[] = [
      {
        locationId: null,
        headerLocation: null,
        nodes: rootsMain,
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
  }, [rootsMain, roots, validPath]);

  const openChildAt = (columnIndex: number, childId: LocationId) => {
    setColumnPath([...validPath.slice(0, columnIndex), childId]);
  };

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
        path={validPath}
        onJump={(prefixLength) =>
          setColumnPath(validPath.slice(0, prefixLength))
        }
      />
      <div
        ref={scrollRef}
        className="flex min-h-[24rem] flex-1 gap-2 overflow-x-auto pb-2"
      >
        {visibleColumns.map((col, i) => (
          <ArrangeColumn
            key={col.locationId ?? "__home__"}
            locationId={col.locationId}
            headerLocation={col.headerLocation}
            nodes={col.nodes}
            items={col.items ?? []}
            activeChildId={col.activeChildId}
            roots={roots}
            onOpenChild={(childId) => openChildAt(hiddenLeft + i, childId)}
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
  path: LocationId[];
  /** Jump to a path prefix of the given length (0 = Home). */
  onJump: (prefixLength: number) => void;
}

function BoardBreadcrumb({ roots, path, onJump }: BoardBreadcrumbProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <BreadcrumbCrumb
        roots={roots}
        locationId={null}
        label="Home"
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
  locationId: LocationId | null;
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
