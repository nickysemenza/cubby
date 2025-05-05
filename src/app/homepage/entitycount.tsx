"use client";
import { useTRPC } from "~/trpc/react";

import { useQuery } from "@tanstack/react-query";
import { SortParams } from "~/schemas/util";

export default function EntityCount() {
  const api = useTRPC();
  const sort: SortParams = { orderBy: "name", direction: "asc" };
  const opts = {
    filters: {},
    sort,
    pagination: { pageIndex: 0, pageSize: 100 },
  };
  const location = useQuery(api.location.list.queryOptions(opts));
  const product = useQuery(api.product.list.queryOptions(opts));
  const ingredient = useQuery(api.ingredient.list.queryOptions(opts));
  const recipe = useQuery(api.recipe.list.queryOptions(opts));
  const inventoryItem = useQuery(api.inventoryItem.list.queryOptions(opts));
  return (
    <ul>
      <li>location count: {location.data?.meta.totalCount}</li>
      <li>product count: {product.data?.meta.totalCount}</li>
      <li>item count: {ingredient.data?.meta.totalCount}</li>
      <li>recipe count: {recipe.data?.meta.totalCount}</li>
      <li>inventory count: {inventoryItem.data?.meta.totalCount}</li>
    </ul>
  );
}
