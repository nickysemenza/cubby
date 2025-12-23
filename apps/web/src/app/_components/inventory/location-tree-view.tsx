"use client";
import { useState, useMemo } from "react";
import { NodeRendererProps, Tree } from "react-arborist";
import { Package } from "lucide-react";
import { InfLocation, LocationType } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { LocationIcon } from "../locations/location-icons";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import Link from "next/link";
import { FlexContainer } from "~/components/layout/flex-container";

import { useQuery } from "@tanstack/react-query";

// Tree node types for react-arborist
type LocationTreeNode = {
  id: string;
  name: string;
  nodeType: "location";
  type: LocationType;
  directItemCount: number;
  totalItemCount: number;
  children?: TreeNode[];
};

type InventoryTreeNode = {
  id: string;
  name: string;
  nodeType: "inventory";
  amount: { value: number; unit: string };
  productName: string;
  productId: string;
};

type TreeNode = LocationTreeNode | InventoryTreeNode;

interface LocationTreeProps {
  data: InfLocation[];
}

/** Transform locations to include inventory items as children when expanded */
function transformTreeData(
  locations: InfLocation[],
  showInventory: boolean,
): TreeNode[] {
  return locations.map((location): LocationTreeNode => {
    const inventoryNodes: InventoryTreeNode[] =
      showInventory && location.inventoryItems?.length
        ? location.inventoryItems.map((item) => ({
            id: `inv-${item.id}`,
            name: item.productName,
            nodeType: "inventory" as const,
            amount: item.amount,
            productName: item.productName,
            productId: item.productId,
          }))
        : [];

    const childLocations = location.children
      ? transformTreeData(location.children, showInventory)
      : [];

    return {
      id: location.id,
      name: location.name,
      nodeType: "location",
      type: location.type,
      directItemCount: location.directItemCount ?? 0,
      totalItemCount: location.totalItemCount ?? 0,
      children:
        inventoryNodes.length || childLocations.length
          ? [...inventoryNodes, ...childLocations]
          : undefined,
    };
  });
}

/** Presentational component - renders location tree from provided data */
export const LocationTree = ({ data }: LocationTreeProps) => {
  const [showInventory, setShowInventory] = useState(false);

  const treeData = useMemo(
    () => transformTreeData(data, showInventory),
    [data, showInventory],
  );

  return (
    <div className="space-y-2">
      <FlexContainer align="center" gap={2}>
        <Checkbox
          id="show-inventory"
          checked={showInventory}
          onCheckedChange={(checked) => setShowInventory(checked === true)}
        />
        <Label htmlFor="show-inventory" className="cursor-pointer text-sm">
          Show inventory items
        </Label>
      </FlexContainer>
      <Tree
        key={showInventory ? "with-inventory" : "without-inventory"}
        initialData={treeData}
        disableDrag
        rowHeight={28}
        width={500}
      >
        {Node}
      </Tree>
    </div>
  );
};

/** Data-fetching wrapper - fetches locations via tRPC and renders LocationTree */
const LocationTreeView = () => {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());

  if (!locations.data) return null;

  return <LocationTree data={locations.data} />;
};

function Node({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const data = node.data;

  if (data.nodeType === "inventory") {
    // Render inventory item
    return (
      <FlexContainer style={style} ref={dragHandle} align="center">
        <Link
          href={`/inventory/${data.id.replace("inv-", "")}`}
          className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-2 text-sm"
        >
          <Package size={14} className="shrink-0" />
          <span className="shrink-0">
            {data.amount.value} {data.amount.unit}
          </span>
          <span className="truncate">{data.productName}</span>
        </Link>
      </FlexContainer>
    );
  }

  // Render location
  const { directItemCount, totalItemCount } = data;
  const hasLocationChildren =
    (data.children?.filter((c) => c.nodeType === "location").length ?? 0) > 0;

  return (
    <FlexContainer style={style} ref={dragHandle} align="center" gap={2}>
      <LocationIcon type={data.type} size={14} />
      <span>{data.name}</span>
      {directItemCount > 0 && (
        <Badge variant="secondary" className="h-5 px-1.5 text-xs">
          {directItemCount}
        </Badge>
      )}
      {hasLocationChildren && totalItemCount > directItemCount && (
        <Badge
          variant="outline"
          className="text-muted-foreground h-5 px-1.5 text-xs"
        >
          {totalItemCount} total
        </Badge>
      )}
    </FlexContainer>
  );
}

export default LocationTreeView;
