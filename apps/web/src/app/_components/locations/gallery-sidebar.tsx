import type { InfLocation } from "@cubby/schemas/location";
import {
  ChevronRight,
  ImageIcon,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { LocationTreeRow } from "./location-tree-row";

function buildParentMap(
  locations: InfLocation[],
  parentId?: string,
): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const loc of locations) {
    map.set(loc.id, parentId);
    if (loc.children) {
      const childMap = buildParentMap(loc.children, loc.id);
      childMap.forEach((v, k) => {
        map.set(k, v);
      });
    }
  }
  return map;
}

function getAncestorIds(
  id: string,
  parentMap: Map<string, string | undefined>,
): string[] {
  const ancestors: string[] = [];
  let currentId = parentMap.get(id);
  while (currentId) {
    ancestors.push(currentId);
    currentId = parentMap.get(currentId);
  }
  return ancestors;
}

interface GallerySidebarProps {
  locations: InfLocation[];
  searchTerm: string;
  onLocationClick: (locationId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  activeLocationId?: string;
  searchMatchingIds: Set<string>;
  fadedIds: Set<string>;
  className?: string;
}

export function GallerySidebar({
  locations,
  searchTerm,
  onLocationClick,
  isCollapsed,
  onToggleCollapse,
  activeLocationId,
  searchMatchingIds,
  fadedIds,
  className,
}: GallerySidebarProps) {
  const parentMap = useMemo(() => buildParentMap(locations), [locations]);

  const [manualExpandedNodes, setManualExpandedNodes] = useState<Set<string>>(
    new Set(),
  );

  const expandedNodes = useMemo(() => {
    const nodes = new Set(manualExpandedNodes);

    if (activeLocationId) {
      const ancestors = getAncestorIds(activeLocationId, parentMap);
      ancestors.forEach((id) => {
        nodes.add(id);
      });
    }

    if (searchTerm) {
      for (const matchId of searchMatchingIds) {
        const ancestors = getAncestorIds(matchId, parentMap);
        ancestors.forEach((id) => {
          nodes.add(id);
        });
      }
    }

    return nodes;
  }, [
    manualExpandedNodes,
    activeLocationId,
    parentMap,
    searchTerm,
    searchMatchingIds,
  ]);

  const toggleNode = useCallback((nodeId: string) => {
    setManualExpandedNodes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      return newSet;
    });
  }, []);

  const activeItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeLocationId && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeLocationId]);

  if (isCollapsed) {
    return (
      <div
        className={cn(
          "hidden flex-col border-r bg-muted/30 transition-all duration-300 md:flex",
          className,
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="m-2 transition-colors hover:bg-primary/10"
          title="Expand sidebar"
        >
          <PanelLeft className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "hidden h-full min-h-0 w-56 flex-col overflow-hidden border-r bg-muted/30 transition-all duration-300 md:flex lg:w-64",
        className,
      )}
    >
      {/* Header */}
      <Row align="center" justify="between" className="border-b px-2 py-2">
        <Row align="center" gap="sm">
          <ImageIcon className="size-3.5 text-slate" />
          <span className="font-semibold text-foreground text-sm tracking-tight">
            Locations
          </span>
        </Row>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="transition-colors hover:bg-primary/10"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </Row>

      {/* Tree */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div>
          {locations.map((location) => (
            <SidebarTreeNode
              key={location.id}
              location={location}
              level={0}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
              onLocationClick={onLocationClick}
              activeLocationId={activeLocationId}
              searchMatchingIds={searchMatchingIds}
              fadedIds={fadedIds}
              searchTerm={searchTerm}
              activeItemRef={activeItemRef}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface SidebarTreeNodeProps {
  location: InfLocation;
  level: number;
  expandedNodes: Set<string>;
  toggleNode: (nodeId: string) => void;
  onLocationClick: (locationId: string) => void;
  activeLocationId?: string;
  searchMatchingIds: Set<string>;
  fadedIds: Set<string>;
  searchTerm: string;
  activeItemRef: React.RefObject<HTMLDivElement | null>;
}

function SidebarTreeNode({
  location,
  level,
  expandedNodes,
  toggleNode,
  onLocationClick,
  activeLocationId,
  searchMatchingIds,
  fadedIds,
  searchTerm,
  activeItemRef,
}: SidebarTreeNodeProps) {
  const hasChildren = location.children && location.children.length > 0;
  const isExpanded = expandedNodes.has(location.id);
  const isActive = activeLocationId === location.id;
  const isSearchMatch = searchMatchingIds.has(location.id);
  const isFaded = fadedIds.has(location.id);

  const itemCount = location.directItemCount ?? 0;

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      toggleNode(location.id);
    }
  };

  const handleLocationClick = () => {
    onLocationClick(location.id);
  };

  // Filter children based on search
  const visibleChildren = useMemo(() => {
    if (!searchTerm || !location.children) return location.children;
    return location.children;
  }, [location.children, searchTerm]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleLocationClick();
    }
  };

  return (
    <div>
      {/* Non-semantic role="button" wrapper on purpose: the row is clickable
          but contains a nested <button> for expand/collapse, so it can't be a
          real <button> (no nested interactive controls). */}
      <LocationTreeRow
        ref={isActive ? activeItemRef : undefined}
        location={location}
        depth={level}
        primaryMeta={location.type.replaceAll("-", " ")}
        leading={
          <button
            type="button"
            onClick={handleExpandClick}
            // Only real toggles (hasChildren) get a name/state; leaf-node
            // buttons stay unlabeled — they're `invisible` (visibility:
            // hidden), which already drops them from the tab order, so
            // labeling them would just add noise to the a11y tree.
            aria-label={
              hasChildren
                ? `${isExpanded ? "Collapse" : "Expand"} ${location.name}`
                : undefined
            }
            aria-expanded={hasChildren ? isExpanded : undefined}
            className={cn(
              "flex size-5 items-center justify-center transition-transform duration-150 hover:bg-muted-foreground/20",
              !hasChildren && "invisible",
              isExpanded && "rotate-0",
            )}
          >
            {hasChildren && (
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform duration-150",
                  isExpanded && "rotate-90",
                )}
              />
            )}
          </button>
        }
        trailing={
          (location.totalItemCount ?? 0) > 0 && (
            <Badge variant={isActive ? "secondary" : "outline"}>
              {hasChildren ? (
                <>
                  <span>{itemCount}</span>
                  <span className="opacity-50">/</span>
                  <span className="opacity-50">{location.totalItemCount}</span>
                </>
              ) : (
                <span>{itemCount}</span>
              )}
            </Badge>
          )
        }
        role="button"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={cn(
          "group relative cursor-pointer border-[var(--border)] border-b py-3 pr-3 text-sm" /* tight: compact gallery tree row */,
          "transition-colors duration-150 ease-out",
          !isActive && "hover:bg-muted",
          isActive && "bg-primary/5 text-primary",
          isSearchMatch && !isActive && "bg-accent/30",
          isFaded && "opacity-40",
        )}
        onClick={handleLocationClick}
      />

      {/* Children with animation */}
      {hasChildren && (
        <div
          className={cn(
            "overflow-hidden transition-all duration-150",
            isExpanded ? "opacity-100" : "h-0 opacity-0",
          )}
        >
          {visibleChildren?.map((child) => (
            <SidebarTreeNode
              key={child.id}
              location={child}
              level={level + 1}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
              onLocationClick={onLocationClick}
              activeLocationId={activeLocationId}
              searchMatchingIds={searchMatchingIds}
              fadedIds={fadedIds}
              searchTerm={searchTerm}
              activeItemRef={activeItemRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
