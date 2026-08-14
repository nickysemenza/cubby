import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `headerInToolbar` deletes the page's header block and hands its title to the
 * body's table toolbar. That is only safe on a route whose body ALWAYS renders
 * a page-level table.
 *
 * A route with a view switcher (Shelf, Gallery, Analytics, Board, …) renders no
 * table in its other modes, so the toolbar that would carry the title does not
 * exist and the page silently loses both its name and its only `<h1>` — with
 * nothing on screen to reveal it. `/expenses` shipped exactly that way for a
 * few minutes: its ledger/analytics switcher is declared in the ROUTE file, so
 * a scan of the list components alone missed it.
 *
 * Hence: no route may hold both. The check reads the route source rather than
 * rendering, because the failure is a composition mistake, not a runtime one.
 */
const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

/** Names a mode toggle that can render a non-table view. */
const SWITCHER_PATTERN =
  /\bViewSwitcher\b|\bViewSwitcherOption\b|\bviewOptions\b|\bonViewChange\b|\brouteView\b|\bShelfTableToggle\b/;

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter(
    (name) => name.endsWith(".tsx") && !name.includes(".test."),
  );
}

describe("headerInToolbar", () => {
  it("is never used on a route that can render a non-table view", () => {
    const offenders = routeFiles().filter((name) => {
      const source = readFileSync(join(ROUTES_DIR, name), "utf8");
      return (
        source.includes("headerInToolbar") && SWITCHER_PATTERN.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });

  it("is only used alongside variant=list", () => {
    const offenders = routeFiles().filter((name) => {
      const source = readFileSync(join(ROUTES_DIR, name), "utf8");
      if (!source.includes("headerInToolbar")) return false;
      return !source.includes('variant="list"');
    });

    expect(offenders).toEqual([]);
  });
});
