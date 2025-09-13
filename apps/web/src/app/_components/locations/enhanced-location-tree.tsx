"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { cn } from "~/lib/utils";
import { type InfLocation } from "~/schemas/location";
import { LocationIcon } from "./location-icons";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import Link from "next/link";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";

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
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const api = useTRPC();
  const { data: locations } = useQuery(api.location.makeTree.queryOptions());

  const toggleNode = (nodeId: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setExpandedNodes(newExpanded);
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
        <Link
          href={`/locations/${location.id}`}
          className="flex-1 truncate hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {location.name}
        </Link>

        {/* Children Count Badge */}
        {hasChildren && (
          <Badge variant="secondary" className="text-xs">
            {location.children!.length}
          </Badge>
        )}
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
