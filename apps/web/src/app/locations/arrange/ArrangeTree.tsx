import {
  type LocationShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { ArrowBendDownRightIcon as CornerDownRight } from "@phosphor-icons/react/dist/csr/ArrowBendDownRight";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { useRef } from "react";

import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";

import { pathToNode } from "./arrange-tree-utils";
import { ArrangeItemChip } from "./ArrangeItemChip";
import { ArrangeLocationRow } from "./ArrangeLocationRow";
import { UnknownDock } from "./UnknownDock";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

interface ArrangeTreeProps {
  roots: InfLocation[];
  /** Max levels of children rendered below the zoom root before collapsing. */
  depth: number;
  unknownRoot: InfLocation | null;
  /** The zoomed-to location, from the URL. Undefined = Home. */
  at?: LocationShortcode;
  onSelect: (at: LocationShortcode | undefined) => void;
}

function resolveZoomPath(
  roots: InfLocation[],
  at: LocationShortcode | undefined,
  home: InfLocation | null,
) {
  const ancestors: InfLocation[] = [];
  let level = roots;
  for (const id of at ? pathToNode(roots, at) : []) {
    const node = level.find((candidate) => candidate.id === id);
    if (!node) break;
    if (node.id !== home?.id) ancestors.push(node);
    level = node.children ?? [];
  }
  return ancestors;
}

/**
 * The Tree view of the arrange surface: a zoomable, indented location tree
 * (as opposed to the Board's Miller columns) with a breadcrumb trail and a
 * docked "Unknown" staging panel. The parent dnd-kit boundary owns commits;
 * this component registers typed draggables/drop targets while the zoom lives
 * in the URL shared with the Board's column path.
 */
export function ArrangeTree({
  roots,
  depth,
  unknownRoot,
  at,
  onSelect,
}: ArrangeTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // The URL carries only the zoomed-to node; its ancestors are whatever the
  // live tree says they are, so a location moved underneath us stays zoomed
  // (under its new parent) and a deleted one resolves to Home.
  const home = roots[0] ?? null;
  const ancestors = resolveZoomPath(roots, at, home);
  const resolvedZoom = ancestors.map((n) => n.id);
  const zoomRoot = ancestors[ancestors.length - 1] ?? home;

  const displayedChildren = (zoomRoot?.children ?? []).filter(
    (n) => !unknownRoot || n.id !== unknownRoot.id,
  );
  const zoomItems = zoomRoot?.inventoryItems ?? [];

  return (
    <Row gap="md" className="min-w-0 flex-1 flex-col lg:flex-row">
      <Stack gap="sm" className="min-w-0 flex-1">
        <Row align="center" gap="xs" wrap className="text-sm">
          <BreadcrumbSegment
            label={home?.name ?? "Home"}
            locationId={home?.id ?? null}
            roots={roots}
            active={resolvedZoom.length === 0}
            onClick={() => onSelect(undefined)}
          />
          {ancestors.map((node, i) => (
            <Row key={node.id} align="center" gap="xs">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <BreadcrumbSegment
                label={node.name}
                locationId={node.id}
                roots={roots}
                active={i === ancestors.length - 1}
                onClick={() => onSelect(node.id)}
              />
            </Row>
          ))}
        </Row>

        <div
          ref={scrollRef}
          data-arrange-scroll
          className="min-h-0 flex-1 overflow-y-auto rounded-none border border-[var(--border)] bg-background p-2"
        >
          {zoomRoot && resolvedZoom.length > 0 && zoomItems.length > 0 && (
            <Stack gap="tight" className="mb-2">
              {zoomItems.map((item) => (
                <ArrangeItemChip
                  key={item.id}
                  item={item}
                  sourceLocationId={parseShortcodeFor("location", zoomRoot.id)}
                  roots={roots}
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
              onDrill={onSelect}
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
                    roots={roots}
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
  const { setNodeRef, isOver } = useArrangeDropTarget({
    roots,
    locationId: node.id,
  });

  const count = node.childCount ?? node.children?.length ?? 0;

  return (
    <Row
      ref={setNodeRef}
      align="center"
      gap="sm"
      onClick={() => onDrill(node.id)}
      className={cn(
        "cursor-pointer rounded py-1 text-xs text-muted-foreground hover:text-foreground",
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
  const { setNodeRef, isOver } = useArrangeDropTarget({ roots, locationId });

  return (
    <button
      ref={setNodeRef}
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
