"use client";
import { NodeRendererProps, Tree } from "react-arborist";
import { InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";

import { useQuery } from "@tanstack/react-query";

const LocationTreeView = () => {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());
  const data = locations.data;

  return (
    <Tree initialData={data} disableDrag>
      {Node}
    </Tree>
  );
};

function Node({ node, style, dragHandle }: NodeRendererProps<InfLocation>) {
  /* This node instance can do many things. See the API reference. */
  return (
    <div style={style} ref={dragHandle}>
      {node.isLeaf ? "🗃️" : "📦"}
      {node.data.name}
    </div>
  );
}

export default LocationTreeView;
