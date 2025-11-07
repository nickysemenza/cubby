"use client";
import { useTRPC } from "~/trpc/react";

import { useQueries } from "@tanstack/react-query";
import { SortParams } from "~/schemas/pagination";
import { authClient } from "~/lib/auth-client";

export default function EntityCount() {
  const api = useTRPC();
  const { data: activeOrg } = authClient.useActiveOrganization();

  const sort: SortParams = { orderBy: "name", direction: "asc" };
  const opts = {
    filters: {},
    sort,
    pagination: { pageIndex: 0, pageSize: 1 },
  };

  const [location, product, ingredient, recipe, inventoryItem, usda, image] =
    useQueries({
      queries: [
        { ...api.location.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.product.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.ingredient.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.recipe.list.queryOptions(opts), enabled: !!activeOrg },
        {
          ...api.inventoryItem.list.queryOptions(opts),
          enabled: !!activeOrg,
        },
        { ...api.usda.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.image.list.queryOptions(opts), enabled: !!activeOrg },
      ],
    });

  // Only render counts if there's an active organization
  if (!activeOrg) {
    return (
      <p className="text-muted-foreground text-sm">
        Select an organization to view entity counts
      </p>
    );
  }

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
