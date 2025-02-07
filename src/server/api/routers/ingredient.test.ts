import { it } from "vitest";
import { db } from "~/server/db";
import { findOrCreateIngredient } from "./ingredients";

// todo: point at test DB in CI
it.skip("ingredient upser with aliases", async () => {
  const a = await findOrCreateIngredient(db, "alias_1");
  console.log({ a });
  const b = await findOrCreateIngredient(db, "test", ["alias_1"]);
  console.log({ b });
});
