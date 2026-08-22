import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter(
    (name) => name.endsWith(".tsx") && !name.includes(".test."),
  );
}

describe("list workbench chrome", () => {
  it("fully removes the header-in-toolbar contract", () => {
    const offenders = routeFiles().filter((name) =>
      readFileSync(join(ROUTES_DIR, name), "utf8").includes("headerInToolbar"),
    );
    expect(offenders).toEqual([]);
  });

  it("uses workbench chrome only on list pages", () => {
    const offenders = routeFiles().filter((name) => {
      const source = readFileSync(join(ROUTES_DIR, name), "utf8");
      return (
        source.includes('listChrome="workbench"') &&
        !source.includes('variant="list"')
      );
    });
    expect(offenders).toEqual([]);
  });

  it("migrates every shared entity list and alternate operating surface", () => {
    const expected = [
      "activity.tsx",
      "calendar.tsx",
      "cookbooks.index.tsx",
      "expenses.index.tsx",
      "financial-accounts.index.tsx",
      "financial-transactions.index.tsx",
      "images.index.tsx",
      "ingredients.index.tsx",
      "inventory.index.tsx",
      "locations.index.tsx",
      "meals.index.tsx",
      "products.index.tsx",
      "projects.index.tsx",
      "projects.tools.tsx",
      "purchases.index.tsx",
      "recipes.index.tsx",
      "statement-rows.index.tsx",
      "tasks.index.tsx",
      "usda.index.tsx",
      "vendors.index.tsx",
      "wishes.index.tsx",
    ];

    const missing = expected.filter(
      (name) =>
        !readFileSync(join(ROUTES_DIR, name), "utf8").includes(
          'listChrome="workbench"',
        ),
    );
    expect(missing).toEqual([]);
  });
});
