import type { Entity } from "@cubby/schemas/entity";
import { recipeSourceValues } from "@cubby/schemas/recipe";
import { describe, expect, it } from "vitest";
import { getEntityFilters } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  FILTER_NONE,
  isMultiFilterKind,
  partitionFilterSpecs,
} from "./filters";
import { isViewActive, viewManifest, viewsForEntity } from "./view-manifest";

type ViewFilterish = { id: string; value: string | string[] };

// A `.tsx` test, so it runs under the `ui` vitest project: cross-checking a
// view's filter ids against the manifest means importing `filter-manifest.tsx`,
// which the alias-free `unit` project can't load. `view-manifest.ts` itself
// stays alias-free regardless — that's a property of the module, not the test.

describe("view manifest", () => {
  it("only pins filters that exist as specs for the same entity", () => {
    // The whole point of a view being a declaration rather than a code path:
    // applying it must set state the table can actually round-trip through the
    // URL. A typo'd column id would set a filter no column owns — invisible,
    // and unclearable except by Reset.
    for (const [entity, views] of Object.entries(viewManifest)) {
      const specIds = new Set(
        getEntityFilters(entity as never).map((s) => s.columnId),
      );
      for (const view of views ?? []) {
        for (const filter of view.filters) {
          expect(
            specIds.has(filter.id),
            `view "${view.id}" on "${entity}" pins unknown filter "${filter.id}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("never pins a urlOnly spec", () => {
    // The subtler half of the check above: a urlOnly id passes it (the spec
    // does exist) but does nothing at runtime, because applying a view writes
    // `columnFilters` and `partitionFilterSpecs` keeps urlOnly specs out of
    // that state entirely. The view would light up its checkmark and select
    // every row. `financialTransaction/unlinked` is only correct because
    // `purchasePresence` was promoted to column-backed first.
    for (const [entity, views] of Object.entries(viewManifest)) {
      const [, urlOnly] = partitionFilterSpecs(
        getEntityFilters(entity as never),
      );
      const urlOnlyIds = new Set(urlOnly.map((spec) => spec.columnId));
      for (const view of views ?? []) {
        for (const filter of view.filters) {
          expect(
            urlOnlyIds.has(filter.id),
            `view "${view.id}" on "${entity}" pins urlOnly filter "${filter.id}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("uses ids that are unique per entity", () => {
    for (const [entity, views] of Object.entries(viewManifest)) {
      const ids = (views ?? []).map((v) => v.id);
      expect(new Set(ids).size, `duplicate view id on "${entity}"`).toBe(
        ids.length,
      );
    }
  });

  it("returns no views for an entity that declares none", () => {
    expect(viewsForEntity("vendor")).toEqual([]);
    expect(viewsForEntity(undefined)).toEqual([]);
  });
});

describe("expense views produce the filters their old tabs pinned", () => {
  const specs = getEntityFilters("expense");
  const build = (viewId: string) => {
    const view = viewsForEntity("expense").find((v) => v.id === viewId);
    if (!view) throw new Error(`no such view: ${viewId}`);
    const byId = new Map(view.filters.map((f) => [f.id, f.value]));
    return buildFiltersFromManifest(specs, (columnId) => byId.get(columnId));
  };

  it("planned pins future: true", () => {
    expect(build("planned")).toEqual({ future: true });
  });

  it("unclassified pins trade 'other' with no cost recorded", () => {
    expect(build("unclassified")).toEqual({
      trade: ["other"],
      costPresenceFilter: "none",
    });
  });

  it("unassigned pins projectPresenceFilter: none without clobbering projectId", () => {
    // The sentinel ORs with a value selection rather than narrowing it, so
    // picking a project while this view is active *widens* the result
    // ("unassigned or Kitchen") instead of producing the unsatisfiable
    // `projectId IN (…) AND projectId IS NULL` that once silently emptied the
    // table. Nothing here may reintroduce a `projectId: undefined` clobber —
    // that would discard the user's own selection, which is worse.
    const filters = build("unassigned");
    expect(filters).toEqual({ projectPresenceFilter: "none" });
    expect("projectId" in filters).toBe(false);
  });

  it("sends the sentinel through as a sentinel, never as an id", () => {
    const view = viewsForEntity("expense").find((v) => v.id === "unassigned");
    expect(view?.filters).toEqual([{ id: "project", value: [FILTER_NONE] }]);
  });

  it("unattached pins the existing no-purchase vendor predicate", () => {
    expect(build("unattached")).toEqual({ vendorPresenceFilter: "none" });
    const view = viewsForEntity("expense").find((v) => v.id === "unattached");
    expect(view?.filters).toEqual([{ id: "vendor", value: [FILTER_NONE] }]);
  });

  it("unknown-quantities pins the two presence sentinels plus already-made", () => {
    // `productQuantityPresenceFilter: none` is the whole point — a *bound*
    // (`productQuantityMin/Max`) would silently exclude the null rows this view
    // exists to find, since a comparison against NULL is never true.
    expect(build("unknown-quantities")).toEqual({
      productPresenceFilter: "has",
      productQuantityPresenceFilter: "none",
      future: false,
    });
  });

  it("unknown-quantities narrows by product presence rather than line taxonomy", () => {
    // Guards the reasoning in the view's comment: `product: has` is what makes
    // the lineKind/lineBasis/costType trio redundant here. If a non-principal
    // line ever becomes able to carry a product, this view starts selecting
    // rows a quantity can't describe — and this assertion is the note saying so.
    const view = viewsForEntity("expense").find(
      (candidate) => candidate.id === "unknown-quantities",
    );
    const ids = (view?.filters ?? []).map((filter) => filter.id);
    expect(ids).toEqual(["product", "productQuantity", "future"]);
  });

  it("reveals the column it exists to have you edit", () => {
    const view = viewsForEntity("expense").find(
      (candidate) => candidate.id === "unknown-quantities",
    );
    expect(view?.columnVisibility).toEqual({ productQuantity: true });
  });
});

describe("project and task saved views use ordinary server filters", () => {
  const build = (entity: "project" | "task", viewId: string) => {
    const view = viewsForEntity(entity).find(
      (candidate) => candidate.id === viewId,
    );
    if (!view) throw new Error(`no such view: ${entity}/${viewId}`);
    const values = new Map(
      view.filters.map((filter) => [filter.id, filter.value]),
    );
    return buildFiltersFromManifest(getEntityFilters(entity), (columnId) =>
      values.get(columnId),
    );
  };

  it("Completed projects is exactly status done", () => {
    expect(build("project", "completed")).toEqual({ status: ["done"] });
  });

  it("Inbox tasks are open, unassigned, and parentless", () => {
    expect(build("task", "inbox")).toEqual({
      status: ["not_started", "later", "in_progress", "blocked"],
      projectPresenceFilter: "none",
      parentTaskPresenceFilter: "none",
    });
  });

  it("Completed tasks is exactly status done", () => {
    expect(build("task", "completed")).toEqual({ status: ["done"] });
  });
});

describe("settlement worklist views", () => {
  const build = (
    entity: "purchase" | "financialTransaction",
    viewId: string,
  ) => {
    const view = viewsForEntity(entity).find(
      (candidate) => candidate.id === viewId,
    );
    if (!view) throw new Error(`no such view: ${entity}/${viewId}`);
    const values = new Map(
      view.filters.map((filter) => [filter.id, filter.value]),
    );
    return buildFiltersFromManifest(getEntityFilters(entity), (columnId) =>
      values.get(columnId),
    );
  };

  it("unsettled purchases is exactly the settlement_reference gap", () => {
    // NOT `financialTransactionPresenceFilter: none`. The gap is narrower: it
    // wants a POSTED transaction of a settlement kind that carries a sourceRef
    // or sits on a cash account, so a purchase with an expected refund or an
    // evidence-free row still shows up here.
    expect(build("purchase", "unsettled")).toEqual({
      dataGap: ["settlement_reference"],
    });
  });

  it("outstanding transactions are the two pre-posted statuses", () => {
    expect(build("financialTransaction", "outstanding")).toEqual({
      status: ["expected", "pending"],
    });
  });

  it("unlinked transactions pin the purchase presence sentinel", () => {
    expect(build("financialTransaction", "unlinked")).toEqual({
      purchasePresenceFilter: "none",
    });
  });
});

describe("isViewActive", () => {
  const view = {
    id: "v",
    label: "V",
    description: "",
    filters: [{ id: "trade", value: ["other"] }],
    sort: [{ id: "date", desc: false }],
  };

  it("matches identical filter and sort state", () => {
    expect(
      isViewActive(
        view,
        [{ id: "trade", value: ["other"] }],
        [{ id: "date", desc: false }],
      ),
    ).toBe(true);
  });

  it("drops the checkmark when a filter is edited by hand", () => {
    // A view is a starting point, not a mode — keeping it lit while showing
    // different rows would be the dishonest readout.
    expect(
      isViewActive(
        view,
        [{ id: "trade", value: ["labor"] }],
        [{ id: "date", desc: false }],
      ),
    ).toBe(false);
  });

  it("drops the checkmark when an extra filter is added", () => {
    expect(
      isViewActive(
        view,
        [
          { id: "trade", value: ["other"] },
          { id: "future", value: "true" },
        ],
        [{ id: "date", desc: false }],
      ),
    ).toBe(false);
  });

  it("drops the checkmark when the sort is changed", () => {
    expect(
      isViewActive(
        view,
        [{ id: "trade", value: ["other"] }],
        [{ id: "date", desc: true }],
      ),
    ).toBe(false);
  });

  it("ignores sort for a view that doesn't pin one", () => {
    const noSort = { ...view, sort: undefined };
    expect(
      isViewActive(
        noSort,
        [{ id: "trade", value: ["other"] }],
        [{ id: "name", desc: true }],
      ),
    ).toBe(true);
  });
});

/**
 * A view's filter value has to be shaped the way `decodeFilters` shapes the
 * same filter from a URL — array for a multi kind, bare string otherwise.
 *
 * Get it wrong and the view still *applies* (the expanders normalize via
 * `single()`), but `isViewActive` compares by identity, so the checkmark never
 * lights and the view looks broken while working. That asymmetry is exactly
 * why this is asserted rather than eyeballed.
 */
describe("view filter values match the shape decodeFilters produces", () => {
  it.each(
    Object.entries(viewManifest).flatMap(([entity, views]) =>
      (views ?? []).flatMap((view) =>
        view.filters.map(
          (filter) =>
            [entity, view.id, filter] as [string, string, ViewFilterish],
        ),
      ),
    ),
  )("%s / %s — %o", (entity, _viewId, filter) => {
    const spec = getEntityFilters(entity as Entity).find(
      (candidate) => candidate.columnId === filter.id,
    );
    expect(spec, `no filter spec for ${filter.id}`).toBeDefined();
    if (!spec) return;
    expect(Array.isArray(filter.value)).toBe(isMultiFilterKind(spec.kind));
  });
});

/**
 * A view that selects on a column the table hides by default must reveal it —
 * otherwise it lands the operator on a filtered list with nothing on screen
 * explaining why those rows are there.
 */
describe("views reveal the columns they select on", () => {
  it("turns on Expected and Variance for the products worklists", () => {
    const productViews = viewManifest.product ?? [];
    const shelfDisagrees = productViews.find((v) => v.id === "shelf-disagrees");
    expect(shelfDisagrees?.columnVisibility).toEqual({
      expectedQuantity: true,
      quantityVariance: true,
      // A product can be short while sitting in no inventory row at all, so
      // the bins-in-service count has to be on screen to explain the variance.
      servingAsLocations: true,
    });

    // Every product view filters on a column hidden by `initialColumnVisibility`,
    // so each one has to name it.
    for (const view of productViews) {
      for (const filter of view.filters) {
        expect(
          view.columnVisibility?.[filter.id],
          `${view.id} filters on ${filter.id} without revealing it`,
        ).toBe(true);
      }
    }
  });
});

/**
 * `unlocated` and `unlocated-durables` answer the same question at two widths,
 * and the narrow one is only trustworthy as a shortcut if it is a strict
 * narrowing rather than a second, independently-drifting definition. Asserting
 * the superset relation is what keeps them from diverging: edit the broad
 * view's predicate and this fails until the narrow one follows.
 */
describe("the unlocated views stay one question at two widths", () => {
  const productViews = viewManifest.product ?? [];
  const broad = productViews.find((v) => v.id === "unlocated");
  const durables = productViews.find((v) => v.id === "unlocated-durables");

  // `servingAsLocations: none` is the half that keeps this disjoint from
  // `shelf-disagrees`: presence has two forms now, and "nowhere" means neither.
  it("selects on expected-quantity, BOTH kinds of presence, and undecided stock tracking", () => {
    expect(broad?.filters).toEqual([
      { id: "expectedQuantity", value: "positive" },
      { id: "location", value: [FILTER_NONE] },
      { id: "servingAsLocations", value: "none" },
      { id: "stockTracked", value: "none" },
    ]);
  });

  it("cannot overlap shelf-disagrees", () => {
    // One view requires presence somewhere — its variance gate unions stock
    // and locations — and the other requires absence from both. Disjoint by
    // construction, not by the filters happening not to co-occur.
    const disagrees = productViews.find((v) => v.id === "shelf-disagrees");
    expect(disagrees?.filters).toContainEqual({
      id: "quantityVariance",
      value: "mismatched",
    });
    expect(broad?.filters).toContainEqual({
      id: "servingAsLocations",
      value: "none",
    });
    expect(broad?.filters).toContainEqual({
      id: "location",
      value: [FILTER_NONE],
    });
  });

  it("narrows the broad view rather than restating it", () => {
    expect(broad).toBeDefined();
    expect(durables).toBeDefined();
    for (const filter of broad?.filters ?? []) {
      expect(
        durables?.filters,
        `unlocated-durables dropped ${filter.id}`,
      ).toContainEqual(filter);
    }
    expect(durables?.filters.length).toBe((broad?.filters.length ?? 0) + 1);
  });

  it("never reveals Variance, which is `—` for every row it selects", () => {
    // `onHandUnitsSql` returns NULL on a zero-entry shelf, so the variance
    // subtraction is NULL across the whole cohort by construction.
    for (const view of [broad, durables]) {
      expect(view?.columnVisibility?.quantityVariance).toBeUndefined();
    }
  });
});

describe("problem-backed views", () => {
  const backed = Object.entries(viewManifest).flatMap(([entity, views]) =>
    (views ?? [])
      .filter((view) => view.problem)
      .map((view) => ({ entity: entity as Entity, view })),
  );

  it.each(backed)(
    "$entity/$view.id resolves to exactly its declared serverFilters",
    ({ entity, view }) => {
      // THE anti-divergence guard. `serverFilters` is a projection of
      // `filters`, not an independent statement of it — it exists only because
      // the server can't cheaply run this resolver itself (the manifest reaches
      // into `~/app/**` for icon-bearing option lists). Resolving the view the
      // same way the table does and demanding equality is what keeps the two
      // from becoming two different questions, which is the exact failure this
      // whole mechanism exists to prevent.
      const values = new Map(view.filters.map((f) => [f.id, f.value]));
      expect(
        buildFiltersFromManifest(getEntityFilters(entity), (columnId) =>
          values.get(columnId),
        ),
      ).toEqual(view.problem?.serverFilters);
    },
  );

  it("never pins a filter the repo layer would receive unresolved", () => {
    // The tRPC routers resolve public shortcodes into uuids in their `list`
    // callback BEFORE the repo sees them (`resolveLocationId` in
    // routers/inventory.ts is the canonical example). The Problems service
    // calls the repo list functions directly, on one pinned connection, so it
    // skips that step — which is fine only while no view declares an id filter.
    //
    // A view that pinned `locationIdFilter` would hand a `LOC-` code to code
    // expecting a uuid: it would match nothing and the section would silently
    // read zero. Fail here instead, loudly, at the moment someone declares one.
    for (const { entity, view } of backed) {
      for (const field of Object.keys(view.problem?.serverFilters ?? {})) {
        expect(
          /Id$|IdFilter$/.test(field),
          `view "${entity}/${view.id}" pins "${field}", which the repo expects already resolved — teach the service to resolve it first`,
        ).toBe(false);
      }
    }
  });
});

describe("recipe/no-instructions names the source complement", () => {
  it("excludes exactly Book and Notion, by naming everything else", () => {
    // A filter can include, never exclude, so the detector's
    // `SourceType IS DISTINCT FROM 'Book' AND IS DISTINCT FROM 'Notion'` is
    // spelled as a positive list plus the `(none)` sentinel for the nullable
    // column. That is equivalent TODAY and silently stops being equivalent the
    // moment a fifth source is added — the new one would be excluded from the
    // worklist without anything failing. This is the thing that fails.
    const view = viewsForEntity("recipe").find(
      (candidate) => candidate.id === "no-instructions",
    );
    const named = view?.filters.find((f) => f.id === "sourceType")?.value;
    expect(Array.isArray(named)).toBe(true);
    const values = (named as string[]).filter((v) => v !== FILTER_NONE);
    expect(new Set(values)).toEqual(
      new Set(recipeSourceValues.filter((v) => v !== "Book" && v !== "Notion")),
    );
  });
});
