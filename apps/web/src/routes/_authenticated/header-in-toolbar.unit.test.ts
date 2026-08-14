import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `headerInToolbar` deletes the page's header block and hands its title to the
 * body's table toolbar. The invariant it depends on is strict:
 *
 *   the route's body renders a page-level table in EVERY state and at EVERY
 *   viewport.
 *
 * Break it and the page silently loses its name and its only `<h1>`, with
 * nothing on screen to reveal it. Two routes have already broken it in
 * different ways, which is why the check below is an allowlist rather than a
 * pattern match:
 *
 * - a view switcher (`expenses`, `products`, `locations`, …) renders a chart or
 *   gallery instead of a table in its other modes;
 * - `search` renders its table only once a query exists, and never on mobile —
 *   no switcher, no keyword, nothing a regex would catch.
 *
 * So adding the flag requires adding the route here, which is the point: the
 * question "does this body ALWAYS render a table?" has to be answered by a
 * person, once, in review.
 */
const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Routes whose body always renders a page-level table. Verified by reading the
 * list component: no view switcher, no query-gated or viewport-gated render.
 */
const ALWAYS_RENDERS_A_TABLE = new Set([
  "financial-accounts.index.tsx",
  "financial-transactions.index.tsx",
  "images.index.tsx",
  "ingredients.index.tsx",
  "purchases.index.tsx",
  "recipes.index.tsx",
  "statement-rows.index.tsx",
  "usda.index.tsx",
  "vendors.index.tsx",
  "wishes.index.tsx",
]);

/** Names a mode toggle that can render a non-table view. */
const SWITCHER_PATTERN =
  /\bViewSwitcher\b|\bViewSwitcherOption\b|\bviewOptions\b|\bonViewChange\b|\brouteView\b|\bShelfTableToggle\b/;

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter(
    (name) => name.endsWith(".tsx") && !name.includes(".test."),
  );
}

function routesWithFlag(): string[] {
  return routeFiles().filter((name) =>
    readFileSync(join(ROUTES_DIR, name), "utf8").includes("headerInToolbar"),
  );
}

describe("headerInToolbar", () => {
  it("is only used on routes reviewed as always rendering a table", () => {
    const unreviewed = routesWithFlag().filter(
      (name) => !ALWAYS_RENDERS_A_TABLE.has(name),
    );

    expect(unreviewed).toEqual([]);
  });

  it("keeps the reviewed list honest", () => {
    const withFlag = new Set(routesWithFlag());
    const stale = [...ALWAYS_RENDERS_A_TABLE].filter(
      (name) => !withFlag.has(name),
    );

    expect(stale).toEqual([]);
  });

  it("is never used on a route that can render a non-table view", () => {
    const offenders = routesWithFlag().filter((name) =>
      SWITCHER_PATTERN.test(readFileSync(join(ROUTES_DIR, name), "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("is only used alongside variant=list", () => {
    const offenders = routesWithFlag().filter(
      (name) =>
        !readFileSync(join(ROUTES_DIR, name), "utf8").includes(
          'variant="list"',
        ),
    );

    expect(offenders).toEqual([]);
  });
});
