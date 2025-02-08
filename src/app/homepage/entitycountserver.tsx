"use server";

import { db } from "~/server/db";

export default async function EntityCount2() {
  return (
    <ul>
      <li>location count: {db.location.count()}</li>
      <li>product count: {db.product.count()}</li>
      <li>item count: {db.ingredient.count()}</li>
      <li>recipe count: {db.recipe.count()}</li>
    </ul>
  );
}
