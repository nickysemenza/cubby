"use client";
import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Search, ExternalLink } from "lucide-react";
import { cn } from "~/lib/utils";
import { type InfLocation } from "~/schemas/location";
import { LocationIcon } from "./location-icons";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import Link from "next/link";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";

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
): string[] {
  const matches: string[] = [];
  const term = searchTerm.toLowerCase();

  function search(locs: InfLocation[]) {
    for (const loc of locs) {
      if (loc.name.toLowerCase().includes(term)) {
        matches.push(loc.id);
      }
      if (loc.children) {
        search(loc.children);
      }
    }
  }

  search(locations);
  return matches;
}

interface EnhancedLocationTreeProps {
  className?: string;
  onLocationSelect?: (location: InfLocation) => void;
  selectedLocationId?: string;
}

export function EnhancedLocationTree({
  className,
  onLocationSelect,
  selectedLocationId,
}: EnhancedLocationTreeProps) {
  const [searchTerm, setSearchTerm] = useState("");

  const api = useTRPC();
  const { data: locations } = useQuery(api.location.makeTree.queryOptions());

  // Build parent map for ancestor lookup
  const parentMap = useMemo(
    () =>
      locations
        ? buildParentMap(locations)
        : new Map<string, string | undefined>(),
    [locations],
  );

  // Compute expanded nodes, including auto-expanded ancestors
  const [manualExpandedNodes, setManualExpandedNodes] = useState<Set<string>>(
    new Set(),
  );

  // Auto-expand ancestors for selected location and search matches
  const expandedNodes = useMemo(() => {
    const nodes = new Set(manualExpandedNodes);

    // Expand ancestors of selected location
    if (selectedLocationId && locations) {
      const ancestors = getAncestorIds(selectedLocationId, parentMap);
      ancestors.forEach((id) => nodes.add(id));
    }

    // When searching, expand ancestors of all matching locations
    if (searchTerm && locations) {
      const matchingIds = findMatchingLocationIds(locations, searchTerm);
      for (const matchId of matchingIds) {
        const ancestors = getAncestorIds(matchId, parentMap);
        ancestors.forEach((id) => nodes.add(id));
      }
    }

    return nodes;
  }, [
    manualExpandedNodes,
    selectedLocationId,
    locations,
    parentMap,
    searchTerm,
  ]);

  const toggleNode = (nodeId: string) => {
    const newExpanded = new Set(manualExpandedNodes);
    if (expandedNodes.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setManualExpandedNodes(newExpanded);
  };

  const filterLocations = (
    locations: InfLocation[] | undefined,
    term: string,
  ): InfLocation[] => {
    if (!locations) return [];
    if (!term) return locations;

    return locations.filter((location) => {
      const matchesSearch = location.name
        .toLowerCase()
        .includes(term.toLowerCase());
      const childrenMatch =
        location.children &&
        filterLocations(location.children, term).length > 0;
      return matchesSearch || childrenMatch;
    });
  };

  const filteredLocations = filterLocations(locations, searchTerm);

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* Search */}
      <div className="border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2 transform" />
          <Input
            placeholder="Search locations..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-2">
        {filteredLocations?.map((location) => (
          <LocationTreeNode
            key={location.id}
            location={location}
            level={0}
            expandedNodes={expandedNodes}
            toggleNode={toggleNode}
            onLocationSelect={onLocationSelect}
            selectedLocationId={selectedLocationId}
            searchTerm={searchTerm}
          />
        ))}
      </div>
    </div>
  );
}

interface LocationTreeNodeProps {
  location: InfLocation;
  level: number;
  expandedNodes: Set<string>;
  toggleNode: (nodeId: string) => void;
  onLocationSelect?: (location: InfLocation) => void;
  selectedLocationId?: string;
  searchTerm: string;
}

function LocationTreeNode({
  location,
  level,
  expandedNodes,
  toggleNode,
  onLocationSelect,
  selectedLocationId,
  searchTerm,
}: LocationTreeNodeProps) {
  const hasChildren = location.children && location.children.length > 0;
  const isExpanded = expandedNodes.has(location.id);
  const isSelected = selectedLocationId === location.id;
  const isMatch =
    searchTerm &&
    location.name.toLowerCase().includes(searchTerm.toLowerCase());
  const indent = level * 16;

  const handleClick = () => {
    if (hasChildren) {
      toggleNode(location.id);
    }
    onLocationSelect?.(location);
  };

  // Filter children based on search
  const filteredChildren = location.children?.filter(
    (child) =>
      !searchTerm ||
      child.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (child.children &&
        child.children.some((grandchild) =>
          grandchild.name.toLowerCase().includes(searchTerm.toLowerCase()),
        )),
  );

  return (
    <div>
      <div
        className={cn(
          "hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded p-2 transition-colors",
          isSelected && "bg-primary/10 border-primary/20 border",
          isMatch && !isSelected && "bg-yellow-100 dark:bg-yellow-900/30",
        )}
        style={{ paddingLeft: `${12 + indent}px` }}
        onClick={handleClick}
      >
        {/* Expand/Collapse Icon */}
        <div className="flex h-4 w-4 items-center justify-center">
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : (
            <div className="h-3 w-3" /> // spacer
          )}
        </div>

        {/* Location Icon */}
        <LocationIcon
          type={location.type}
          className="text-muted-foreground"
          size={14}
        />

        {/* Location Name */}
        <span className="flex-1 truncate">{location.name}</span>

        {/* Inventory Count Badge */}
        {(location.totalItemCount ?? 0) > 0 && (
          <Badge variant="secondary" className="text-xs">
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

        {/* Link to detail page */}
        <Link
          href={`/locations/${location.id}`}
          className="text-muted-foreground hover:text-foreground p-1"
          onClick={(e) => e.stopPropagation()}
          title="Open location details"
        >
          <ExternalLink size={14} />
        </Link>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {filteredChildren?.map((child) => (
            <LocationTreeNode
              key={child.id}
              location={child}
              level={level + 1}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
              onLocationSelect={onLocationSelect}
              selectedLocationId={selectedLocationId}
              searchTerm={searchTerm}
            />
          ))}
        </div>
      )}
    </div>
  );
}
