"use client";
import { NodeRendererProps, Tree } from "react-arborist";
import { InfLocation } from "~/schemas/location";
import { api } from "~/trpc/react";

const LocationTreeView = () => {
  const locations = api.location.makeTree.useQuery();
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
