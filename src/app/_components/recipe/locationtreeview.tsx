"use client";
import { Tree } from "react-arborist";
import { api } from "~/trpc/react";

const LocationTreeView = () => {
  const locations = api.location.makeTree.useQuery();
  const data = locations.data;

  return <Tree initialData={data} />;
};

export default LocationTreeView;
