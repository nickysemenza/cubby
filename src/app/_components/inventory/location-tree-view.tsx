"use client";
import { NodeRendererProps, Tree } from "react-arborist";
import { InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { LocationIcon } from "../locations/location-icons";

import { useQuery } from "@tanstack/react-query";

const LocationTreeView = () => {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());
  const data = locations.data;

  return (
    data && (
      <Tree initialData={data} disableDrag>
        {Node}
      </Tree>
    )
  );
};

function Node({ node, style, dragHandle }: NodeRendererProps<InfLocation>) {
  /* This node instance can do many things. See the API reference. */
  return (
    <div style={style} ref={dragHandle} className="flex items-center gap-2">
      <LocationIcon type={node.data.type} size={14} />
      <span>{node.data.name}</span>
    </div>
  );
}

export default LocationTreeView;
