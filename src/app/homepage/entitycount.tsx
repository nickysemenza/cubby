"use client";

import { api } from "~/trpc/react";

export default function EntityCount() {
  const location = api.location.list.useQuery({});
  const product = api.product.list.useQuery({});
  const ingredient = api.ingredient.list.useQuery({});
  const recipe = api.recipe.list.useQuery({});
  const inventoryItem = api.inventoryItem.list.useQuery({});
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
