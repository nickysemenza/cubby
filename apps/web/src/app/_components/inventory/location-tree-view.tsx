"use client";
import { NodeRendererProps, Tree } from "react-arborist";
import { InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { LocationIcon } from "../locations/location-icons";

import { useQuery } from "@tanstack/react-query";

interface LocationTreeProps {
  data: InfLocation[];
}

/** Presentational component - renders location tree from provided data */
export const LocationTree = ({ data }: LocationTreeProps) => {
  return (
    <Tree initialData={data} disableDrag>
      {Node}
    </Tree>
  );
};

/** Data-fetching wrapper - fetches locations via tRPC and renders LocationTree */
const LocationTreeView = () => {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());

  if (!locations.data) return null;

  return <LocationTree data={locations.data} />;
};

function Node({ node, style, dragHandle }: NodeRendererProps<InfLocation>) {
  return (
    <div style={style} ref={dragHandle} className="flex items-center gap-2">
      <LocationIcon type={node.data.type} size={14} />
      <span>{node.data.name}</span>
    </div>
  );
}

export default LocationTreeView;
