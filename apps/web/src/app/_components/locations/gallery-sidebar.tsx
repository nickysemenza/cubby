"use client";

import { useState, useMemo, useCallback } from "react";
import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { type InfLocation } from "~/schemas/location";
import { LocationIcon } from "./location-icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

/** Build a map of location id -> parent id by traversing the tree */
function buildParentMap(
  locations: InfLocation[],
  parentId?: string,
): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const loc of locations) {
    map.set(loc.id, parentId);
    if (loc.children) {
      const childMap = buildParentMap(loc.children, loc.id);
      childMap.forEach((v, k) => map.set(k, v));
    }
  }
  return map;
}

/** Get all ancestor IDs for a given location */
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

/** Find all location IDs that match the search term */
function findMatchingLocationIds(
  locations: InfLocation[],
  searchTerm: string,
): Set<string> {
  const matches = new Set<string>();
  const term = searchTerm.toLowerCase();

  function search(locs: InfLocation[]) {
    for (const loc of locs) {
      if (loc.name.toLowerCase().includes(term)) {
        matches.add(loc.id);
      }
      if (loc.children) {
        search(loc.children);
      }
    }
  }

  search(locations);
  return matches;
}

interface GallerySidebarProps {
  locations: InfLocation[];
  searchTerm: string;
  onLocationClick: (locationId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  activeLocationId?: string;
  className?: string;
}

export function GallerySidebar({
  locations,
  searchTerm,
  onLocationClick,
  isCollapsed,
  onToggleCollapse,
  activeLocationId,
  className,
}: GallerySidebarProps) {
  // Build parent map for ancestor lookup
  const parentMap = useMemo(() => buildParentMap(locations), [locations]);

  // Find matching location IDs for search highlighting
  const matchingIds = useMemo(
    () =>
      searchTerm
        ? findMatchingLocationIds(locations, searchTerm)
        : new Set<string>(),
    [locations, searchTerm],
  );

  // Compute expanded nodes, including auto-expanded ancestors
  const [manualExpandedNodes, setManualExpandedNodes] = useState<Set<string>>(
    new Set(),
  );

  // Auto-expand ancestors for active location and search matches
  const expandedNodes = useMemo(() => {
    const nodes = new Set(manualExpandedNodes);

    // Expand ancestors of active location
    if (activeLocationId) {
      const ancestors = getAncestorIds(activeLocationId, parentMap);
      ancestors.forEach((id) => nodes.add(id));
    }

    // When searching, expand ancestors of all matching locations
    if (searchTerm) {
      for (const matchId of matchingIds) {
        const ancestors = getAncestorIds(matchId, parentMap);
        ancestors.forEach((id) => nodes.add(id));
      }
    }

    return nodes;
  }, [
    manualExpandedNodes,
    activeLocationId,
    parentMap,
    searchTerm,
    matchingIds,
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

  if (isCollapsed) {
    return (
      <div className={cn("bg-muted/30 flex flex-col border-r", className)}>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="m-2"
          title="Expand sidebar"
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "bg-muted/30 flex w-52 flex-col border-r lg:w-60",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <span className="text-muted-foreground text-xs font-medium">
          Navigation
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="h-6 w-6"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {locations.map((location) => (
            <SidebarTreeNode
              key={location.id}
              location={location}
              level={0}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
              onLocationClick={onLocationClick}
              activeLocationId={activeLocationId}
              matchingIds={matchingIds}
              searchTerm={searchTerm}
            />
          ))}
        </div>
      </ScrollArea>
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
  matchingIds: Set<string>;
  searchTerm: string;
}

function SidebarTreeNode({
  location,
  level,
  expandedNodes,
  toggleNode,
  onLocationClick,
  activeLocationId,
  matchingIds,
  searchTerm,
}: SidebarTreeNodeProps) {
  const hasChildren = location.children && location.children.length > 0;
  const isExpanded = expandedNodes.has(location.id);
  const isActive = activeLocationId === location.id;
  const isMatch = matchingIds.has(location.id);
  const indent = level * 10;

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

    // Show all children when searching
    return location.children;
  }, [location.children, searchTerm]);

  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors",
          "hover:bg-muted",
          isActive && "bg-primary/10 text-primary",
          isMatch && !isActive && "bg-yellow-100/50 dark:bg-yellow-900/20",
        )}
        style={{ paddingLeft: `${6 + indent}px` }}
        onClick={handleLocationClick}
      >
        {/* Expand/Collapse Icon */}
        <button
          onClick={handleExpandClick}
          className={cn(
            "hover:bg-muted-foreground/20 flex h-4 w-4 items-center justify-center rounded",
            !hasChildren && "invisible",
          )}
        >
          {hasChildren &&
            (isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            ))}
        </button>

        {/* Location Icon */}
        <LocationIcon
          type={location.type}
          className="text-muted-foreground h-3 w-3 flex-shrink-0"
        />

        {/* Location Name */}
        <span className="flex-1 truncate">{location.name}</span>

        {/* Item Count Badge - shows direct (total) like enhanced tree */}
        {(location.totalItemCount ?? 0) > 0 && (
          <Badge
            variant="secondary"
            className="h-4 min-w-[16px] justify-center px-1 text-[9px]"
          >
            {hasChildren ? (
              <>
                {location.directItemCount ?? 0}
                <span className="text-muted-foreground/60 ml-0.5">
                  ({location.totalItemCount})
                </span>
              </>
            ) : (
              (location.directItemCount ?? 0)
            )}
          </Badge>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && visibleChildren && (
        <div>
          {visibleChildren.map((child) => (
            <SidebarTreeNode
              key={child.id}
              location={child}
              level={level + 1}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
              onLocationClick={onLocationClick}
              activeLocationId={activeLocationId}
              matchingIds={matchingIds}
              searchTerm={searchTerm}
            />
          ))}
        </div>
      )}
    </div>
  );
}
