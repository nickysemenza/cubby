"use client";

import { api } from "~/trpc/react";

export default function EntityCount() {
  // const productData = ;
  return (
    <ul>
      <li>
        location count:{" "}
        {api.location.list.useSuspenseQuery({})[0].meta.totalCount}
      </li>
      <li>
        product count:{" "}
        {api.product.list.useSuspenseQuery({})[0].meta.totalCount}
      </li>
      <li>
        item count: {api.item.list.useSuspenseQuery({})[0].meta.totalCount}
      </li>
      <li>
        recipe count: {api.recipe.list.useSuspenseQuery({})[0].meta.totalCount}
      </li>
    </ul>
  );
}
