import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appRoot = resolve(process.cwd(), "src/app");

// These lists bypass EntityListPage and therefore must explicitly pass the
// shared inspection callback into useEntityList. Keep this as a small source
// contract: rendering every async roster just to prove one prop is expensive,
// while a missing prop silently removes Inspect from its selection bar.
const explicitLists = [
  "cookbooks/cookbooklist.tsx",
  "expenses/expenselist.tsx",
  "ingredients/ingredientlist.tsx",
  "inventory/inventoryitemlist.tsx",
  "meals/meal-table.tsx",
  "products/productlist.tsx",
  "projects/projects-dashboard.tsx",
  "projects/shared.tsx",
  "purchases/purchaselist.tsx",
  "usda/usdafoodlist.tsx",
  "wishes/wish-list.tsx",
] as const;

describe("canonical explicit list inspection wiring", () => {
  it.each(explicitLists)("passes inspectRow in %s", (relativePath) => {
    const source = readFileSync(resolve(appRoot, relativePath), "utf8");
    expect(source).toMatch(/onInspectRow:\s*inspectRow/);
  });

  it("keeps Product candidate rows out of Wish selection and inspection", () => {
    const source = readFileSync(
      resolve(appRoot, "wishes/wish-list.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /rowIsEntity:\s*\(row: WishRow\) => row\.kind === "wish"/,
    );
  });
});
