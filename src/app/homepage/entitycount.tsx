"use client";
import { useTRPC } from "~/trpc/react";

import { useQuery } from "@tanstack/react-query";

export default function EntityCount() {
  const api = useTRPC();
  const location = useQuery(api.location.list.queryOptions({}));
  const product = useQuery(api.product.list.queryOptions({}));
  const ingredient = useQuery(api.ingredient.list.queryOptions({}));
  const recipe = useQuery(api.recipe.list.queryOptions({}));
  const inventoryItem = useQuery(api.inventoryItem.list.queryOptions({}));
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
