"use client";
import { useTRPC } from "~/trpc/react";

import { useQueries } from "@tanstack/react-query";
import { SortParams } from "~/schemas/pagination";

export default function EntityCount() {
  const api = useTRPC();
  const sort: SortParams = { orderBy: "name", direction: "asc" };
  const opts = {
    filters: {},
    sort,
    pagination: { pageIndex: 0, pageSize: 0 },
  };

  const [location, product, ingredient, recipe, inventoryItem, usda, image] =
    useQueries({
      queries: [
        api.location.list.queryOptions(opts),
        api.product.list.queryOptions(opts),
        api.ingredient.list.queryOptions(opts),
        api.recipe.list.queryOptions(opts),
        api.inventoryItem.list.queryOptions(opts),
        api.usda.list.queryOptions(opts),
        api.image.list.queryOptions(opts),
      ],
    });
  return (
    <ul>
      <li>location count: {location.data?.meta.totalCount}</li>
      <li>product count: {product.data?.meta.totalCount}</li>
      <li>item count: {ingredient.data?.meta.totalCount}</li>
      <li>recipe count: {recipe.data?.meta.totalCount}</li>
      <li>inventory count: {inventoryItem.data?.meta.totalCount}</li>
      <li>usda food: {usda.data?.meta.totalCount}</li>
      <li>image count: {image.data?.meta.totalCount}</li>
    </ul>
  );
}
