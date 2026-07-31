import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { ChevronRight, CornerDownRight } from "lucide-react";
import { useRef, useState } from "react";
import { useAutoScroll } from "~/app/_components/hooks/use-auto-scroll";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";
import { ArrangeItemChip } from "./ArrangeItemChip";
import { ArrangeLocationRow } from "./ArrangeLocationRow";
import { childrenOf, pathToNode } from "./arrange-tree-utils";
import { UnknownDock } from "./UnknownDock";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

interface ArrangeTreeProps {
  roots: InfLocation[];
  /** Max levels of children rendered below the zoom root before collapsing. */
  depth: number;
  unknownRoot: InfLocation | null;
}

/**
 * The Tree view of the arrange surface: a zoomable, indented location tree
 * (as opposed to the Board's Miller columns) with a breadcrumb trail and a
 * docked "Unknown" staging panel. Drag/drop mutations are dispatched globally
 * by `useArrangeDnd`'s monitor (registered by the parent) — this component
 * only registers draggables/drop targets and local UI state (zoom, hover).
 */
export function ArrangeTree({ roots, depth, unknownRoot }: ArrangeTreeProps) {
  const [zoom, setZoom] = useState<LocationShortcode[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(scrollRef);

  // Resolve the zoom path to actual nodes, bailing out if the tree changed
  // underneath us (e.g. the zoomed-into location was moved/deleted).
  const ancestors: InfLocation[] = [];
  {
    let level = roots;
    for (const id of zoom) {
      const node = level.find((n) => n.id === id);
      if (!node) break;
      ancestors.push(node);
      level = node.children ?? [];
    }
  }
  const resolvedZoom = ancestors.map((n) => n.id);
  const zoomRoot = ancestors[ancestors.length - 1] ?? null;

  const displayedChildren = (
    resolvedZoom.length === 0 ? roots : childrenOf(roots, resolvedZoom)
  ).filter((n) => !unknownRoot || n.id !== unknownRoot.id);
  const zoomItems = zoomRoot?.inventoryItems ?? [];

  // Zoom to the clicked node's FULL root→node path. The drill button and the
  // spring-load-on-hover both fire at any rendered depth (grandchildren render
  // before the collapse cap), so appending the id would skip intermediate
  // ancestors and break zoom resolution — resolve the whole chain instead.
  function handleDrill(id: LocationShortcode) {
    setZoom(pathToNode(roots, id));
  }

  return (
    <Row gap="md" className="min-w-0 flex-1 flex-col lg:flex-row">
      <Stack gap="sm" className="min-w-0 flex-1">
        <Row align="center" gap="xs" wrap className="text-sm">
          <BreadcrumbSegment
            label="Home"
            locationId={null}
            roots={roots}
            active={resolvedZoom.length === 0}
            onClick={() => setZoom([])}
          />
          {ancestors.map((node, i) => (
            <Row key={node.id} align="center" gap="xs">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <BreadcrumbSegment
                label={node.name}
                locationId={node.id}
                roots={roots}
                active={i === ancestors.length - 1}
                onClick={() => setZoom(resolvedZoom.slice(0, i + 1))}
              />
            </Row>
          ))}
        </Row>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto rounded border border-[var(--border)] bg-background p-2"
        >
          {resolvedZoom.length > 0 && zoomItems.length > 0 && (
            <Stack gap="tight" className="mb-2">
              {zoomItems.map((item) => (
                <ArrangeItemChip
                  key={item.id}
                  item={item}
                  sourceLocationId={zoomRoot?.id as LocationShortcode}
                />
              ))}
            </Stack>
          )}

          {displayedChildren.length === 0 && zoomItems.length === 0 ? (
            <Description size="sm" className="p-4 text-center">
              Nothing here yet
            </Description>
          ) : (
            <TreeLevel
              nodes={displayedChildren}
              roots={roots}
              level={0}
              maxDepth={depth}
              onDrill={handleDrill}
            />
          )}
        </div>
      </Stack>

      <UnknownDock unknownRoot={unknownRoot} roots={roots} />
    </Row>
  );
}

interface TreeLevelProps {
  nodes: InfLocation[];
  roots: InfLocation[];
  /** Depth relative to the zoom root — 0 for its direct children. */
  level: number;
  maxDepth: number;
  onDrill: (id: LocationShortcode) => void;
}

/** Recursively renders one indentation level of the tree, capped at `maxDepth`. */
function TreeLevel({ nodes, roots, level, maxDepth, onDrill }: TreeLevelProps) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = (node.children?.length ?? 0) > 0;
        const items = node.inventoryItems ?? [];
        const nextLevel = level + 1;
        const atCap = hasChildren && nextLevel >= maxDepth;

        return (
          <div key={node.id}>
            <ArrangeLocationRow
              node={node}
              roots={roots}
              depth={level}
              onDrill={onDrill}
            />
            {items.length > 0 && (
              <Stack
                gap="tight"
                className="py-1"
                style={{ paddingLeft: `${nextLevel * 1.25 + 1.25}rem` }}
              >
                {items.map((item) => (
                  <ArrangeItemChip
                    key={item.id}
                    item={item}
                    sourceLocationId={node.id}
                  />
                ))}
              </Stack>
            )}
            {hasChildren &&
              (atCap ? (
                <CollapsedRow
                  node={node}
                  roots={roots}
                  depth={nextLevel}
                  onDrill={onDrill}
                />
              ) : (
                <TreeLevel
                  nodes={node.children ?? []}
                  roots={roots}
                  level={nextLevel}
                  maxDepth={maxDepth}
                  onDrill={onDrill}
                />
              ))}
          </div>
        );
      })}
    </>
  );
}

interface CollapsedRowProps {
  node: InfLocation;
  roots: InfLocation[];
  depth: number;
  onDrill: (id: LocationShortcode) => void;
}

/**
 * Stands in for a node's children once the render-depth cap is hit. Still a
 * full drop target for `node.id` (dropping "into" it doesn't require
 * expanding it first), and clicking/drilling expands the real tree there.
 */
function CollapsedRow({ node, roots, depth, onDrill }: CollapsedRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isOver = useArrangeDropTarget({
    ref,
    roots,
    locationId: node.id,
  });

  const count = node.childCount ?? node.children?.length ?? 0;

  return (
    <Row
      ref={ref}
      align="center"
      gap="sm"
      onClick={() => onDrill(node.id)}
      className={cn(
        "cursor-pointer rounded py-1 text-muted-foreground text-xs hover:text-foreground",
        isOver && "bg-primary/10 text-primary",
      )}
      style={{ paddingLeft: `${depth * 1.25 + 1.25}rem` }}
    >
      <CornerDownRight className="size-3.5 shrink-0" />
      <span>{count} more inside</span>
    </Row>
  );
}

interface BreadcrumbSegmentProps {
  label: string;
  locationId: LocationShortcode | null;
  roots: InfLocation[];
  active: boolean;
  onClick: () => void;
}

/** One "Home / A / B" breadcrumb segment — also a drop target for its location. */
function BreadcrumbSegment({
  label,
  locationId,
  roots,
  active,
  onClick,
}: BreadcrumbSegmentProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const isOver = useArrangeDropTarget({ ref, roots, locationId });

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-1 py-0.5 text-muted-foreground hover:text-foreground" /* tight: breadcrumb */,
        active && "font-medium text-foreground",
        isOver && "bg-primary/10 text-primary",
      )}
    >
      {label}
    </button>
  );
}
